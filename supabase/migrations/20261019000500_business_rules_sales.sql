-- =============================================================================
-- 0500 — Business rules II: leads, deals, tasks, activities.
-- =============================================================================

-- Who may move ownership of a record from p_old to p_new in a company.
--   company admin / super admin : anyone -> anyone in the company
--   sales manager               : between themselves, unassigned and the
--                                 members of teams they manage
--   anyone                      : claim an unassigned record for themselves
create or replace function app.can_reassign(p_company_id uuid, p_old uuid, p_new uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_company_admin(p_company_id)
    or (
      app.company_role(p_company_id) = 'sales_manager'
      and (p_old is null or p_old = auth.uid() or app.manages_user(p_company_id, p_old))
      and (p_new is null or p_new = auth.uid() or app.manages_user(p_company_id, p_new))
    )
    or (p_old is null and p_new = auth.uid() and app.has_company_access(p_company_id))
$$;

create or replace function app.ensure_contact_link(p_contact_id uuid, p_company_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.contact_companies (contact_id, company_id, created_by)
  values (p_contact_id, p_company_id, app.actor_id())
  on conflict (contact_id, company_id) do nothing;
$$;

create or replace function app.user_display_name(p_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(full_name, ''), email, '') from public.profiles where id = p_user_id
$$;

-- Notify the managers of the teams a user belongs to.
create or replace function app.notify_team_managers(
  p_company_id uuid, p_user_id uuid, p_type text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct t.manager_id
    from public.teams t
    join public.team_memberships tm on tm.team_id = t.id
    where t.company_id = p_company_id and t.is_active and tm.user_id = p_user_id
      and t.manager_id is not null and t.manager_id <> p_user_id
      and t.manager_id is distinct from app.actor_id()
  loop
    perform app.notify(r.manager_id, p_company_id, p_type, p_title, p_body, p_entity_type, p_entity_id);
  end loop;
end $$;

-- =============================================================================
-- Leads
-- =============================================================================
create or replace function app.guard_lead() returns trigger
language plpgsql as $$
declare
  v_service boolean := app.is_service_context() or app.in_system_op();
begin
  if tg_op = 'INSERT' then
    if not v_service then
      new.created_by := auth.uid();
      new.archived_at := null;
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
    if new.created_by is null then
      raise exception 'lead.created_by_required' using errcode = '23514';
    end if;
    if new.status = 'converted' then
      raise exception 'lead.convert_via_rpc_only' using errcode = '23514';
    end if;
    if new.status not in ('new', 'lost') and new.first_contacted_at is null then
      new.first_contacted_at := now();
    end if;
  else
    if (new.company_id, new.created_by, new.created_at)
       is distinct from (old.company_id, old.created_by, old.created_at) then
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

  if new.owner_id is not null and not app.is_company_member(new.company_id, new.owner_id) then
    raise exception 'lead.owner_must_be_member' using errcode = '23514';
  end if;
  if new.stage_id is not null and not exists (
    select 1 from public.pipeline_stages s
    join public.pipelines p on p.id = s.pipeline_id
    where s.id = new.stage_id and p.company_id = new.company_id and p.kind = 'lead') then
    raise exception 'lead.stage_not_in_company_lead_pipeline' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger leads_guard before insert or update on public.leads
  for each row execute function app.guard_lead();

create or replace function app.after_lead_change() returns trigger
language plpgsql security definer set search_path = '' as $$
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
      jsonb_build_object('source', new.source, 'owner_id', new.owner_id));
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
  if new.archived_at is distinct from old.archived_at then
    perform app.write_audit(new.company_id,
      case when new.archived_at is null then 'lead.unarchived' else 'lead.archived' end, 'lead', new.id, '{}'::jsonb);
  end if;
  return null;
end $$;
create trigger leads_after after insert or update on public.leads
  for each row execute function app.after_lead_change();

-- =============================================================================
-- Deals: status is always derived from the stage type.
-- =============================================================================
create or replace function app.guard_deal() returns trigger
language plpgsql as $$
declare
  v_service boolean := app.is_service_context();
  v_stage record;
  v_old_status public.deal_status := case when tg_op = 'UPDATE' then old.status end;
begin
  select s.stage_type, s.probability, s.is_active, p.kind, p.company_id
    into v_stage
  from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id
  where s.id = new.stage_id and s.pipeline_id = new.pipeline_id;

  if not found or v_stage.kind <> 'deal' or v_stage.company_id <> new.company_id then
    raise exception 'deal.stage_not_in_pipeline' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if not v_service then
      new.created_by := auth.uid();
      new.archived_at := null;
      if not app.can_see_contact(new.contact_id) then
        raise exception 'deal.contact_not_accessible' using errcode = '42501';
      end if;
      if new.lead_id is not null and not app.can_access_lead(new.lead_id) then
        raise exception 'deal.lead_not_accessible' using errcode = '42501';
      end if;
      new.owner_id := coalesce(new.owner_id, auth.uid());
      if new.owner_id <> auth.uid() and not app.can_reassign(new.company_id, null, new.owner_id) then
        raise exception 'deal.owner_change_forbidden' using errcode = '42501';
      end if;
      new.won_at := null; new.lost_at := null; new.closed_by := null;
    end if;
    if new.created_by is null then
      raise exception 'deal.created_by_required' using errcode = '23514';
    end if;
    if new.currency is null then
      select currency into new.currency from public.companies where id = new.company_id;
    end if;
    if not v_stage.is_active then
      raise exception 'deal.stage_inactive' using errcode = '23514';
    end if;
  else
    if (new.company_id, new.created_by, new.created_at, new.lead_id)
       is distinct from (old.company_id, old.created_by, old.created_at, old.lead_id) then
      raise exception 'deal.immutable_field' using errcode = '42501';
    end if;
    if new.contact_id is distinct from old.contact_id
       and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' and not v_service then
      raise exception 'deal.immutable_field' using errcode = '42501';
    end if;
    if not v_service then
      if new.owner_id is distinct from old.owner_id
         and not app.can_reassign(new.company_id, old.owner_id, new.owner_id) then
        raise exception 'deal.owner_change_forbidden' using errcode = '42501';
      end if;
      if new.stage_id is distinct from old.stage_id and not v_stage.is_active then
        raise exception 'deal.stage_inactive' using errcode = '23514';
      end if;
      -- Outcome fields are system-maintained.
      new.won_at := old.won_at; new.lost_at := old.lost_at; new.closed_by := old.closed_by;
      -- Changing a closed deal's outcome or a won deal's amount: managers only.
      if old.status <> 'open' and v_stage.stage_type::text <> old.status::text
         and not app.is_company_manager(new.company_id) then
        raise exception 'deal.reopen_requires_manager' using errcode = '42501';
      end if;
      if old.status = 'won' and (new.amount, new.currency) is distinct from (old.amount, old.currency)
         and not app.is_company_manager(new.company_id) then
        raise exception 'deal.won_amount_requires_manager' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.owner_id is not null and not app.is_company_member(new.company_id, new.owner_id) then
    raise exception 'deal.owner_must_be_member' using errcode = '23514';
  end if;

  new.status := v_stage.stage_type::text::public.deal_status;
  if new.probability is null or (tg_op = 'UPDATE' and new.stage_id is distinct from old.stage_id) then
    new.probability := coalesce(v_stage.probability, new.probability);
  end if;

  if new.status is distinct from v_old_status then
    if new.status = 'won' then
      new.won_at := case when v_service then coalesce(new.won_at, now()) else now() end;
      new.lost_at := null; new.loss_reason := null;
      new.closed_by := case when v_service then coalesce(new.closed_by, app.actor_id()) else auth.uid() end;
    elsif new.status = 'lost' then
      new.lost_at := case when v_service then coalesce(new.lost_at, now()) else now() end;
      new.won_at := null;
      new.closed_by := case when v_service then coalesce(new.closed_by, app.actor_id()) else auth.uid() end;
      if new.loss_reason is null or btrim(new.loss_reason) = '' then
        raise exception 'deal.loss_reason_required' using errcode = '23514';
      end if;
    else
      new.won_at := null; new.lost_at := null; new.closed_by := null; new.loss_reason := null;
    end if;
  end if;
  return new;
end $$;
create trigger deals_guard before insert or update on public.deals
  for each row execute function app.guard_deal();

create or replace function app.after_deal_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.actor_id();
  v_title text;
begin
  if tg_op = 'INSERT' then
    perform app.ensure_contact_link(new.contact_id, new.company_id);
    insert into public.deal_stage_history (deal_id, company_id, from_stage_id, to_stage_id, from_status, to_status, changed_by)
    values (new.id, new.company_id, null, new.stage_id, null, new.status, v_actor);
    perform app.write_audit(new.company_id, 'deal.created', 'deal', new.id,
      jsonb_build_object('stage_id', new.stage_id, 'status', new.status, 'lead_id', new.lead_id));
    if new.owner_id is not null and new.owner_id is distinct from v_actor then
      perform app.notify(new.owner_id, new.company_id, 'deal_assigned', 'تم إسناد صفقة إليك', new.title, 'deal', new.id);
    end if;
    return null;
  end if;

  if new.stage_id is distinct from old.stage_id or new.status is distinct from old.status then
    insert into public.deal_stage_history (deal_id, company_id, from_stage_id, to_stage_id, from_status, to_status, changed_by)
    values (new.id, new.company_id, old.stage_id, new.stage_id, old.status, new.status, v_actor);
    perform app.write_audit(new.company_id, 'deal.stage_changed', 'deal', new.id,
      jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id,
                         'from_status', old.status, 'to_status', new.status));
  end if;
  if new.status is distinct from old.status and new.status in ('won', 'lost') then
    v_title := case when new.status = 'won' then 'تم كسب صفقة' else 'تم خسارة صفقة' end;
    if new.owner_id is not null and new.owner_id is distinct from v_actor then
      perform app.notify(new.owner_id, new.company_id, 'deal_' || new.status::text, v_title, new.title, 'deal', new.id);
    end if;
    if new.owner_id is not null then
      perform app.notify_team_managers(new.company_id, new.owner_id, 'deal_' || new.status::text, v_title,
                                       new.title, 'deal', new.id);
    end if;
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform app.write_audit(new.company_id, 'deal.reassigned', 'deal', new.id,
      jsonb_build_object('from_user_id', old.owner_id, 'to_user_id', new.owner_id));
    if new.owner_id is not null and new.owner_id is distinct from v_actor then
      perform app.notify(new.owner_id, new.company_id, 'deal_assigned', 'تم إسناد صفقة إليك', new.title, 'deal', new.id);
    end if;
  end if;
  if (new.amount, new.currency) is distinct from (old.amount, old.currency) and old.status = 'won' then
    perform app.write_audit(new.company_id, 'deal.won_amount_changed', 'deal', new.id,
      jsonb_build_object('from_amount', old.amount, 'to_amount', new.amount));
  end if;
  return null;
end $$;
create trigger deals_after after insert or update on public.deals
  for each row execute function app.after_deal_change();

-- =============================================================================
-- Tasks: completion is permanent; completion actor/time are system-set.
-- =============================================================================
create or replace function app.guard_task() returns trigger
language plpgsql as $$
declare
  v_service boolean := app.is_service_context();
begin
  if tg_op = 'INSERT' then
    if not v_service then
      new.created_by := auth.uid();
      new.assigned_to := coalesce(new.assigned_to, auth.uid());
      if new.status not in ('open', 'in_progress') then
        raise exception 'task.must_start_open' using errcode = '23514';
      end if;
      new.completed_at := null; new.completed_by := null; new.canceled_at := null;
      if new.assigned_to <> auth.uid() and not app.can_reassign(new.company_id, null, new.assigned_to) then
        raise exception 'task.assign_forbidden' using errcode = '42501';
      end if;
      if new.lead_id is not null and not app.can_access_lead(new.lead_id) then
        raise exception 'task.lead_not_accessible' using errcode = '42501';
      end if;
      if new.deal_id is not null and not app.can_access_deal(new.deal_id) then
        raise exception 'task.deal_not_accessible' using errcode = '42501';
      end if;
      if new.contact_id is not null and not app.can_see_contact(new.contact_id) then
        raise exception 'task.contact_not_accessible' using errcode = '42501';
      end if;
    end if;
    if new.created_by is null then
      raise exception 'task.created_by_required' using errcode = '23514';
    end if;
    if new.contact_id is null and new.lead_id is not null then
      select contact_id into new.contact_id from public.leads where id = new.lead_id;
    elsif new.contact_id is null and new.deal_id is not null then
      select contact_id into new.contact_id from public.deals where id = new.deal_id;
    end if;
  else
    if (new.company_id, new.created_by, new.created_at) is distinct from (old.company_id, old.created_by, old.created_at) then
      raise exception 'task.immutable_field' using errcode = '42501';
    end if;
    if old.status = 'completed' then
      if (new.status, new.completed_at, new.completed_by, new.assigned_to, new.due_at)
         is distinct from (old.status, old.completed_at, old.completed_by, old.assigned_to, old.due_at) then
        raise exception 'task.completed_is_final' using errcode = '23514';
      end if;
      return new;
    end if;
    if not v_service then
      if new.assigned_to is distinct from old.assigned_to
         and not app.can_reassign(new.company_id, old.assigned_to, new.assigned_to) then
        raise exception 'task.assign_forbidden' using errcode = '42501';
      end if;
      if (new.lead_id, new.deal_id) is distinct from (old.lead_id, old.deal_id) then
        raise exception 'task.immutable_field' using errcode = '42501';
      end if;
      if old.status = 'canceled' and new.status <> 'canceled' and not app.is_company_manager(new.company_id) then
        raise exception 'task.reopen_requires_manager' using errcode = '42501';
      end if;
      new.completed_at := old.completed_at; new.completed_by := old.completed_by; new.canceled_at := old.canceled_at;
    end if;
    if new.status = 'completed' then
      new.completed_at := case when v_service then coalesce(new.completed_at, now()) else now() end;
      new.completed_by := case when v_service then coalesce(new.completed_by, app.actor_id()) else auth.uid() end;
      new.canceled_at := null;
    elsif new.status = 'canceled' then
      if old.status <> 'canceled' then
        new.canceled_at := case when v_service then coalesce(new.canceled_at, now()) else now() end;
      end if;
    else
      new.canceled_at := null;
    end if;
  end if;
  if new.assigned_to is not null and not app.is_company_member(new.company_id, new.assigned_to) then
    raise exception 'task.assignee_must_be_member' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tasks_guard before insert or update on public.tasks
  for each row execute function app.guard_task();

create or replace function app.after_task_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := app.actor_id();
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and new.assigned_to is distinct from v_actor then
      perform app.notify(new.assigned_to, new.company_id, 'task_assigned', 'مهمة جديدة مسندة إليك',
                         new.title, 'task', new.id);
    end if;
    return null;
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    perform app.write_audit(new.company_id, 'task.completed', 'task', new.id,
      jsonb_build_object('lead_id', new.lead_id, 'deal_id', new.deal_id, 'assigned_to', new.assigned_to));
    if new.lead_id is not null then
      perform app.begin_system_op();
      update public.leads set last_activity_at = greatest(coalesce(last_activity_at, new.completed_at), new.completed_at)
      where id = new.lead_id;
      perform app.end_system_op();
    end if;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform app.write_audit(new.company_id, 'task.reassigned', 'task', new.id,
      jsonb_build_object('from_user_id', old.assigned_to, 'to_user_id', new.assigned_to));
    if new.assigned_to is not null and new.assigned_to is distinct from v_actor then
      perform app.notify(new.assigned_to, new.company_id, 'task_assigned', 'مهمة جديدة مسندة إليك',
                         new.title, 'task', new.id);
    end if;
  end if;
  return null;
end $$;
create trigger tasks_after after insert or update on public.tasks
  for each row execute function app.after_task_change();

-- =============================================================================
-- Activities (calls, meetings, notes, ...)
-- =============================================================================
create or replace function app.guard_activity() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not app.is_service_context() then
      new.actor_id := auth.uid();
      if new.lead_id is not null and not app.can_access_lead(new.lead_id) then
        raise exception 'activity.lead_not_accessible' using errcode = '42501';
      end if;
      if new.deal_id is not null and not app.can_access_deal(new.deal_id) then
        raise exception 'activity.deal_not_accessible' using errcode = '42501';
      end if;
      if new.contact_id is not null and not app.can_see_contact(new.contact_id) then
        raise exception 'activity.contact_not_accessible' using errcode = '42501';
      end if;
    end if;
    if new.occurred_at > now() + interval '5 minutes' then
      raise exception 'activity.occurred_in_future' using errcode = '23514';
    end if;
    if new.contact_id is null and new.lead_id is not null then
      select contact_id into new.contact_id from public.leads where id = new.lead_id;
    elsif new.contact_id is null and new.deal_id is not null then
      select contact_id into new.contact_id from public.deals where id = new.deal_id;
    end if;
  else
    if (new.company_id, new.actor_id, new.lead_id, new.deal_id, new.created_at, new.type)
       is distinct from (old.company_id, old.actor_id, old.lead_id, old.deal_id, old.created_at, old.type) then
      raise exception 'activity.immutable_field' using errcode = '42501';
    end if;
    if new.contact_id is distinct from old.contact_id
       and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' and not app.is_service_context() then
      raise exception 'activity.immutable_field' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger activities_guard before insert or update on public.activities
  for each row execute function app.guard_activity();

create or replace function app.after_activity_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.lead_id is not null then
    perform app.begin_system_op();
    update public.leads set
      last_activity_at = greatest(coalesce(last_activity_at, new.occurred_at), new.occurred_at),
      first_contacted_at = case
        when first_contacted_at is null and new.type in ('call', 'meeting', 'email', 'whatsapp')
        then new.occurred_at else first_contacted_at end
    where id = new.lead_id;
    perform app.end_system_op();
  end if;
  return null;
end $$;
create trigger activities_after after insert on public.activities
  for each row execute function app.after_activity_insert();

-- -----------------------------------------------------------------------------
-- Sales targets: record creator.
-- -----------------------------------------------------------------------------
create or replace function app.guard_target() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  elsif new.company_id is distinct from old.company_id or new.created_by is distinct from old.created_by then
    raise exception 'target.immutable_field' using errcode = '42501';
  end if;
  if new.user_id is not null and not app.is_company_member(new.company_id, new.user_id) then
    raise exception 'target.user_must_be_member' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger sales_targets_guard before insert or update on public.sales_targets
  for each row execute function app.guard_target();
