-- Automatic WhatsApp → Lead pipeline.
--
-- Every first inbound message of a customer on a connected number now creates
-- ONE lead, linked to the conversation and contact, inside the existing atomic
-- ingestion transaction. Rules (see docs/WHATSAPP_AUTO_LEADS.md):
--   * at most one AUTOMATIC lead per conversation (unique index backstop);
--   * a conversation that already has any linked lead never gets another one;
--   * an open lead for the same company + customer (e.g. from another number
--     of the company, or a manual one) is reused instead of creating a second;
--   * simulated (demo) numbers never create leads; nothing is backfilled.
-- Additive and reversible: supabase/rollbacks/20261021000950_auto_leads.rollback.sql.
-- The only existing objects touched are CREATE OR REPLACE of three functions
-- (same signatures and grants) and relaxing leads.created_by to nullable for
-- automatic leads (enforced by a check constraint and the guard).

-- ------------------------------------------------------------------ enums
create type public.lead_interest as enum ('unassessed', 'interested', 'not_interested', 'follow_up_required');
create type public.offering_kind as enum ('course', 'workshop', 'service');

-- ------------------------------------------------- offerings (per company)
create table public.company_offerings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind public.offering_kind not null default 'course',
  keywords text[] not null default '{}' check (cardinality(keywords) <= 20),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);
create unique index company_offerings_name_uidx on public.company_offerings (company_id, lower(btrim(name)));
create index company_offerings_company_idx on public.company_offerings (company_id) where is_active;

-- Text normalisation shared by keyword storage and matching: lower case, no
-- Arabic diacritics/tatweel, alef and ya variants folded.
create or replace function app.normalize_match_text(p_text text) returns text
language sql immutable set search_path = '' as $$
  select translate(
    regexp_replace(lower(coalesce(p_text, '')), '[\u064B-\u065F\u0670\u0640]', '', 'g'),
    'أإآٱى', 'ااااي')
$$;

create or replace function app.guard_offering() returns trigger
language plpgsql set search_path = '' as $$
declare v_kw text[];
begin
  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'offering.immutable_field' using errcode = '42501';
  end if;
  new.name := btrim(new.name);
  select coalesce(array_agg(distinct k order by k), array[]::text[]) into v_kw
  from (select btrim(app.normalize_match_text(x)) as k from unnest(coalesce(new.keywords, array[]::text[])) x) s
  where length(k) >= 2;
  if exists (select 1 from unnest(v_kw) k where length(k) > 60) then
    raise exception 'offering.keyword_too_long' using errcode = '22023';
  end if;
  if cardinality(v_kw) > 20 then
    raise exception 'offering.too_many_keywords' using errcode = '22023';
  end if;
  new.keywords := v_kw;
  return new;
end $$;
create trigger company_offerings_guard before insert or update on public.company_offerings
  for each row execute function app.guard_offering();
create trigger set_updated_at before update on public.company_offerings
  for each row execute function app.set_updated_at();

alter table public.company_offerings enable row level security;
revoke all on public.company_offerings from anon;
revoke delete on public.company_offerings from authenticated;   -- deactivate, never delete
create policy offerings_select on public.company_offerings for select to authenticated
  using (app.has_company_access(company_id));
create policy offerings_insert on public.company_offerings for insert to authenticated
  with check (app.is_company_admin(company_id));
create policy offerings_update on public.company_offerings for update to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));

-- ----------------------------------------------------------------- leads
alter table public.leads
  add column conversation_id uuid,
  add column auto_created boolean not null default false,
  add column interest public.lead_interest not null default 'unassessed',
  add column offering_id uuid,
  add column offering_source text check (offering_source in ('auto_keyword', 'employee'));

-- Same-company links enforced by the database (conversations/offerings already
-- expose unique (id, company_id)). A conversation can be unlinked but never
-- deleted from under a lead.
alter table public.leads
  add constraint leads_conversation_fk foreign key (conversation_id, company_id)
    references public.conversations (id, company_id) on delete set null (conversation_id),
  add constraint leads_offering_fk foreign key (offering_id, company_id)
    references public.company_offerings (id, company_id),
  add constraint leads_offering_source_chk check ((offering_id is null) = (offering_source is null)),
  add constraint leads_auto_creator_chk check (created_by is not null or auto_created),
  add constraint leads_auto_needs_conversation_chk check (not auto_created or source = 'whatsapp');

-- created_by stays required for every manual lead (check above + guard).
alter table public.leads alter column created_by drop not null;

create unique index leads_one_auto_per_conversation on public.leads (conversation_id)
  where auto_created and conversation_id is not null;
create index leads_conversation_idx on public.leads (conversation_id) where conversation_id is not null;
create index leads_company_interest_idx on public.leads (company_id, interest) where archived_at is null;
create index leads_offering_idx on public.leads (offering_id) where offering_id is not null;

-- ------------------------------------------------------- helper functions
create or replace function app.offering_is_active(p_offering_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select o.is_active from public.company_offerings o where o.id = p_offering_id), false)
$$;

-- Is there an open lead for this conversation's company and customer, whoever may see it?
-- (Used to stop a manual "create lead" from duplicating a lead the caller cannot see.)
create or replace function app.conversation_has_open_lead(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversations c
                 join public.leads l on l.company_id = c.company_id and l.contact_id = c.contact_id
                 where c.id = p_conversation_id and l.archived_at is null and l.status in ('new', 'contacted', 'qualified'))
$$;

create or replace function app.conversation_matches(p_conversation_id uuid, p_company_id uuid, p_contact_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversations c
                 where c.id = p_conversation_id and c.company_id = p_company_id and c.contact_id = p_contact_id)
$$;

-- The only active offering of the company whose keyword appears in the text;
-- NULL when none or more than one match. Latin keywords match whole words,
-- Arabic keywords match inside words (Arabic prefixes attach to words).
create or replace function app.match_offering(p_company_id uuid, p_text text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_text text := app.normalize_match_text(p_text);
  v_ids uuid[];
begin
  if v_text = '' then return null; end if;
  select array_agg(o.id) into v_ids
  from public.company_offerings o
  where o.company_id = p_company_id and o.is_active
    and exists (
      select 1 from unnest(o.keywords) k
      where k <> '' and v_text ~ ('(^|[^a-z0-9])' || regexp_replace(k, '([\\^$.|?*+()\[\]{}-])', '\\\1', 'g') || '($|[^a-z0-9])'));
  return case when cardinality(v_ids) = 1 then v_ids[1] end;
end $$;

-- Create or reuse the lead for an inbound message. Runs inside the ingestion
-- transaction. Serialised per (company, customer) so two numbers of one
-- company, retries and parallel deliveries cannot create two open leads.
create or replace function app.ensure_whatsapp_lead(p_conversation_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.conversations;
  v_lead public.leads;
  v_name text;
  v_owner uuid;
  v_offering uuid;
  v_id uuid;
begin
  select * into c from public.conversations where id = p_conversation_id;
  if not found or c.is_simulated then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('wa-lead:' || c.company_id || ':' || c.contact_id, 0));

  -- A conversation that already has a lead (automatic or manual, open or closed) never gets another one.
  if exists (select 1 from public.leads l where l.conversation_id = c.id) then return null; end if;

  -- Reuse an open lead of the same company and customer; link it when it has no conversation yet.
  select * into v_lead from public.leads l
  where l.company_id = c.company_id and l.contact_id = c.contact_id and l.archived_at is null
    and l.status in ('new', 'contacted', 'qualified')
  order by l.created_at desc limit 1;
  if found then
    if v_lead.conversation_id is null then
      perform app.begin_system_op();
      update public.leads set conversation_id = c.id where id = v_lead.id;
      perform app.end_system_op();
    end if;
    return v_lead.id;
  end if;

  select coalesce(nullif(btrim(left(k.full_name, 200)), ''), k.phone_e164, 'WhatsApp') into v_name
  from public.contacts k where k.id = c.contact_id;
  v_owner := case when c.owner_id is not null and app.is_company_member(c.company_id, c.owner_id) then c.owner_id end;
  v_offering := app.match_offering(c.company_id, p_body);

  insert into public.leads (company_id, contact_id, title, source, owner_id, created_by, conversation_id, auto_created,
                            interest, offering_id, offering_source)
  values (c.company_id, c.contact_id, v_name, 'whatsapp', v_owner, null, c.id, true,
          'unassessed', v_offering, case when v_offering is not null then 'auto_keyword' end)
  on conflict do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke all on function app.ensure_whatsapp_lead(uuid, text), app.match_offering(uuid, text), app.offering_is_active(uuid),
  app.conversation_matches(uuid, uuid, uuid), app.normalize_match_text(text) from public, anon, authenticated;
-- offering_is_active / conversation_matches are called by the lead guard in the caller's role;
-- normalize_match_text is pure and used by the offering guard trigger.
grant execute on function app.offering_is_active(uuid), app.conversation_matches(uuid, uuid, uuid),
  app.normalize_match_text(text) to authenticated, service_role;
revoke all on function app.conversation_has_open_lead(uuid) from public, anon;
grant execute on function app.conversation_has_open_lead(uuid) to authenticated;

-- ------------------------------------------------- ownership follows the chat
-- An automatic lead follows its conversation's owner, but only while the lead
-- still has the owner the conversation had: an explicit lead assignment or
-- un-assignment is never overwritten.
create or replace function app.sync_auto_lead_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is not distinct from old.owner_id then return null; end if;
  perform app.begin_system_op();
  update public.leads l set owner_id = new.owner_id
  where l.conversation_id = new.id and l.auto_created and l.company_id = new.company_id
    and l.archived_at is null and l.status in ('new', 'contacted', 'qualified')
    and l.owner_id is not distinct from old.owner_id
    and (new.owner_id is null or app.is_company_member(l.company_id, new.owner_id));
  perform app.end_system_op();
  return null;
end $$;
create trigger conversations_sync_lead_owner after update of owner_id on public.conversations
  for each row execute function app.sync_auto_lead_owner();

-- A conversation moved to another company leaves its leads behind (they belong to the old company).
create or replace function app.unlink_leads_on_conversation_move() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.company_id is distinct from old.company_id then
    perform app.begin_system_op();
    update public.leads set conversation_id = null where conversation_id = old.id;
    perform app.end_system_op();
  end if;
  return new;
end $$;
create trigger conversations_unlink_leads before update of company_id on public.conversations
  for each row execute function app.unlink_leads_on_conversation_move();

-- ----------------------------------------------------- guard + audit + ingest
CREATE OR REPLACE FUNCTION app.guard_lead()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_service boolean := app.is_service_context() or app.in_system_op();
begin
  if tg_op = 'INSERT' then
    if not v_service then
      new.created_by := auth.uid();
      new.auto_created := false;            -- only the intake pipeline creates automatic leads
      new.offering_source := case when new.offering_id is null then null else 'employee' end;
      new.archived_at := null;
      if new.conversation_id is not null and not app.can_access_conversation(new.conversation_id) then
        raise exception 'lead.conversation_not_accessible' using errcode = '42501';
      end if;
      if new.offering_id is not null and not app.offering_is_active(new.offering_id) then
        raise exception 'lead.offering_inactive' using errcode = '23514';
      end if;
      new.archived_by := null;
      if not app.can_see_contact(new.contact_id) then
        raise exception 'lead.contact_not_accessible' using errcode = '42501';
      end if;
      if new.owner_id is not null and not app.can_reassign(new.company_id, null, new.owner_id) then
        raise exception 'lead.owner_change_forbidden' using errcode = '42501';
      end if;
      if new.team_id is not null and not app.manages_team(new.company_id, new.team_id) and not exists (
        select 1 from public.team_memberships tm where tm.team_id = new.team_id and tm.user_id = auth.uid()) then
        raise exception 'lead.team_not_allowed' using errcode = '42501';
      end if;
      new.first_contacted_at := null;
    end if;
    if new.created_by is null and not new.auto_created then
      raise exception 'lead.created_by_required' using errcode = '23514';
    end if;
    if new.conversation_id is not null and not app.conversation_matches(new.conversation_id, new.company_id, new.contact_id) then
      raise exception 'lead.conversation_mismatch' using errcode = '23514';
    end if;
    if new.status = 'converted' then
      raise exception 'lead.convert_via_rpc_only' using errcode = '23514';
    end if;
    if new.status not in ('new', 'lost') and new.first_contacted_at is null then
      new.first_contacted_at := now();
    end if;
  else
    if (new.company_id, new.created_by, new.created_at, new.auto_created)
       is distinct from (old.company_id, old.created_by, old.created_at, old.auto_created) then
      raise exception 'lead.immutable_field' using errcode = '42501';
    end if;
    -- The conversation link is system-maintained (intake, company moves); anyone may only detach it.
    if new.conversation_id is distinct from old.conversation_id and not v_service and new.conversation_id is not null then
      raise exception 'lead.immutable_field' using errcode = '42501';
    end if;
    if new.contact_id is distinct from old.contact_id
       and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' and not v_service then
      raise exception 'lead.immutable_field' using errcode = '42501';
    end if;
    if not v_service then
      if new.owner_id is distinct from old.owner_id
         and not app.can_reassign(new.company_id, old.owner_id, new.owner_id) then
        raise exception 'lead.owner_change_forbidden' using errcode = '42501';
      end if;
      if new.team_id is distinct from old.team_id
         and not app.is_company_admin(new.company_id)
         and not (app.manages_team(new.company_id, new.team_id) or new.team_id is null)
         then
        raise exception 'lead.team_not_allowed' using errcode = '42501';
      end if;
      if new.first_contacted_at is distinct from old.first_contacted_at then
        new.first_contacted_at := old.first_contacted_at;   -- system-maintained
      end if;
      -- Who chose the offering is recorded by the database, never taken from input.
      if new.offering_id is distinct from old.offering_id then
        if new.offering_id is not null and not app.offering_is_active(new.offering_id) then
          raise exception 'lead.offering_inactive' using errcode = '23514';
        end if;
        new.offering_source := case when new.offering_id is null then null else 'employee' end;
      else
        new.offering_source := old.offering_source;
      end if;
      if old.archived_at is null and new.archived_at is not null then
        new.archived_at := now();
        new.archived_by := auth.uid();
      elsif old.archived_at is not null and new.archived_at is null then
        if not app.is_company_manager(new.company_id) then
          raise exception 'lead.unarchive_forbidden' using errcode = '42501';
        end if;
        new.archived_by := null;
      elsif new.archived_by is distinct from old.archived_by then
        new.archived_by := old.archived_by;
      end if;
      if old.status = 'converted' and new.status <> 'converted' and not app.is_company_admin(new.company_id) then
        raise exception 'lead.converted_is_final' using errcode = '23514';
      end if;
    end if;
    if new.status = 'converted' and old.status <> 'converted' and not exists (
      select 1 from public.deals d where d.lead_id = new.id) then
      raise exception 'lead.convert_via_rpc_only' using errcode = '23514';
    end if;
    if old.first_contacted_at is null and new.status is distinct from old.status
       and new.status not in ('new', 'lost') then
      new.first_contacted_at := now();
    end if;
  end if;

  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not app.is_company_member(new.company_id, new.owner_id) then
    raise exception 'lead.owner_must_be_member' using errcode = '23514';
  end if;
  if new.stage_id is not null and not exists (
    select 1 from public.pipeline_stages s
    join public.pipelines p on p.id = s.pipeline_id
    where s.id = new.stage_id and p.company_id = new.company_id and p.kind = 'lead') then
    raise exception 'lead.stage_not_in_company_lead_pipeline' using errcode = '23514';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION app.after_lead_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := app.actor_id();
  v_reason text := nullif(current_setting('app.assign_reason', true), '');
begin
  if tg_op = 'INSERT' then
    perform app.ensure_contact_link(new.contact_id, new.company_id);
    insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by)
    values (new.id, new.company_id, null, new.status, v_actor);
    if new.owner_id is not null then
      insert into public.lead_assignments (lead_id, company_id, from_user_id, to_user_id, team_id, assigned_by, reason)
      values (new.id, new.company_id, null, new.owner_id, new.team_id, v_actor, v_reason);
      if new.owner_id is distinct from v_actor then
        perform app.notify(new.owner_id, new.company_id, 'lead_assigned', 'تم إسناد عميل محتمل إليك',
                           new.title, 'lead', new.id);
      end if;
    end if;
    perform app.write_audit(new.company_id, 'lead.created', 'lead', new.id,
      jsonb_build_object('source', new.source, 'owner_id', new.owner_id)
      || case when new.auto_created then jsonb_build_object('automatic', true) else '{}'::jsonb end
      || case when new.conversation_id is not null then jsonb_build_object('conversation_id', new.conversation_id) else '{}'::jsonb end);
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by)
    values (new.id, new.company_id, old.status, new.status, v_actor);
  end if;
  if new.owner_id is distinct from old.owner_id or new.team_id is distinct from old.team_id then
    insert into public.lead_assignments (lead_id, company_id, from_user_id, to_user_id, team_id, assigned_by, reason)
    values (new.id, new.company_id, old.owner_id, new.owner_id, new.team_id, v_actor, v_reason);
    perform app.write_audit(new.company_id, 'lead.reassigned', 'lead', new.id,
      jsonb_build_object('from_user_id', old.owner_id, 'to_user_id', new.owner_id,
                         'from_team_id', old.team_id, 'to_team_id', new.team_id));
    if new.owner_id is distinct from old.owner_id then
      if new.owner_id is not null and new.owner_id is distinct from v_actor then
        perform app.notify(new.owner_id, new.company_id, 'lead_assigned', 'تم إسناد عميل محتمل إليك',
                           new.title, 'lead', new.id);
      end if;
      if old.owner_id is not null and old.owner_id is distinct from v_actor then
        perform app.notify(old.owner_id, new.company_id, 'lead_reassigned', 'تمت إعادة إسناد عميل محتمل',
                           new.title, 'lead', new.id);
      end if;
    end if;
  end if;
  if new.interest is distinct from old.interest then
    perform app.write_audit(new.company_id, 'lead.interest_changed', 'lead', new.id,
      jsonb_build_object('from_interest', old.interest, 'to_interest', new.interest));
  end if;
  if new.offering_id is distinct from old.offering_id then
    perform app.write_audit(new.company_id, 'lead.offering_changed', 'lead', new.id,
      jsonb_build_object('from_offering_id', old.offering_id, 'to_offering_id', new.offering_id, 'source', new.offering_source));
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform app.write_audit(new.company_id,
      case when new.archived_at is null then 'lead.unarchived' else 'lead.archived' end, 'lead', new.id, '{}'::jsonb);
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.ingest_whatsapp_message(p_phone_number_id text, p_wa_message_id text, p_from_wa_id text, p_profile_name text, p_message_type text, p_body text, p_media jsonb, p_sent_at timestamp with time zone)
 RETURNS TABLE(message_id uuid, conversation_id uuid, duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_acc public.whatsapp_accounts;
  v_phone text;
  v_contact uuid;
  v_conv uuid;
  v_msg uuid;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_wa_message_id is null or p_from_wa_id !~ '^[1-9][0-9]{6,14}$' then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;

  select m.id, m.conversation_id into v_msg, v_conv from public.messages m where m.wa_message_id = p_wa_message_id;
  if found then
    return query select v_msg, v_conv, true;
    return;
  end if;

  select * into v_acc from public.whatsapp_accounts where phone_number_id = p_phone_number_id;
  if not found then
    raise exception 'whatsapp.unknown_phone_number_id' using errcode = 'P0002';
  end if;

  v_phone := '+' || p_from_wa_id;
  select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
  if v_contact is null then
    insert into public.contacts (full_name, phone_e164)
    values (coalesce(nullif(btrim(left(p_profile_name, 200)), ''), v_phone), v_phone)
    on conflict (phone_e164) where merged_into_id is null and phone_e164 is not null do nothing
    returning id into v_contact;
    if v_contact is null then
      select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
    end if;
  end if;
  perform app.ensure_contact_link(v_contact, v_acc.default_company_id);

  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, is_simulated)
  values (v_acc.id, v_acc.default_company_id, v_contact, p_from_wa_id, v_acc.is_simulated)
  on conflict (whatsapp_account_id, customer_wa_id) do nothing;
  select id into v_conv from public.conversations
  where whatsapp_account_id = v_acc.id and customer_wa_id = p_from_wa_id;

  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status, sent_at, is_simulated)
  values (v_conv, 'inbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096),
          p_media, 'received', coalesce(p_sent_at, now()), v_acc.is_simulated)
  on conflict (wa_message_id) do nothing
  returning id into v_msg;

  if v_msg is null then   -- lost a race with a concurrent duplicate delivery
    select m.id into v_msg from public.messages m where m.wa_message_id = p_wa_message_id;
    return query select v_msg, v_conv, true;
    return;
  end if;

  -- 0950: one lead per customer inquiry, in the same transaction as the message
  -- (any failure rolls everything back and the event is retried by the existing job).
  perform app.ensure_whatsapp_lead(v_conv, p_body);
  return query select v_msg, v_conv, false;
end $function$;

-- ---------------------------------------------- the lead behind a conversation
-- Which lead a conversation shows: an open lead linked to it, else the
-- company's open lead for the same customer (e.g. created through another
-- number), else the newest closed lead linked to it. security_invoker: the
-- caller's RLS on conversations and leads applies.
create view public.conversation_leads with (security_invoker = true) as
select c.id as conversation_id, l.id as lead_id, l.status as lead_status, l.interest, l.offering_id,
       l.owner_id as lead_owner_id, l.auto_created, (l.conversation_id is not distinct from c.id) as linked
from public.conversations c
cross join lateral (
  select x.* from public.leads x
  where x.company_id = c.company_id
    and ((x.conversation_id is not distinct from c.id)
         or (x.contact_id = c.contact_id and x.archived_at is null and x.status in ('new', 'contacted', 'qualified')))
  order by ((x.conversation_id is not distinct from c.id) and x.archived_at is null and x.status in ('new', 'contacted', 'qualified')) desc,
           (x.archived_at is null and x.status in ('new', 'contacted', 'qualified')) desc,
           (x.conversation_id is not distinct from c.id) desc, x.created_at desc
  limit 1
) l;
revoke all on public.conversation_leads from anon, public;
grant select on public.conversation_leads to authenticated;

-- ------------------------------------------- manual "lead from this chat"
-- Atomic and idempotent: repeated clicks or a click racing the intake return
-- the existing lead. Invoker: RLS and the lead guard decide who may do it.
create or replace function public.lead_from_conversation(p_conversation_id uuid)
returns table (lead_id uuid, created boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  c public.conversations;
  v_existing uuid;
  v_name text;
  v_uid uuid := auth.uid();
begin
  select * into c from public.conversations where id = p_conversation_id;
  if not found then raise exception 'conversation.not_found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wa-lead:' || c.company_id || ':' || c.contact_id, 0));
  select v.lead_id into v_existing from public.conversation_leads v
  where v.conversation_id = c.id and v.lead_status in ('new', 'contacted', 'qualified');
  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;
  -- An open lead exists but the caller cannot see it (e.g. unassigned): never create a duplicate.
  if app.conversation_has_open_lead(c.id) then
    raise exception 'lead.already_exists' using errcode = '23514';
  end if;
  select coalesce(nullif(btrim(left(k.full_name, 200)), ''), k.phone_e164, 'WhatsApp') into v_name
  from public.contacts k where k.id = c.contact_id;
  insert into public.leads (company_id, contact_id, title, source, owner_id, conversation_id)
  values (c.company_id, c.contact_id, v_name, 'whatsapp',
          case when app.is_company_member(c.company_id, v_uid) then v_uid end, c.id)
  returning id into v_existing;
  return query select v_existing, true;
end $$;
revoke all on function public.lead_from_conversation(uuid) from public, anon;
grant execute on function public.lead_from_conversation(uuid) to authenticated;
