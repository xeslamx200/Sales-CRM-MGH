-- Workshop price matrix and groups (proposed migration 984). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..984 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/24_workshop_pricing_groups.sql
begin;
select tests.logout();
do $$
declare w1 uuid; w2 uuid; wb uuid;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Price W1', 'workshop') returning id into w1;
  insert into public.company_offerings (company_id, name, kind, is_active) values (tests.ref('alpha'), 'Price W2 (inactive)', 'workshop', false) returning id into w2;
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('beta'), 'Price WB', 'workshop') returning id into wb;
  insert into tests.refs values ('pw1', w1), ('pw2', w2), ('pwb', wb);
end $$;

-- who may set prices ----------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 500)$q$, 'auth.forbidden', 'an agent cannot set prices');
select tests.login('mgr_a');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 500)$q$, 'auth.forbidden', 'a sales manager cannot (admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 500)$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login_anon();
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 500)$q$, 'permission denied', 'anonymous refused');

-- validation ---------------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QAT', 'online', 'QAR', 500)$q$, 'price.invalid_value', 'country must be 2 letters');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'hybrid', 'QAR', 500)$q$, 'price.invalid_value', 'attendance is online or offline');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QR', 500)$q$, 'price.invalid_value', 'currency is a 3-letter code');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 0)$q$, 'price.invalid_value', 'zero refused');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', -5)$q$, 'price.invalid_value', 'negative refused');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 10.123)$q$, 'price.invalid_value', 'more than 2 decimals refused');
select tests.throws($q$select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', null)$q$, 'price.not_found', 'deactivating a price that was never set is refused');
select tests.eq((select count(*) from public.workshop_prices), 0::bigint, 'failed attempts changed nothing');

-- set, change, deactivate, reactivate ------------------------------------------------------------------------------------------------------
select tests.eq((select count(*) from public.workshop_price_for(tests.ref('pw1'), 'QA', 'online')), 0::bigint, 'before anything is set the price is NOT configured (nothing is assumed)');
select public.set_workshop_price(tests.ref('pw1'), ' qa ', 'ONLINE', 'qar', 500);
select tests.eq((select price || ' ' || currency from public.workshop_price_for(tests.ref('pw1'), 'QA', 'online')), '500.00 QAR', 'the price is stored normalized (QA / online / QAR)');
select tests.eq((select count(*) from public.workshop_price_for(tests.ref('pw1'), 'QA', 'offline')), 0::bigint, 'the unspecified offline combination is still not configured');
select tests.eq((select count(*) from public.workshop_price_for(tests.ref('pw1'), 'SA', 'online')), 0::bigint, 'and so is another country (no conversion, no default)');
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 500);
select tests.eq((select count(*) from public.workshop_price_history), 1::bigint, 'setting the same value again writes no history');
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 550);
select tests.eq((select old_price || '>' || new_price from public.workshop_price_history order by id desc limit 1), '500.00>550.00', 'a change records the old and the new price');
select tests.eq((select count(*) from public.workshop_prices), 1::bigint, 'still one price row (history keeps the past)');
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', null);
select tests.eq((select count(*) from public.workshop_price_for(tests.ref('pw1'), 'QA', 'online')), 0::bigint, 'a deactivated price is not offered');
select tests.eq((select new_active from public.workshop_price_history order by id desc limit 1), false, 'deactivation is in the history');
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', null);
select tests.eq((select count(*) from public.workshop_price_history), 3::bigint, 'deactivating twice writes no extra history');
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'online', 'QAR', 600);
select tests.eq((select price from public.workshop_price_for(tests.ref('pw1'), 'QA', 'online')), 600::numeric, 'reactivated at a new price');
select tests.eq((select count(*) from public.workshop_price_history), 4::bigint, 'four history rows: create, change, deactivate, reactivate');
select tests.eq((select count(distinct changed_by) from public.workshop_price_history), 1::bigint, 'history records who changed it');
select public.set_workshop_price(tests.ref('pw1'), 'EG', 'online', 'EGP', 2500);
select public.set_workshop_price(tests.ref('pw1'), 'QA', 'offline', 'QAR', 750);
select tests.eq((select count(*) from public.workshop_prices where offering_id = tests.ref('pw1') and is_active), 3::bigint, 'three configured combinations');

-- history and tables are not writable directly -----------------------------------------------------------------------------------------
select tests.throws($q$insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values (tests.ref('alpha'), tests.ref('pw1'), 'SA', 'online', 'SAR', 1)$q$, 'permission denied', 'no direct insert');
select tests.throws($q$update public.workshop_prices set price = 1$q$, 'permission denied', 'no direct update');
select tests.throws($q$delete from public.workshop_price_history$q$, 'permission denied', 'no direct delete of history');
select tests.logout();
select tests.throws($q$update public.workshop_price_history set new_price = 1$q$, 'price.history_immutable', 'history cannot be edited even by the owner role');
select tests.throws($q$delete from public.workshop_price_history$q$, 'price.history_immutable', 'nor deleted');
select tests.throws($q$truncate public.workshop_price_history$q$, 'price.history_immutable', 'nor truncated');

-- visibility -------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select price from public.workshop_price_for(tests.ref('pw1'), 'EG', 'online')), 2500::numeric, 'an employee of the company can read prices');
select tests.eq((select count(*) from public.workshop_price_history), 0::bigint, 'but not the change history');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.workshop_price_history) > 0, true, 'managers can read the change history');
select tests.login('agent_b');
select tests.eq((select count(*) from public.workshop_price_for(tests.ref('pw1'), 'EG', 'online')), 0::bigint, 'another company sees nothing');
select tests.eq((select count(*) from public.workshop_prices), 0::bigint, 'and no rows');

-- "needs an admin to define it" list ------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select * from public.workshop_price_gaps(tests.ref('alpha'), array['QA'])$q$, 'auth.forbidden', 'agents cannot list gaps');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.workshop_price_gaps(tests.ref('alpha'), array['QA', 'EG'])), 1::bigint, 'only the active workshop is listed: 2 countries x 2 attendances = 4, minus 3 configured = 1 (EG offline)');
select tests.eq((select country || '/' || attendance from public.workshop_price_gaps(tests.ref('alpha'), array['QA', 'EG'])), 'EG/offline', 'the gap is Egypt offline');
select tests.eq((select count(*) from public.workshop_price_gaps(tests.ref('alpha'), array['qa', ' QA ', 'SA'])), 2::bigint, 'duplicates collapse; Qatar is fully set, Saudi Arabia has 2 gaps');
select tests.throws($q$select * from public.workshop_price_gaps(tests.ref('alpha'), array[]::text[])$q$, 'price.invalid_value', 'a country list is required');

-- another tenant is independent ---------------------------------------------------------------------------------------------------------
select tests.login('admin_b');
select public.set_workshop_price(tests.ref('pwb'), 'QA', 'online', 'QAR', 100);
select tests.eq((select count(*) from public.workshop_prices), 1::bigint, 'Beta sees only its own price');
select tests.login('admin_a');
select tests.eq((select count(*) from public.workshop_prices), 3::bigint, 'Alpha''s prices are unchanged by Beta');
select tests.throws($q$select public.set_workshop_price(tests.ref('pwb'), 'QA', 'online', 'QAR', 1)$q$, 'auth.forbidden', 'Alpha''s admin cannot touch Beta''s workshop');

-- groups -----------------------------------------------------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), 'Group 1', array[date '2026-12-06'], 20, 'online')$q$, 'auth.forbidden', 'a sales manager cannot create groups');
select tests.login('admin_a');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), ' ', array[date '2026-12-06'], 20, 'online')$q$, 'group.invalid_value', 'a name is required');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), 'G', array[]::date[], 20, 'online')$q$, 'group.invalid_value', 'at least one session date');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), 'G', array[date '2026-12-06'], 0, 'online')$q$, 'group.invalid_value', 'capacity must be positive');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), 'G', array[date '2026-12-06'], 20, 'hybrid')$q$, 'group.invalid_value', 'attendance is online or offline (or empty)');
select tests.eq((select count(*) from public.workshop_groups), 0::bigint, 'failed attempts created nothing');
create temp table g1 as select public.set_workshop_group(null, tests.ref('pw1'), 'Group 1', array[date '2026-12-08', date '2026-12-06', date '2026-12-07', date '2026-12-06'], 20, 'online') as id;
select tests.eq((select starts_on || '>' || ends_on || ' ' || cardinality(sessions) from public.workshop_groups where id = (select id from g1)), '2026-12-06>2026-12-08 3', 'sessions are sorted and de-duplicated; start and end are derived');
select public.set_workshop_group(null, tests.ref('pw1'), 'Group 2', array[date '2026-12-13', date '2026-12-14', date '2026-12-15'], null, null);
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw1'), 'Group 1', array[date '2027-01-01'], 5, null)$q$, 'duplicate key', 'a group name is unique within a workshop');
select public.set_workshop_group((select id from g1), tests.ref('pw1'), 'Group 1', array[date '2026-12-06', date '2026-12-07', date '2026-12-09'], 25, 'online');
select tests.eq((select ends_on || ' cap ' || capacity from public.workshop_groups where id = (select id from g1)), '2026-12-09 cap 25', 'dates and capacity can be edited');
select tests.throws($q$select public.set_workshop_group((select id from g1), tests.ref('pwb'), 'Group 1', array[date '2026-12-06'], 5, null)$q$, 'auth.forbidden', 'the group cannot be re-pointed at another company''s workshop');
select tests.throws($q$select public.set_workshop_group(gen_random_uuid(), tests.ref('pw1'), 'X', array[date '2026-12-06'], 5, null)$q$, 'group.not_found', 'an unknown group is refused');
select public.set_workshop_group((select id from g1), tests.ref('pw1'), 'Group 1', array[date '2026-12-06'], 25, 'online', false);
select tests.eq((select is_active from public.workshop_groups where id = (select id from g1)), false, 'a group is deactivated, never deleted');
select tests.throws($q$delete from public.workshop_groups$q$, 'permission denied', 'no direct delete');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.workshop_groups), 2::bigint, 'employees can read groups');
select tests.login('agent_b');
select tests.eq((select count(*) from public.workshop_groups), 0::bigint, 'another company cannot');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'workshop.price_set'), 8::bigint, 'every price change is audited (set x6, deactivate x2... see the history)');
select tests.eq((select count(*) from public.audit_logs where action = 'workshop.group_set'), 4::bigint, 'every group change is audited');
rollback;
