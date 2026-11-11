-- =============================================================================
-- 0800 — Global search and CSV lead import.
--
-- Both RPCs are SECURITY INVOKER: they run as the calling user, so RLS
-- decides which rows exist and every insert goes through the normal guards
-- (lead guard, find_or_create_contact checks, audit, history). They add no
-- privileges of their own.
-- =============================================================================

-- Trigram indexes make substring search (ILIKE '%…%') usable at volume.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index if not exists contacts_full_name_trgm_idx on public.contacts using gin (full_name extensions.gin_trgm_ops);
create index if not exists contacts_email_trgm_idx on public.contacts using gin (email extensions.gin_trgm_ops);
create index if not exists contacts_phone_trgm_idx on public.contacts using gin (phone_e164 extensions.gin_trgm_ops);
create index if not exists leads_title_trgm_idx on public.leads using gin (title extensions.gin_trgm_ops);
create index if not exists deals_title_trgm_idx on public.deals using gin (title extensions.gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Global search across contacts, leads and deals.
-- * Matches name / title / e-mail by substring; phone numbers by digits
--   (Arabic-Indic digits accepted), so "5555 0001" finds +97455550001.
-- * LIKE wildcards in the query are escaped: "%" searches for a literal "%".
-- * p_company_ids narrows to companies (null = everything visible).
-- * Merged contacts and archived leads/deals are excluded.
-- -----------------------------------------------------------------------------
create or replace function public.global_search(
  p_query text, p_company_ids uuid[] default null, p_limit int default 10
) returns table (
  entity_type text, entity_id uuid, company_id uuid, title text, subtitle text, status text, updated_at timestamptz
)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_q text := left(btrim(coalesce(p_query, '')), 100);
  v_pattern text;
  v_digits text;
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if auth.uid() is null then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if char_length(v_q) < 2 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(translate(v_q, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g');
  if char_length(v_digits) < 4 then
    v_digits := null;
  end if;

  return query
  (select 'contact'::text, c.id, null::uuid, c.full_name, coalesce(c.phone_e164, c.email), null::text, c.updated_at
   from public.contacts c
   where c.merged_into_id is null
     and (c.full_name ilike v_pattern or c.email ilike v_pattern
          or (v_digits is not null and c.phone_e164 like '%' || v_digits || '%'))
     and (p_company_ids is null or exists (
       select 1 from public.contact_companies cc where cc.contact_id = c.id and cc.company_id = any (p_company_ids)))
   order by c.updated_at desc
   limit v_limit)
  union all
  (select 'lead'::text, l.id, l.company_id, l.title, ct.full_name, l.status::text, l.updated_at
   from public.leads l
   join public.contacts ct on ct.id = l.contact_id
   where l.archived_at is null
     and (p_company_ids is null or l.company_id = any (p_company_ids))
     and (l.title ilike v_pattern or ct.full_name ilike v_pattern
          or (v_digits is not null and ct.phone_e164 like '%' || v_digits || '%'))
   order by l.updated_at desc
   limit v_limit)
  union all
  (select 'deal'::text, d.id, d.company_id, d.title, ct.full_name, d.status::text, d.updated_at
   from public.deals d
   join public.contacts ct on ct.id = d.contact_id
   where d.archived_at is null
     and (p_company_ids is null or d.company_id = any (p_company_ids))
     and (d.title ilike v_pattern or ct.full_name ilike v_pattern
          or (v_digits is not null and ct.phone_e164 like '%' || v_digits || '%'))
   order by d.updated_at desc
   limit v_limit);
end $$;

-- -----------------------------------------------------------------------------
-- CSV lead import (rows already parsed and validated by the server).
-- Each row runs in its own subtransaction: a row that breaks a rule is
-- reported with its error key and the others still import. At most 1000
-- rows per call (the server sends chunks).
--
-- Row keys: full_name (required), phone (E.164), email, title, source,
-- campaign, priority, estimated_value, notes, owner_id.
-- -----------------------------------------------------------------------------
create or replace function public.import_leads(p_company_id uuid, p_rows jsonb)
returns table (row_index int, lead_id uuid, contact_id uuid, matched_existing boolean, error_key text)
language plpgsql security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  r jsonb;
  i int := 0;
  v_contact uuid;
  v_matched boolean;
  v_lead uuid;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'import.invalid_batch' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select f.contact_id, f.matched_existing into v_contact, v_matched
      from public.find_or_create_contact(p_company_id, r ->> 'full_name',
             nullif(btrim(r ->> 'phone'), ''), nullif(btrim(r ->> 'email'), '')) f;

      insert into public.leads (company_id, contact_id, title, source, campaign, priority,
                                estimated_value, notes, owner_id, created_by)
      values (p_company_id, v_contact,
              coalesce(nullif(btrim(r ->> 'title'), ''), btrim(r ->> 'full_name')),
              coalesce(nullif(r ->> 'source', '')::public.lead_source, 'import'),
              nullif(btrim(r ->> 'campaign'), ''),
              coalesce(nullif(r ->> 'priority', '')::public.priority_level, 'medium'),
              nullif(r ->> 'estimated_value', '')::numeric,
              nullif(btrim(r ->> 'notes'), ''),
              nullif(r ->> 'owner_id', '')::uuid,
              auth.uid())
      returning id into v_lead;

      row_index := i; lead_id := v_lead; contact_id := v_contact; matched_existing := v_matched; error_key := null;
      return next;
    exception when others then
      row_index := i; lead_id := null; contact_id := null; matched_existing := null;
      -- Only stable rule keys are returned; anything else may contain data.
      error_key := case when sqlerrm ~ '^[a-z_]+(\.[a-z_]+){1,3}$' then sqlerrm
                        when sqlstate = '22P02' then 'import.invalid_value'
                        when sqlstate like '23%' then 'import.invalid_value'
                        else 'import.row_failed' end;
      return next;
    end;
  end loop;
end $$;

revoke execute on function public.global_search(text, uuid[], int), public.import_leads(uuid, jsonb) from public, anon;
grant execute on function public.global_search(text, uuid[], int), public.import_leads(uuid, jsonb) to authenticated;
