-- Company display settings (proposed migration 991). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..991 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/31_company_ui_settings.sql
begin;
select tests.logout();
select tests.eq((select count(*) from public.company_ui_settings), 0::bigint, 'a fresh database has no settings (applying the migration changes nothing)');

select tests.login('agent_a1');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'standard')$q$, 'auth.forbidden', 'an agent cannot change the settings');
select tests.login('mgr_a');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'standard')$q$, 'auth.forbidden', 'a sales manager cannot (admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'standard')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/admin/users'], 'standard')$q$, 'settings.invalid_menu', 'administration pages can never be hidden');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/'], 'standard')$q$, 'settings.invalid_menu', 'the dashboard cannot be hidden');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/reports'], 'standard')$q$, 'settings.invalid_menu', 'reports cannot be hidden');
select tests.throws($q$select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'fancy')$q$, 'settings.invalid_dashboard', 'unknown dashboard mode refused');
select tests.throws($q$insert into public.company_ui_settings (company_id) values (tests.ref('alpha'))$q$, 'permission denied', 'no direct write');
select tests.eq((select count(*) from public.company_ui_settings), 0::bigint, 'failed attempts stored nothing');
select public.set_company_ui_settings(tests.ref('alpha'), array['/tasks', '/deals', '/deals'], 'workshop');
select tests.eq((select hidden_nav::text || ' ' || dashboard_mode from public.company_ui_settings where company_id = tests.ref('alpha')), '{/deals,/tasks} workshop', 'saved sorted and de-duplicated');
select public.set_company_ui_settings(tests.ref('alpha'), null, 'standard');
select tests.eq((select hidden_nav::text || ' ' || dashboard_mode from public.company_ui_settings where company_id = tests.ref('alpha')), '{} standard', 'saving again replaces it (nothing hidden, null list = none)');
select tests.eq((select count(*) from public.company_ui_settings), 1::bigint, 'one row per company');
select public.set_company_ui_settings(tests.ref('alpha'), array['/deals'], 'workshop');
select tests.eq((select count(*) from public.audit_logs where action = 'company.ui_settings_set' and company_id = tests.ref('alpha')), 3::bigint, 'every save is audited');

-- who can read it
select tests.login('agent_a1');
select tests.eq((select count(*) from public.company_ui_settings), 1::bigint, 'an employee of the company can read it (the menu needs it)');
select tests.login('admin_b');
select tests.eq((select count(*) from public.company_ui_settings), 0::bigint, 'another company cannot read it');
select tests.login_anon();
select tests.throws($q$select * from public.company_ui_settings$q$, 'permission denied', 'anonymous cannot read it');
select tests.logout();
rollback;
