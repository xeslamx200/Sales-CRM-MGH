-- =============================================================================
-- 0850 — Records owned by former employees stay editable.
--
-- The lead, deal, task, contact-link and target guards re-checked "owner /
-- assignee must be an active company member" on EVERY update. After an
-- employee was deactivated (or left a company), nobody could edit their
-- records — not even an admin — and system updates failed too (e.g. logging
-- an activity on such a lead aborted, because it touches last_activity_at).
-- The membership rule now applies when the person is set or changed, which
-- is when it matters. Bodies are otherwise identical to the live versions.
-- Regression test: supabase/tests/db/10_security_review.sql.
-- =============================================================================

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

CREATE OR REPLACE FUNCTION app.guard_deal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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

  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not app.is_company_member(new.company_id, new.owner_id) then
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
end $function$;

CREATE OR REPLACE FUNCTION app.guard_task()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not app.is_company_member(new.company_id, new.assigned_to) then
    raise exception 'task.assignee_must_be_member' using errcode = '23514';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION app.guard_contact_company()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  elsif (new.contact_id, new.company_id, new.created_by) is distinct from (old.contact_id, old.company_id, old.created_by)
        and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'contact_company.immutable_field' using errcode = '42501';
  end if;
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not app.is_company_member(new.company_id, new.owner_id) then
    raise exception 'contact_company.owner_must_be_member' using errcode = '23514';
  end if;
  if not app.is_service_context() and new.owner_id is distinct from (case when tg_op = 'UPDATE' then old.owner_id end)
     and new.owner_id is distinct from auth.uid() and not app.is_company_manager(new.company_id) then
    raise exception 'contact_company.owner_change_forbidden' using errcode = '42501';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION app.guard_target()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  elsif new.company_id is distinct from old.company_id or new.created_by is distinct from old.created_by then
    raise exception 'target.immutable_field' using errcode = '42501';
  end if;
  if new.user_id is not null and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id)
     and not app.is_company_member(new.company_id, new.user_id) then
    raise exception 'target.user_must_be_member' using errcode = '23514';
  end if;
  return new;
end $function$;
