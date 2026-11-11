-- Pipeline integrity for the pipeline management screen (0900).
--
-- set_default_pipeline already refuses to make an incomplete pipeline the
-- default, but plain UPDATEs through the API could still break the current
-- default afterwards (deactivate it, or deactivate its last won/lost stage),
-- leaving the company unable to create leads or deals. These triggers keep the
-- default usable no matter which path writes, and stop rows from being moved
-- between pipelines or companies.

create or replace function app.guard_pipeline() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.company_id, new.kind) is distinct from (old.company_id, old.kind) then
    raise exception 'pipeline.immutable_field' using errcode = '42501';
  end if;
  if new.is_default and not new.is_active then
    raise exception 'pipeline.default_must_stay_active' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger pipelines_guard before update on public.pipelines
  for each row execute function app.guard_pipeline();

create or replace function app.guard_stage_move() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.pipeline_id, new.company_id) is distinct from (old.pipeline_id, old.company_id) then
    raise exception 'pipeline.immutable_field' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger pipeline_stages_guard_move before update on public.pipeline_stages
  for each row execute function app.guard_stage_move();

-- After a stage changes or disappears, the default pipeline it belongs to must
-- still have an active open stage (and, for deals, active won and lost stages).
-- SECURITY DEFINER: the check must see every stage of the pipeline.
create or replace function app.check_default_pipeline_complete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.pipelines;
begin
  select * into v from public.pipelines where id = old.pipeline_id;
  if not found or not v.is_default then
    return null;
  end if;
  if not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'open')
     or (v.kind = 'deal' and (
          not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'won')
       or not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'lost'))) then
    raise exception 'pipeline.incomplete' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger pipeline_stages_default_complete after update of is_active, stage_type or delete on public.pipeline_stages
  for each row execute function app.check_default_pipeline_complete();

-- set_default_pipeline also needs an active open stage for lead pipelines.
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
  if not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'open')
     or (v.kind = 'deal' and (
          not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'won')
       or not exists (select 1 from public.pipeline_stages s where s.pipeline_id = v.id and s.is_active and s.stage_type = 'lost'))) then
    raise exception 'pipeline.incomplete' using errcode = '23514';
  end if;
  update public.pipelines set is_default = false where company_id = v.company_id and kind = v.kind and is_default and id <> v.id;
  update public.pipelines set is_default = true where id = v.id;
  if not found then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
end $$;
