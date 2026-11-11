-- =============================================================================
-- 0900 — Pipeline management RPCs (company admins).
--
-- All SECURITY INVOKER: RLS (pipelines_write / stages_write = company admin)
-- and app.guard_stage (lead stages are open; a stage type in use can't
-- change) decide. These exist only because the operations must be atomic:
--   * create_pipeline: pipeline + starter stages in one step
--   * reorder_pipeline_stages: positions are unique per pipeline (deferred
--     constraint) — one statement
--   * set_default_pipeline: one default per company and kind (partial unique
--     index) — unset then set in one transaction; a deal pipeline must have an
--     active open, won and lost stage to become the default
-- =============================================================================
create or replace function public.create_pipeline(p_company_id uuid, p_name text, p_kind public.pipeline_kind)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v uuid;
begin
  insert into public.pipelines (company_id, name, kind, is_default)
  values (p_company_id, btrim(p_name), p_kind, false) returning id into v;
  if p_kind = 'lead' then
    insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type) values
      (v, p_company_id, 'جديد', 0, 'open'), (v, p_company_id, 'تم التواصل', 1, 'open'), (v, p_company_id, 'مؤهل', 2, 'open');
  else
    insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type, probability) values
      (v, p_company_id, 'جديدة', 0, 'open', 10), (v, p_company_id, 'مكسوبة', 1, 'won', 100), (v, p_company_id, 'خاسرة', 2, 'lost', 0);
  end if;
  return v;
end $$;

create or replace function public.reorder_pipeline_stages(p_pipeline_id uuid, p_stage_ids uuid[])
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_stage_ids is null
     or cardinality(p_stage_ids) <> (select count(*) from public.pipeline_stages where pipeline_id = p_pipeline_id)
     or cardinality(p_stage_ids) <> (select count(distinct x) from unnest(p_stage_ids) x)
     or exists (select 1 from unnest(p_stage_ids) x
                where not exists (select 1 from public.pipeline_stages s where s.id = x and s.pipeline_id = p_pipeline_id)) then
    raise exception 'pipeline.invalid_order' using errcode = '22023';
  end if;
  update public.pipeline_stages s set position = o.ord - 1
  from unnest(p_stage_ids) with ordinality as o(id, ord)
  where s.id = o.id and s.pipeline_id = p_pipeline_id;
  if not found then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.set_default_pipeline(p_pipeline_id uuid)
returns void
language plpgsql security invoker set search_path = '' as $$
declare v public.pipelines;
begin
  select * into v from public.pipelines where id = p_pipeline_id;
  if not found then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if not v.is_active then
    raise exception 'pipeline.inactive' using errcode = '23514';
  end if;
  if v.kind = 'deal' and (
       not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'open')
    or not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'won')
    or not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'lost')) then
    raise exception 'pipeline.incomplete' using errcode = '23514';
  end if;
  update public.pipelines set is_default = false where company_id = v.company_id and kind = v.kind and is_default and id <> v.id;
  update public.pipelines set is_default = true where id = v.id;
  if not found then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
end $$;

revoke execute on function public.create_pipeline(uuid, text, public.pipeline_kind), public.reorder_pipeline_stages(uuid, uuid[]),
  public.set_default_pipeline(uuid) from public, anon;
grant execute on function public.create_pipeline(uuid, text, public.pipeline_kind), public.reorder_pipeline_stages(uuid, uuid[]),
  public.set_default_pipeline(uuid) to authenticated;
