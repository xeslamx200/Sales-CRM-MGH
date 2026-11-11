-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only after 20261104000995 and only with explicit approval; psql -1.
-- 20261104000996 - The company admin chooses which dashboard sections the company sees (from the CRM, not from the code).
-- Additive: one column on company_ui_settings and one new setter. The existing setter (991) is untouched and keeps working; it simply leaves the new
-- column as it is. A company without a row, or with an empty list, sees every section exactly as before, so applying this changes nothing until an
-- admin saves the settings.
--  * company_ui_settings.hidden_widgets: the sections that are hidden for the company (allow-listed below). The four headline figures of the
--    dashboard and the page header are never hideable.
--  * set_company_ui_settings_v2(company, hidden_nav, dashboard_mode, hidden_widgets): same rules as 991 (company admins and super admins only,
--    allow-lists, audited as 'company.ui_settings_set' with the widgets included).
-- Hiding a section only hides it on the dashboard: the data, the reports and the other companies are unaffected.
-- Rollback: supabase/proposed/rollbacks/20261104000996_dashboard_widgets.rollback.sql (refuses while any company has hidden sections).

alter table public.company_ui_settings
  add column hidden_widgets text[] not null default '{}'
  check (hidden_widgets <@ array['revenue_chart', 'workshop_share', 'latest_bookings', 'top_workshops', 'goal', 'leads_per_day', 'response_speed', 'targets', 'whatsapp_load']::text[]);

create or replace function public.set_company_ui_settings_v2(p_company_id uuid, p_hidden_nav text[], p_dashboard_mode text, p_hidden_widgets text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_nav text[]; v_wid text[]; v_mode text := lower(btrim(coalesce(p_dashboard_mode, '')));
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_nav from unnest(coalesce(p_hidden_nav, '{}')) x;
  select coalesce(array_agg(distinct x order by x), '{}') into v_wid from unnest(coalesce(p_hidden_widgets, '{}')) x;
  if not (v_nav <@ array['/deals', '/leads', '/tasks', '/performance', '/workshops', '/bookings']::text[]) then raise exception 'settings.invalid_menu' using errcode = '23514'; end if;
  if not (v_wid <@ array['revenue_chart', 'workshop_share', 'latest_bookings', 'top_workshops', 'goal', 'leads_per_day', 'response_speed', 'targets', 'whatsapp_load']::text[]) then
    raise exception 'settings.invalid_widget' using errcode = '23514';
  end if;
  if v_mode not in ('standard', 'workshop') then raise exception 'settings.invalid_dashboard' using errcode = '23514'; end if;
  insert into public.company_ui_settings (company_id, hidden_nav, dashboard_mode, hidden_widgets, updated_by) values (p_company_id, v_nav, v_mode, v_wid, auth.uid())
  on conflict (company_id) do update set hidden_nav = excluded.hidden_nav, dashboard_mode = excluded.dashboard_mode, hidden_widgets = excluded.hidden_widgets,
    updated_by = excluded.updated_by, updated_at = now();
  perform app.write_audit(p_company_id, 'company.ui_settings_set', 'company', p_company_id,
    jsonb_build_object('hidden_nav', to_jsonb(v_nav), 'dashboard_mode', v_mode, 'hidden_widgets', to_jsonb(v_wid)));
end $$;

revoke all on function public.set_company_ui_settings_v2(uuid, text[], text, text[]) from public, anon;
grant execute on function public.set_company_ui_settings_v2(uuid, text[], text, text[]) to authenticated, service_role;
