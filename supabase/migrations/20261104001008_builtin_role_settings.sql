-- 20261104001008 - The built-in roles (sales manager, sales agent, customer service) can be edited per company, like the custom roles of 1006.
--
-- company_builtin_roles holds, for one company and one built-in role, the pages hidden from everyone who has that role and the actions switched off for
-- them (same keys and same meaning as company_roles.hidden_nav / permissions). No row = nothing restricted (today's behaviour). The company admin role
-- cannot be restricted (a CHECK refuses it): somebody must always be able to manage the company. Restrictions only TAKE AWAY, as for custom roles; a
-- person with a custom role gets the built-in role's restrictions plus the custom role's own. Data access is still decided by the base role's row-level
-- security rules, unchanged.
-- Read: members of the company (the application needs it to build their menu). Written only by save_builtin_role (company admin of that company).
-- Rollback: supabase/rollbacks/20261104001008_builtin_role_settings.rollback.sql

create table public.company_builtin_roles (
  company_id uuid not null references public.companies (id) on delete cascade,
  role public.app_role not null check (role <> 'company_admin'),
  hidden_nav text[] not null default '{}' check (cardinality(hidden_nav) <= 20),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, role)
);
alter table public.company_builtin_roles enable row level security;
revoke all on public.company_builtin_roles from public, anon, authenticated;
grant select on public.company_builtin_roles to authenticated;
grant all on public.company_builtin_roles to service_role;
create policy company_builtin_roles_select on public.company_builtin_roles for select to authenticated using (app.has_company_access(company_id));

create or replace function public.save_builtin_role(p_company_id uuid, p_role public.app_role, p_hidden_nav text[], p_permissions jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_nav text[] := coalesce((select array_agg(distinct x order by x) from unnest(coalesce(p_hidden_nav, '{}')) x), '{}');
  v_allowed_nav text[] := array['/inbox', '/leads', '/contacts', '/bookings', '/workshops', '/performance', '/tasks', '/reports'];
  v_allowed_perm text[] := array['send_messages', 'create_leads', 'import_leads', 'create_bookings', 'record_payments', 'export_data'];
  v_perm jsonb := '{}'::jsonb; k text; v jsonb;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_role is null or p_role = 'company_admin' then raise exception 'role.invalid' using errcode = '23514'; end if;
  if exists (select 1 from unnest(v_nav) x where x <> all (v_allowed_nav)) then raise exception 'role.invalid' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_permissions, '{}'::jsonb)) <> 'object' then raise exception 'role.invalid' using errcode = '23514'; end if;
  for k, v in select * from jsonb_each(coalesce(p_permissions, '{}'::jsonb)) loop
    if k <> all (v_allowed_perm) or jsonb_typeof(v) <> 'boolean' then raise exception 'role.invalid' using errcode = '23514'; end if;
    if v = 'false'::jsonb then v_perm := v_perm || jsonb_build_object(k, false); end if;   -- only the denials are stored
  end loop;
  if cardinality(v_nav) = 0 and v_perm = '{}'::jsonb then
    delete from public.company_builtin_roles where company_id = p_company_id and role = p_role;   -- back to "nothing restricted"
  else
    insert into public.company_builtin_roles (company_id, role, hidden_nav, permissions, updated_by)
    values (p_company_id, p_role, v_nav, v_perm, auth.uid())
    on conflict (company_id, role) do update set hidden_nav = excluded.hidden_nav, permissions = excluded.permissions, updated_by = auth.uid(), updated_at = now();
  end if;
  perform app.write_audit(p_company_id, 'role.builtin_saved', 'company_builtin_role', null,
    jsonb_build_object('role', p_role, 'hidden_nav', v_nav, 'denied', v_perm));
end $$;

revoke all on function public.save_builtin_role(uuid, public.app_role, text[], jsonb) from public, anon;
grant execute on function public.save_builtin_role(uuid, public.app_role, text[], jsonb) to authenticated, service_role;
