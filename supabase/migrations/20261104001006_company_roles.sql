-- 20261104001006 - Custom roles: a company admin adds roles of their own, picks what each one may do and which pages it sees.
--
-- A custom role sits ON TOP of one of the built-in roles (its base role: sales manager, sales agent or customer service). The base role keeps deciding
-- WHICH DATA a person can reach (every row-level security rule is unchanged); the custom role can only take things AWAY from it:
--   * hidden_nav   : pages hidden from the menu and refused when opened (inbox, leads, contacts, bookings, workshops, performance, tasks, reports)
--   * permissions  : switches ({"send_messages": false, ...}); a key that is absent or true = allowed. Keys: send_messages, create_leads, import_leads,
--                    create_bookings, record_payments, export_data. The application enforces them in its pages and actions.
-- It never grants more than the base role (and a company admin cannot be given a custom role).
--
-- company_roles is read by the members of the company and written only through save_company_role / delete_company_role (company admin of that company,
-- or super admin). A membership points at its custom role (company_memberships.custom_role_id); a trigger keeps membership.role equal to the role's
-- base role and refuses a role of another company. Deleting a role that people still use is refused.
-- Rollback: supabase/rollbacks/20261104001006_company_roles.rollback.sql

create table public.company_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  base_role public.app_role not null check (base_role <> 'company_admin'),
  hidden_nav text[] not null default '{}' check (cardinality(hidden_nav) <= 20),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index company_roles_name_uidx on public.company_roles (company_id, lower(btrim(name)));
alter table public.company_roles enable row level security;
revoke all on public.company_roles from public, anon, authenticated;
grant select on public.company_roles to authenticated;
grant all on public.company_roles to service_role;
create policy company_roles_select on public.company_roles for select to authenticated using (app.has_company_access(company_id));

alter table public.company_memberships add column custom_role_id uuid references public.company_roles (id) on delete restrict;
create index company_memberships_custom_role_idx on public.company_memberships (custom_role_id) where custom_role_id is not null;

create or replace function app.sync_membership_custom_role() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.company_roles;
begin
  if new.custom_role_id is null then return new; end if;
  select * into r from public.company_roles where id = new.custom_role_id;
  if not found or r.company_id <> new.company_id then raise exception 'role.invalid_custom_role' using errcode = '23514'; end if;
  new.role := r.base_role;   -- the base role decides the data; the custom role only restricts the application
  return new;
end $$;
-- named so that it runs before memberships_guard (triggers fire in name order): the guard then sees the final role
create trigger memberships_a_custom_role before insert or update on public.company_memberships
  for each row execute function app.sync_membership_custom_role();

create or replace function public.save_company_role(p_id uuid, p_company_id uuid, p_name text, p_base_role public.app_role, p_hidden_nav text[], p_permissions jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_name text := btrim(coalesce(p_name, ''));
  v_nav text[] := coalesce((select array_agg(distinct x order by x) from unnest(coalesce(p_hidden_nav, '{}')) x), '{}');
  v_allowed_nav text[] := array['/inbox', '/leads', '/contacts', '/bookings', '/workshops', '/performance', '/tasks', '/reports'];
  v_allowed_perm text[] := array['send_messages', 'create_leads', 'import_leads', 'create_bookings', 'record_payments', 'export_data'];
  v_perm jsonb := '{}'::jsonb; k text; v jsonb;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 60 or p_base_role is null or p_base_role = 'company_admin' then raise exception 'role.invalid' using errcode = '23514'; end if;
  if exists (select 1 from unnest(v_nav) x where x <> all (v_allowed_nav)) then raise exception 'role.invalid' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_permissions, '{}'::jsonb)) <> 'object' then raise exception 'role.invalid' using errcode = '23514'; end if;
  for k, v in select * from jsonb_each(coalesce(p_permissions, '{}'::jsonb)) loop
    if k <> all (v_allowed_perm) or jsonb_typeof(v) <> 'boolean' then raise exception 'role.invalid' using errcode = '23514'; end if;
    if v = 'false'::jsonb then v_perm := v_perm || jsonb_build_object(k, false); end if;   -- only the denials are stored
  end loop;
  if p_id is null then
    insert into public.company_roles (company_id, name, base_role, hidden_nav, permissions, created_by)
    values (p_company_id, v_name, p_base_role, v_nav, v_perm, auth.uid()) returning id into v_id;
  else
    update public.company_roles set name = v_name, base_role = p_base_role, hidden_nav = v_nav, permissions = v_perm, updated_at = now()
    where id = p_id and company_id = p_company_id returning id into v_id;
    if v_id is null then raise exception 'role.not_found' using errcode = 'P0002'; end if;
    -- people with this role follow its base role
    update public.company_memberships set role = p_base_role where custom_role_id = v_id and role <> p_base_role;
  end if;
  perform app.write_audit(p_company_id, 'role.saved', 'company_role', v_id,
    jsonb_build_object('name', v_name, 'base_role', p_base_role, 'hidden_nav', v_nav, 'denied', v_perm));
  return v_id;
exception when unique_violation then
  raise exception 'role.name_taken' using errcode = '23505';
end $$;

create or replace function public.delete_company_role(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.company_roles;
begin
  select * into r from public.company_roles where id = p_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.is_company_admin(r.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.company_memberships m where m.custom_role_id = p_id) then raise exception 'role.in_use' using errcode = '23514'; end if;
  delete from public.company_roles where id = p_id;
  perform app.write_audit(r.company_id, 'role.deleted', 'company_role', p_id, jsonb_build_object('name', r.name));
end $$;

revoke all on function public.save_company_role(uuid, uuid, text, public.app_role, text[], jsonb), public.delete_company_role(uuid), app.sync_membership_custom_role() from public, anon;
grant execute on function public.save_company_role(uuid, uuid, text, public.app_role, text[], jsonb), public.delete_company_role(uuid) to authenticated, service_role;
