-- Dashboard widget visibility (proposed migration 996). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 970..996 + _helpers.sql + _fixtures.sql> -f supabase/tests/db_proposed/33_dashboard_widgets.sql
begin;
select tests.logout();
select tests.eq((select count(*) from public.company_ui_settings where cardinality(hidden_widgets) > 0), 0::bigint, 'a fresh database hides nothing (applying the migration changes nothing)');

select tests.login('agent_a1');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'standard', array['targets'])$q$, 'auth.forbidden', 'an agent cannot change the dashboard');
select tests.login('mgr_a');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'standard', array['targets'])$q$, 'auth.forbidden', 'a sales manager cannot (admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'standard', array['targets'])$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'standard', array['kpi_tiles'])$q$, 'settings.invalid_widget', 'the headline figures cannot be hidden / unknown widget refused');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'standard', array['targets; drop table x'])$q$, 'settings.invalid_widget', 'an injection attempt is just an unknown widget');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), array['/admin/users'], 'standard', '{}')$q$, 'settings.invalid_menu', 'the menu rules of 991 still apply');
select tests.throws($q$select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'fancy', '{}')$q$, 'settings.invalid_dashboard', 'unknown dashboard mode refused');
select tests.eq((select count(*) from public.company_ui_settings), 0::bigint, 'failed attempts stored nothing');

select public.set_company_ui_settings_v2(tests.ref('alpha'), array['/tasks'], 'workshop', array['targets', 'goal', 'targets']);
select tests.eq((select hidden_widgets::text || ' ' || hidden_nav::text || ' ' || dashboard_mode from public.company_ui_settings where company_id = tests.ref('alpha')), '{goal,targets} {/tasks} workshop', 'saved: sorted, duplicates removed');
select public.set_company_ui_settings_v2(tests.ref('alpha'), null, 'standard', null);
select tests.eq((select hidden_widgets::text || ' ' || hidden_nav::text from public.company_ui_settings where company_id = tests.ref('alpha')), '{} {}', 'null means nothing hidden');
select public.set_company_ui_settings_v2(tests.ref('alpha'), '{}', 'workshop', array['whatsapp_load']);
-- the 991 setter is untouched and leaves the widgets alone
select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'workshop');
select tests.eq((select hidden_widgets::text from public.company_ui_settings where company_id = tests.ref('alpha')), '{whatsapp_load}', 'the old setter does not touch the widgets');
select tests.eq((select count(*) from public.audit_logs where action = 'company.ui_settings_set' and company_id = tests.ref('alpha') and metadata ? 'hidden_widgets'), 3::bigint, 'every v2 save is audited with the widgets');

select tests.login('agent_a1');
select tests.eq((select hidden_widgets::text from public.company_ui_settings where company_id = tests.ref('alpha')), '{whatsapp_load}', 'an employee of the company can read it (the dashboard needs it)');
select tests.login('admin_b');
select tests.eq((select count(*) from public.company_ui_settings), 0::bigint, 'another company cannot read it');
select tests.logout();
rollback;
