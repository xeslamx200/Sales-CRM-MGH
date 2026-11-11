-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000991 - Company display settings controlled by the company admin from the CRM (instead of a code change): which menu items are hidden and
-- which dashboard the company sees (standard = deals and pipeline, workshop = revenue from bookings and payments).
-- Purely additive: one table and one setter. A company WITHOUT a row keeps the previous behaviour (the application falls back to its built-in default),
-- so applying this migration changes nothing until an admin saves the settings.
--  * company_ui_settings: one row per company. Every member of the company can read it (the menu needs it); nobody writes it directly.
--  * set_company_ui_settings: company admins (and super admins) only; validates the menu list against an allow-list (Dashboard, Inbox, Reports and the
--    administration pages can never be hidden) and the dashboard mode; audited ('company.ui_settings_set').
-- Hiding a menu item only hides the MENU entry: pages and data stay, and the other companies are unaffected.
-- Rollback: supabase/proposed/rollbacks/20261104000991_company_ui_settings.rollback.sql (refuses while any row exists)

create table public.company_ui_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  hidden_nav text[] not null default '{}' check (hidden_nav <@ array['/deals', '/leads', '/tasks', '/performance', '/workshops', '/bookings']::text[]),
  dashboard_mode text not null default 'standard' check (dashboard_mode in ('standard', 'workshop')),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.company_ui_settings enable row level security;
revoke all on public.company_ui_settings from public, anon, authenticated;
grant select on public.company_ui_settings to authenticated;
grant all on public.company_ui_settings to service_role;
create policy company_ui_settings_select on public.company_ui_settings for select to authenticated using (app.has_company_access(company_id));

create or replace function public.set_company_ui_settings(p_company_id uuid, p_hidden_nav text[], p_dashboard_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_nav text[]; v_mode text := lower(btrim(coalesce(p_dashboard_mode, '')));
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_nav from unnest(coalesce(p_hidden_nav, '{}')) x;
  if not (v_nav <@ array['/deals', '/leads', '/tasks', '/performance', '/workshops', '/bookings']::text[]) then raise exception 'settings.invalid_menu' using errcode = '23514'; end if;
  if v_mode not in ('standard', 'workshop') then raise exception 'settings.invalid_dashboard' using errcode = '23514'; end if;
  insert into public.company_ui_settings (company_id, hidden_nav, dashboard_mode, updated_by) values (p_company_id, v_nav, v_mode, auth.uid())
  on conflict (company_id) do update set hidden_nav = excluded.hidden_nav, dashboard_mode = excluded.dashboard_mode, updated_by = excluded.updated_by, updated_at = now();
  perform app.write_audit(p_company_id, 'company.ui_settings_set', 'company', p_company_id, jsonb_build_object('hidden_nav', to_jsonb(v_nav), 'dashboard_mode', v_mode));
end $$;

revoke all on function public.set_company_ui_settings(uuid, text[], text) from public, anon;
grant execute on function public.set_company_ui_settings(uuid, text[], text) to authenticated, service_role;
