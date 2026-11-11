-- =============================================================================
-- 0720 — Hardening after security review.
--
-- 1. Team membership is managed by company admins only (brief §6: company
--    admins manage team members; sales managers view their teams). Before,
--    a sales manager could add any colleague — including a company admin —
--    to their own team and thereby gain visibility of that person's records.
--    Changes are now audited.
-- 2. A contact's phone number is the cross-company identity key (dedup and
--    WhatsApp matching). Changing it now requires managing every company the
--    contact is linked to.
-- =============================================================================

drop policy if exists team_memberships_insert on public.team_memberships;
drop policy if exists team_memberships_delete on public.team_memberships;
create policy team_memberships_insert on public.team_memberships for insert to authenticated
  with check (app.is_company_admin(company_id));
create policy team_memberships_delete on public.team_memberships for delete to authenticated
  using (app.is_company_admin(company_id));

-- Defense in depth: managers never "manage" a company admin via a team.
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
        join public.company_memberships m on m.company_id = t.company_id and m.user_id = tm.user_id
        where t.company_id = p_company_id and t.is_active
          and t.manager_id = auth.uid() and tm.user_id = p_user_id
          and m.is_active and m.role in ('sales_agent', 'cs_agent')
      )
    )
  )
$$;

create or replace function app.audit_team_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.company_id, 'team.member_added', 'team', new.team_id,
      jsonb_build_object('user_id', new.user_id));
  else
    perform app.write_audit(old.company_id, 'team.member_removed', 'team', old.team_id,
      jsonb_build_object('user_id', old.user_id));
  end if;
  return null;
end $$;
create trigger team_memberships_audit after insert or delete on public.team_memberships
  for each row execute function app.audit_team_membership();

create or replace function app.audit_team() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.manager_id is distinct from old.manager_id or new.is_active is distinct from old.is_active then
    perform app.write_audit(new.company_id, case when tg_op = 'INSERT' then 'team.created' else 'team.updated' end,
      'team', new.id, jsonb_build_object('manager_id', new.manager_id, 'is_active', new.is_active));
  end if;
  return null;
end $$;
create trigger teams_audit after insert or update on public.teams
  for each row execute function app.audit_team();

-- Phone number = identity key across companies.
-- SECURITY DEFINER: the check must see links to companies the caller cannot
-- see (as the caller, RLS would hide them and the check would pass).
create or replace function app.guard_contact_phone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.phone_e164 is distinct from old.phone_e164
     and not app.is_service_context()
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on'
     and not app.is_super_admin()
     and (
       not exists (select 1 from public.contact_companies cc where cc.contact_id = new.id)
       or exists (select 1 from public.contact_companies cc
                  where cc.contact_id = new.id and not app.is_company_manager(cc.company_id))
     ) then
    raise exception 'contact.phone_change_requires_manager' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger contacts_phone_guard before update of phone_e164 on public.contacts
  for each row execute function app.guard_contact_phone();

-- Whether a user holds a grant on a WhatsApp number — readable regardless of
-- the caller's own visibility of grant rows.
create or replace function app.user_has_wa_access(p_account_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.whatsapp_account_access a
                 where a.whatsapp_account_id = p_account_id and a.user_id = p_user_id)
$$;

-- Same fix for conversation assignment: a sales manager must be able to
-- assign to an agent whose grant row they cannot read themselves.
create or replace function app.guard_conversation() returns trigger
language plpgsql as $$
declare
  v_service boolean := app.is_service_context() or app.in_system_op();
begin
  if (new.whatsapp_account_id, new.customer_wa_id, new.is_simulated, new.created_at)
     is distinct from (old.whatsapp_account_id, old.customer_wa_id, old.is_simulated, old.created_at) then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if v_service then return new; end if;

  if new.contact_id is distinct from old.contact_id
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if (new.last_message_at, new.last_inbound_at, new.last_outbound_at)
     is distinct from (old.last_message_at, old.last_inbound_at, old.last_outbound_at) then
    raise exception 'conversation.system_field' using errcode = '42501';
  end if;
  if new.unread_count is distinct from old.unread_count and new.unread_count <> 0 then
    raise exception 'conversation.unread_can_only_be_cleared' using errcode = '42501';
  end if;
  if new.company_id is distinct from old.company_id
     and not (app.is_company_manager(old.company_id) and app.is_company_manager(new.company_id)) then
    raise exception 'conversation.company_change_forbidden' using errcode = '42501';
  end if;
  if new.owner_id is distinct from old.owner_id then
    if new.owner_id is not null and not (
      app.is_company_member(new.company_id, new.owner_id)
      and app.user_has_wa_access(new.whatsapp_account_id, new.owner_id)
    ) then
      raise exception 'conversation.owner_needs_number_access' using errcode = '23514';
    end if;
    if not (
      app.is_company_manager(new.company_id)
      or (old.owner_id is null and new.owner_id = auth.uid() and app.has_wa_account_access(new.whatsapp_account_id))
      or (old.owner_id = auth.uid() and new.owner_id is null)
    ) then
      raise exception 'conversation.assign_forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

revoke all on function app.audit_team_membership(), app.audit_team() from public, anon, authenticated, service_role;
revoke all on function app.manages_user(uuid, uuid), app.guard_contact_phone(),
  app.user_has_wa_access(uuid, uuid), app.guard_conversation() from public, anon;
grant execute on function app.manages_user(uuid, uuid), app.guard_contact_phone(),
  app.user_has_wa_access(uuid, uuid), app.guard_conversation() to authenticated, service_role;
