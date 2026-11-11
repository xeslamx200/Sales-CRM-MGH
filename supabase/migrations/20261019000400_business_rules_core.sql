-- =============================================================================
-- 0400 — Business rules I: audit, notifications, profiles, companies,
-- memberships, teams, contacts.
--
-- Error convention: RAISE with a stable, dotted message key (e.g.
-- 'membership.cannot_manage_company_admin') and SQLSTATE 42501 for
-- permission problems or 23514 for rule violations. The UI maps keys to
-- localized text; keys never contain user data.
-- =============================================================================

-- Trusted internal operations (set transaction-locally by SECURITY DEFINER
-- functions in this schema) may maintain system columns. The Data API cannot
-- set arbitrary settings, so clients cannot raise this flag.
create or replace function app.in_system_op() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.system_op', true), '') = 'on'
$$;

create or replace function app.begin_system_op() returns void
language sql set search_path = '' as $$ select set_config('app.system_op', 'on', true) $$;

create or replace function app.end_system_op() returns void
language sql set search_path = '' as $$ select set_config('app.system_op', 'off', true) $$;

-- -----------------------------------------------------------------------------
-- Audit log
-- -----------------------------------------------------------------------------
create or replace function app.write_audit(
  p_company_id uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_company_id, app.actor_id(), p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

create or replace function app.block_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit.immutable' using errcode = '42501';
end $$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.block_audit_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.block_audit_mutation();

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------
create or replace function app.notify(
  p_user_id uuid, p_company_id uuid, p_type text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid, p_dedupe_key text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then return; end if;
  -- Only notify people who can still act in that company.
  if p_company_id is not null and not app.is_company_member(p_company_id, p_user_id)
     and not exists (select 1 from public.profiles where id = p_user_id and is_super_admin and is_active) then
    return;
  end if;
  insert into public.notifications (user_id, company_id, type, title, body, entity_type, entity_id, dedupe_key)
  values (p_user_id, p_company_id, p_type, p_title, p_body, p_entity_type, p_entity_id, p_dedupe_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
end $$;

-- Notification rows: users may only toggle read_at.
create or replace function app.guard_notification_update() returns trigger
language plpgsql as $$
begin
  if app.is_service_context() then return new; end if;
  if (new.user_id, new.company_id, new.type, new.title, new.body, new.entity_type, new.entity_id, new.created_at)
     is distinct from
     (old.user_id, old.company_id, old.type, old.title, old.body, old.entity_type, old.entity_id, old.created_at) then
    raise exception 'notification.only_read_state_editable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger notifications_guard before update on public.notifications
  for each row execute function app.guard_notification_update();

-- -----------------------------------------------------------------------------
-- Profiles: created from auth.users; privileged columns guarded.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

create or replace function app.handle_auth_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function app.handle_auth_user_email_change();

create or replace function app.guard_profile_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'profile.immutable_field' using errcode = '42501';
  end if;
  if app.is_service_context() then
    return new;
  end if;
  if new.email is distinct from old.email then
    raise exception 'profile.email_managed_by_auth' using errcode = '42501';
  end if;
  if (new.is_super_admin, new.is_active) is distinct from (old.is_super_admin, old.is_active) then
    if not app.is_super_admin() then
      raise exception 'profile.privileged_field' using errcode = '42501';
    end if;
    if new.id = auth.uid() then
      raise exception 'profile.cannot_change_own_access' using errcode = '42501';
    end if;
  end if;
  if new.is_active is distinct from old.is_active then
    if new.is_active then
      new.deactivated_at := null; new.deactivated_by := null;
    else
      new.deactivated_at := now(); new.deactivated_by := auth.uid();
    end if;
  elsif (new.deactivated_at, new.deactivated_by) is distinct from (old.deactivated_at, old.deactivated_by) then
    raise exception 'profile.privileged_field' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function app.guard_profile_update();

create or replace function app.audit_profile_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_active is distinct from old.is_active then
    perform app.write_audit(null, case when new.is_active then 'user.activated' else 'user.deactivated' end,
                            'profile', new.id, '{}'::jsonb);
  end if;
  if new.is_super_admin is distinct from old.is_super_admin then
    perform app.write_audit(null, case when new.is_super_admin then 'user.super_admin_granted' else 'user.super_admin_revoked' end,
                            'profile', new.id, '{}'::jsonb);
  end if;
  return null;
end $$;
create trigger profiles_audit after update on public.profiles
  for each row execute function app.audit_profile_update();

-- -----------------------------------------------------------------------------
-- Companies
-- -----------------------------------------------------------------------------
create or replace function app.guard_company() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
    return new;
  end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'company.immutable_field' using errcode = '42501';
  end if;
  if not app.is_service_context() and not app.is_super_admin()
     and (new.slug, new.is_active) is distinct from (old.slug, old.is_active) then
    raise exception 'company.super_admin_only_field' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger companies_guard before insert or update on public.companies
  for each row execute function app.guard_company();

create or replace function app.audit_company() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.id, 'company.created', 'company', new.id, jsonb_build_object('slug', new.slug));
  elsif (new.name, new.slug, new.timezone, new.currency, new.is_active)
        is distinct from (old.name, old.slug, old.timezone, old.currency, old.is_active) then
    perform app.write_audit(new.id, 'company.updated', 'company', new.id,
      jsonb_build_object('is_active', new.is_active, 'timezone', new.timezone, 'currency', new.currency));
  end if;
  return null;
end $$;
create trigger companies_audit after insert or update on public.companies
  for each row execute function app.audit_company();

-- Every new company gets a default lead pipeline and deal pipeline.
create or replace function app.create_default_pipelines() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pipeline uuid;
begin
  insert into public.pipelines (company_id, name, kind, is_default)
  values (new.id, 'مسار العملاء المحتملين', 'lead', true) returning id into v_pipeline;
  insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type) values
    (v_pipeline, new.id, 'جديد', 0, 'open'),
    (v_pipeline, new.id, 'تم التواصل', 1, 'open'),
    (v_pipeline, new.id, 'مؤهل', 2, 'open');

  insert into public.pipelines (company_id, name, kind, is_default)
  values (new.id, 'مسار الصفقات', 'deal', true) returning id into v_pipeline;
  insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type, probability) values
    (v_pipeline, new.id, 'اكتشاف', 0, 'open', 10),
    (v_pipeline, new.id, 'عرض سعر', 1, 'open', 40),
    (v_pipeline, new.id, 'تفاوض', 2, 'open', 70),
    (v_pipeline, new.id, 'مكسوبة', 3, 'won', 100),
    (v_pipeline, new.id, 'خاسرة', 4, 'lost', 0);
  return null;
end $$;
create trigger companies_default_pipelines after insert on public.companies
  for each row execute function app.create_default_pipelines();

-- Stage rules: one won stage and one lost stage per deal pipeline are allowed
-- to be many, but a lead pipeline may only contain open stages.
create or replace function app.guard_stage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind public.pipeline_kind;
begin
  select kind into v_kind from public.pipelines where id = new.pipeline_id;
  if v_kind = 'lead' and new.stage_type <> 'open' then
    raise exception 'pipeline.lead_stages_must_be_open' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.stage_type is distinct from old.stage_type and exists (
    select 1 from public.deals d where d.stage_id = new.id) then
    raise exception 'pipeline.stage_type_in_use' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger pipeline_stages_guard before insert or update on public.pipeline_stages
  for each row execute function app.guard_stage();

-- -----------------------------------------------------------------------------
-- Memberships: only super admins manage company admins; nobody edits their
-- own membership.
-- -----------------------------------------------------------------------------
create or replace function app.guard_membership() returns trigger
language plpgsql as $$
declare v_row public.company_memberships;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  end if;
  if tg_op = 'UPDATE' and (new.company_id, new.user_id, new.created_by, new.created_at)
     is distinct from (old.company_id, old.user_id, old.created_by, old.created_at) then
    raise exception 'membership.immutable_field' using errcode = '42501';
  end if;
  if app.is_service_context() or app.is_super_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_row.user_id = auth.uid() then
    raise exception 'membership.cannot_edit_own' using errcode = '42501';
  end if;
  if (tg_op <> 'DELETE' and new.role = 'company_admin')
     or (tg_op <> 'INSERT' and old.role = 'company_admin') then
    raise exception 'membership.cannot_manage_company_admin' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger memberships_guard before insert or update or delete on public.company_memberships
  for each row execute function app.guard_membership();

create or replace function app.audit_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.company_id, 'membership.created', 'company_membership', new.id,
      jsonb_build_object('user_id', new.user_id, 'role', new.role));
  elsif tg_op = 'UPDATE' then
    if (new.role, new.is_active) is distinct from (old.role, old.is_active) then
      perform app.write_audit(new.company_id, 'membership.updated', 'company_membership', new.id,
        jsonb_build_object('user_id', new.user_id, 'from_role', old.role, 'to_role', new.role,
                           'is_active', new.is_active));
    end if;
  else
    perform app.write_audit(old.company_id, 'membership.deleted', 'company_membership', old.id,
      jsonb_build_object('user_id', old.user_id, 'role', old.role));
  end if;
  return null;
end $$;
create trigger memberships_audit after insert or update or delete on public.company_memberships
  for each row execute function app.audit_membership();

-- -----------------------------------------------------------------------------
-- Teams
-- -----------------------------------------------------------------------------
create or replace function app.guard_team() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  elsif new.company_id is distinct from old.company_id then
    raise exception 'team.immutable_field' using errcode = '42501';
  end if;
  if new.manager_id is not null and not exists (
    select 1 from public.company_memberships m
    where m.company_id = new.company_id and m.user_id = new.manager_id and m.is_active
      and m.role in ('company_admin', 'sales_manager')) then
    raise exception 'team.manager_must_be_manager' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger teams_guard before insert or update on public.teams
  for each row execute function app.guard_team();

create or replace function app.guard_team_membership() returns trigger
language plpgsql as $$
begin
  new.created_by := coalesce(app.actor_id(), new.created_by);
  if not app.is_company_member(new.company_id, new.user_id) then
    raise exception 'team.member_must_belong_to_company' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger team_memberships_guard before insert on public.team_memberships
  for each row execute function app.guard_team_membership();

-- -----------------------------------------------------------------------------
-- Contacts
-- -----------------------------------------------------------------------------
create or replace function app.guard_contact() returns trigger
language plpgsql as $$
begin
  new.full_name := btrim(new.full_name);
  new.email := nullif(lower(btrim(new.email)), '');
  if tg_op = 'INSERT' then
    if not app.is_service_context() then
      new.created_by := auth.uid();
      new.merged_into_id := null;
    end if;
    return new;
  end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'contact.immutable_field' using errcode = '42501';
  end if;
  if new.merged_into_id is distinct from old.merged_into_id
     and not app.is_service_context()
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'contact.merge_via_rpc_only' using errcode = '42501';
  end if;
  if old.merged_into_id is not null and not app.is_service_context()
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'contact.merged_is_read_only' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger contacts_guard before insert or update on public.contacts
  for each row execute function app.guard_contact();

create or replace function app.guard_contact_company() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(app.actor_id(), new.created_by);
  elsif (new.contact_id, new.company_id, new.created_by) is distinct from (old.contact_id, old.company_id, old.created_by)
        and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'contact_company.immutable_field' using errcode = '42501';
  end if;
  if new.owner_id is not null and not app.is_company_member(new.company_id, new.owner_id) then
    raise exception 'contact_company.owner_must_be_member' using errcode = '23514';
  end if;
  if not app.is_service_context() and new.owner_id is distinct from (case when tg_op = 'UPDATE' then old.owner_id end)
     and new.owner_id is distinct from auth.uid() and not app.is_company_manager(new.company_id) then
    raise exception 'contact_company.owner_change_forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger contact_companies_guard before insert or update on public.contact_companies
  for each row execute function app.guard_contact_company();
