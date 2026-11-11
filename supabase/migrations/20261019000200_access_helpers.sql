-- =============================================================================
-- 0200 — Access-control helpers used by RLS policies and triggers.
--
-- SECURITY DEFINER helpers read membership tables without recursing through
-- RLS. Every one pins search_path and reads identity only from auth.uid(),
-- never from arguments, so they cannot be used to impersonate another user.
-- Lives in schema `app`, which is not exposed through the Supabase Data API.
-- =============================================================================

-- Actor for audit/history rows. Authenticated requests: always the JWT user.
-- Service/maintenance context (no JWT user): optional `app.actor_id` setting
-- used by trusted server code and the dev seed; otherwise null.
create or replace function app.actor_id() returns uuid
language sql stable set search_path = '' as $$
  select coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid)
$$;

-- True only for trusted server-side contexts (service_role key, migrations,
-- maintenance scripts). SECURITY INVOKER so current_user is the caller; the
-- JWT role check also covers calls made from inside SECURITY DEFINER code,
-- where current_user is the function owner.
create or replace function app.is_service_context() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is null
     and coalesce(auth.role(), '') not in ('anon', 'authenticated')
     and current_user not in ('anon', 'authenticated')
$$;

create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_active
  )
$$;

create or replace function app.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.is_super_admin
  )
$$;

-- The current user's role in a company (null = no active access).
create or replace function app.company_role(p_company_id uuid) returns public.app_role
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id and p.is_active
  join public.companies c on c.id = m.company_id and c.is_active
  where m.company_id = p_company_id and m.user_id = auth.uid() and m.is_active
$$;

create or replace function app.has_company_access(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or app.company_role(p_company_id) is not null
$$;

create or replace function app.has_company_role(p_company_id uuid, p_roles public.app_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or coalesce(app.company_role(p_company_id) = any (p_roles), false)
$$;

create or replace function app.is_company_admin(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_company_role(p_company_id, array['company_admin']::public.app_role[])
$$;

-- Company admin, sales manager or super admin.
create or replace function app.is_company_manager(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_company_role(p_company_id, array['company_admin', 'sales_manager']::public.app_role[])
$$;

-- Companies the current user can access (super admin: all active companies).
create or replace function app.accessible_company_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.companies c
  where app.is_super_admin()
  union
  select m.company_id
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id and p.is_active
  join public.companies c on c.id = m.company_id and c.is_active
  where m.user_id = auth.uid() and m.is_active
$$;

-- Does the current user manage `p_user_id` within the company?
-- Super admins and company admins manage everyone in the company. Sales
-- managers manage members of active teams whose manager_id is them.
create or replace function app.manages_user(p_company_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    app.is_company_admin(p_company_id)
    or (
      app.company_role(p_company_id) = 'sales_manager'
      and exists (
        select 1
        from public.teams t
        join public.team_memberships tm on tm.team_id = t.id
        where t.company_id = p_company_id and t.is_active
          and t.manager_id = auth.uid() and tm.user_id = p_user_id
      )
    )
  )
$$;

create or replace function app.manages_team(p_company_id uuid, p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_team_id is not null and (
    app.is_company_admin(p_company_id)
    or (
      app.company_role(p_company_id) = 'sales_manager'
      and exists (
        select 1 from public.teams t
        where t.id = p_team_id and t.company_id = p_company_id
          and t.is_active and t.manager_id = auth.uid()
      )
    )
  )
$$;

-- Is `p_user_id` an active member of the company (any role)?
create or replace function app.is_company_member(p_company_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.company_memberships m
    join public.profiles p on p.id = m.user_id and p.is_active
    where m.company_id = p_company_id and m.user_id = p_user_id and m.is_active
  )
$$;

-- -----------------------------------------------------------------------------
-- Row-scope rules. Documented in docs/SECURITY.md (Access matrix).
-- -----------------------------------------------------------------------------

-- Leads and deals share one ownership rule:
--   company admin / super admin : every record in the company
--   sales manager               : unassigned records, own records, records owned
--                                 by members of teams they manage, records in a
--                                 team they manage
--   sales agent / cs agent      : records they own, or created and nobody owns yet
create or replace function app.can_see_owned_record(
  p_company_id uuid, p_owner_id uuid, p_team_id uuid, p_created_by uuid
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role;
begin
  if v_uid is null then return false; end if;
  if app.is_super_admin() then return true; end if;
  v_role := app.company_role(p_company_id);
  if v_role is null then return false; end if;
  if v_role = 'company_admin' then return true; end if;
  if p_owner_id = v_uid then return true; end if;
  if p_owner_id is null and p_created_by = v_uid then return true; end if;
  if v_role = 'sales_manager' then
    return p_owner_id is null
        or app.manages_user(p_company_id, p_owner_id)
        or app.manages_team(p_company_id, p_team_id);
  end if;
  return false;
end $$;

create or replace function app.can_access_lead(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select app.can_see_owned_record(l.company_id, l.owner_id, l.team_id, l.created_by)
    from public.leads l where l.id = p_lead_id
  ), false)
$$;

create or replace function app.can_access_deal(p_deal_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select app.can_see_owned_record(d.company_id, d.owner_id, null, d.created_by)
    from public.deals d where d.id = p_deal_id
  ), false)
$$;

-- Tasks: assignee, creator, or someone who manages the assignee.
create or replace function app.can_see_task(
  p_company_id uuid, p_assigned_to uuid, p_created_by uuid
) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.has_company_access(p_company_id) and (
    p_assigned_to = auth.uid()
    or p_created_by = auth.uid()
    or app.is_company_admin(p_company_id)
    or app.manages_user(p_company_id, p_assigned_to)
    or (p_assigned_to is null and app.is_company_manager(p_company_id))
  )
$$;

-- Activities: own activities, activities by people you manage, or activities
-- on a lead/deal you can access.
create or replace function app.can_see_activity(
  p_company_id uuid, p_actor_id uuid, p_lead_id uuid, p_deal_id uuid
) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.has_company_access(p_company_id) and (
    p_actor_id = auth.uid()
    or app.manages_user(p_company_id, p_actor_id)
    or (p_lead_id is not null and app.can_access_lead(p_lead_id))
    or (p_deal_id is not null and app.can_access_deal(p_deal_id))
  )
$$;

-- WhatsApp: explicit per-number grants.
create or replace function app.has_wa_account_access(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or exists (
    select 1 from public.whatsapp_account_access a
    where a.whatsapp_account_id = p_account_id and a.user_id = auth.uid()
  ) and app.is_active_user()
$$;

-- Conversations:
--   super admin                          : all
--   company admin of the conversation's company : all of that company
--   other company members with a grant on the number:
--       sales manager : all conversations on the number for that company
--       agents        : conversations they own, plus unassigned ones (to claim)
create or replace function app.can_see_conversation_row(
  p_company_id uuid, p_account_id uuid, p_owner_id uuid
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role public.app_role;
begin
  if auth.uid() is null then return false; end if;
  if app.is_super_admin() then return true; end if;
  v_role := app.company_role(p_company_id);
  if v_role is null then return false; end if;
  if v_role = 'company_admin' then return true; end if;
  if not app.has_wa_account_access(p_account_id) then return false; end if;
  if v_role = 'sales_manager' then return true; end if;
  return p_owner_id is null or p_owner_id = auth.uid();
end $$;

create or replace function app.can_access_conversation(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select app.can_see_conversation_row(c.company_id, c.whatsapp_account_id, c.owner_id)
    from public.conversations c where c.id = p_conversation_id
  ), false)
$$;

-- Contacts: identity is visible to company admins/managers of any linked
-- company. Agents see only contacts they are working with.
create or replace function app.can_see_contact(p_contact_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    app.is_super_admin()
    or exists (
      select 1 from public.contacts c
      where c.id = p_contact_id and c.created_by = auth.uid() and app.is_active_user()
    )
    or exists (
      select 1 from public.contact_companies cc
      where cc.contact_id = p_contact_id
        and (app.is_company_manager(cc.company_id)
             or (cc.owner_id = auth.uid() and app.has_company_access(cc.company_id)))
    )
    or exists (
      select 1 from public.leads l
      where l.contact_id = p_contact_id
        and app.can_see_owned_record(l.company_id, l.owner_id, l.team_id, l.created_by)
    )
    or exists (
      select 1 from public.deals d
      where d.contact_id = p_contact_id
        and app.can_see_owned_record(d.company_id, d.owner_id, null, d.created_by)
    )
    or exists (
      select 1 from public.conversations cv
      where cv.contact_id = p_contact_id
        and app.can_see_conversation_row(cv.company_id, cv.whatsapp_account_id, cv.owner_id)
    )
  )
$$;

create or replace function app.can_access_entity(p_entity_type text, p_entity_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_entity_type
    when 'lead' then app.can_access_lead(p_entity_id)
    when 'deal' then app.can_access_deal(p_entity_id)
    when 'contact' then app.can_see_contact(p_entity_id)
    when 'conversation' then app.can_access_conversation(p_entity_id)
    when 'task' then coalesce((
      select app.can_see_task(t.company_id, t.assigned_to, t.created_by)
      from public.tasks t where t.id = p_entity_id), false)
    else false
  end
$$;

-- Performance / login data about another user.
create or replace function app.can_view_user_performance(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id = auth.uid() or app.is_super_admin() or exists (
    select 1 from public.company_memberships m
    where m.user_id = p_user_id and m.is_active
      and app.manages_user(m.company_id, p_user_id)
  )
$$;

-- Does the current user share at least one company with `p_user_id`?
create or replace function app.shares_company_with(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.company_memberships mine
    join public.company_memberships theirs on theirs.company_id = mine.company_id
    where mine.user_id = auth.uid() and mine.is_active and theirs.user_id = p_user_id
  ) and app.is_active_user()
$$;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;
