-- Shared workshops (migration 998): two paired companies keep one catalogue (workshops, prices, groups); everything else stays separate.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with supabase/migrations + _helpers.sql + _fixtures.sql> -f supabase/tests/db/36_shared_workshops.sql
begin;
select tests.logout();

-- ------------------------------------------------------------------ 0. nothing is shared until two companies are paired
select tests.login('admin_a');
insert into public.company_offerings (company_id, name, kind, keywords) values (tests.ref('alpha'), 'Shared Test One', 'workshop', array['alpha one']);
select tests.eq((select count(*) from public.company_offerings where name = 'Shared Test One'), 1::bigint, 'before pairing, a new workshop exists in its own company only');
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta') and name = 'Shared Test One'), 0::bigint, 'and not in the other one');
select tests.eq((select count(*) from public.company_offerings where shared_key is null), 0::bigint, 'every workshop carries a key from the start');

-- a price and a group that exist before pairing
select tests.login('admin_a');
select public.set_workshop_price((select id from public.company_offerings where company_id = tests.ref('alpha') and name = 'Shared Test One'), 'QA', 'online', 'QAR', 1500);
select public.set_workshop_group(null, (select id from public.company_offerings where company_id = tests.ref('alpha') and name = 'Shared Test One'), 'Group 1', array[date '2026-12-06', date '2026-12-07'], 20, 'online', true);
select tests.logout();
-- beta already has a workshop with the same name (different case) and one of its own
insert into public.company_offerings (company_id, name, kind, keywords) values (tests.ref('beta'), 'shared test one', 'course', array['beta old']), (tests.ref('beta'), 'Beta Only', 'course', '{}');

-- ------------------------------------------------------------------ 1. pairing (service role only)
select tests.login('admin_a');
select tests.throws($q$select app.share_workshops(tests.ref('alpha'), tests.ref('beta'))$q$, 'permission denied', 'a company admin cannot pair companies');
select tests.logout();
select tests.eq((app.share_workshops(tests.ref('alpha'), tests.ref('beta')) -> 'offerings' ->> 'other')::int, 2, 'pairing: beta has the same workshops as alpha (the same-name one adopted, its own kept)');
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta') and lower(name) = 'shared test one'), 1::bigint, 'the same-name workshop was linked, not duplicated');
select tests.eq((select keywords::text from public.company_offerings where company_id = tests.ref('beta') and lower(name) = 'shared test one'), '{"alpha one"}', 'the source company wins where both have a value');
select tests.eq((select count(*) from public.company_offerings a join public.company_offerings b on b.shared_key = a.shared_key and b.company_id = tests.ref('beta') where a.company_id = tests.ref('alpha')), 2::bigint, 'the two copies share a key (and the other company''s own workshop is now in alpha as well)');
select tests.eq((select price::text || currency from public.workshop_prices where company_id = tests.ref('beta')), '1500.00QAR', 'the price was copied');
select tests.eq((select count(*) from public.workshop_price_history where company_id = tests.ref('beta')), 1::bigint, 'with its own history row');
select tests.eq((select sessions::text || capacity from public.workshop_groups where company_id = tests.ref('beta')), '{2026-12-06,2026-12-07}20', 'the group was copied with its dates and capacity');
select tests.eq((app.share_workshops(tests.ref('alpha'), tests.ref('beta')) -> 'groups' ->> 'other')::int, 1, 'pairing again changes nothing (idempotent)');
select tests.eq((select count(*) from public.company_workshop_sharing), 1::bigint, 'one pair');

-- ------------------------------------------------------------------ 2. alpha -> beta
select tests.login('admin_a');
insert into public.company_offerings (company_id, name, kind, keywords) values (tests.ref('alpha'), 'Created In Alpha', 'workshop', array['fresh']);
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta') and name = 'Created In Alpha' and keywords = array['fresh']), 1::bigint, 'a workshop created in alpha appears in beta');
select tests.login('admin_a');
update public.company_offerings set name = 'Renamed In Alpha', is_active = false where company_id = tests.ref('alpha') and name = 'Created In Alpha';
select public.set_workshop_price((select id from public.company_offerings where company_id = tests.ref('alpha') and name = 'Renamed In Alpha'), 'EG', 'offline', 'EGP', 900);
select public.set_workshop_price((select id from public.company_offerings where company_id = tests.ref('alpha') and name = 'Shared Test One'), 'QA', 'online', 'QAR', 1800);
select public.set_workshop_group((select id from public.workshop_groups where company_id = tests.ref('alpha')), (select id from public.company_offerings where company_id = tests.ref('alpha') and name = 'Shared Test One'), 'Group 1', array[date '2026-12-06', date '2026-12-07', date '2026-12-08'], 25, 'online', true);
select tests.logout();
select tests.eq((select name || is_active::text from public.company_offerings where company_id = tests.ref('beta') and keywords = array['fresh']), 'Renamed In Alphafalse', 'a rename and a deactivation travel');
select tests.eq((select price::text from public.workshop_prices where company_id = tests.ref('beta') and country = 'EG'), '900.00', 'a new price travels');
select tests.eq((select price::text from public.workshop_prices where company_id = tests.ref('beta') and country = 'QA'), '1800.00', 'a changed price travels');
select tests.eq((select count(*) from public.workshop_price_history where company_id = tests.ref('beta') and country = 'QA'), 2::bigint, 'and the history of the copy records the change');
select tests.eq((select cardinality(sessions)::text || capacity from public.workshop_groups where company_id = tests.ref('beta')), '325', 'a changed group travels (dates and capacity)');

-- ------------------------------------------------------------------ 3. beta -> alpha (both directions)
select tests.login('admin_b');
insert into public.company_offerings (company_id, name, kind, keywords) values (tests.ref('beta'), 'Created In Beta', 'course', array['beta new']);
select public.set_workshop_price((select id from public.company_offerings where company_id = tests.ref('beta') and name = 'Created In Beta'), 'AE', 'online', 'AED', 400);
select public.set_workshop_group(null, (select id from public.company_offerings where company_id = tests.ref('beta') and name = 'Created In Beta'), 'Beta Group', array[date '2027-01-10'], null, null, true);
update public.company_offerings set is_active = false where company_id = tests.ref('beta') and name = 'Beta Only';
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('alpha') and name = 'Created In Beta' and kind = 'course'), 1::bigint, 'a workshop created in beta appears in alpha');
select tests.eq((select price::text from public.workshop_prices where company_id = tests.ref('alpha') and country = 'AE'), '400.00', 'its price too');
select tests.eq((select count(*) from public.workshop_groups where company_id = tests.ref('alpha') and name = 'Beta Group'), 1::bigint, 'and its group');
select tests.eq((select is_active::text from public.company_offerings where company_id = tests.ref('alpha') and name = 'Beta Only'), 'false', 'a deactivation in beta reaches alpha');

-- ------------------------------------------------------------------ 4. nothing else crosses, and nothing loops
select tests.login('admin_a');
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta')), 0::bigint, 'alpha''s admin still cannot read beta''s rows (row-level security is untouched)');
select tests.eq((select count(*) from public.workshop_prices where company_id = tests.ref('beta')), 0::bigint, '... nor its prices');
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('gamma') and name like '%Alpha%'), 0::bigint, 'a third company gets nothing');
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('alpha')), (select count(*) from public.company_offerings where company_id = tests.ref('beta')), 'both catalogues have the same number of workshops');
select tests.eq((select count(*) from public.workshop_prices where company_id = tests.ref('alpha')), (select count(*) from public.workshop_prices where company_id = tests.ref('beta')), 'and of prices');
select tests.eq((select count(*) from public.workshop_groups where company_id = tests.ref('alpha')), (select count(*) from public.workshop_groups where company_id = tests.ref('beta')), 'and of groups');

-- ------------------------------------------------------------------ 5. a clash is refused clearly
-- a workshop that exists only in beta (created while the link was switched off, as a repair or an old import would)
select set_config('app.sharing_sync', 'on', true);
insert into public.company_offerings (company_id, name, kind) values (tests.ref('beta'), 'Unlinked In Beta', 'course');
select set_config('app.sharing_sync', 'off', true);
select tests.login('admin_a');
select tests.throws($q$update public.company_offerings set name = 'Unlinked In Beta' where company_id = tests.ref('alpha') and name = 'Renamed In Alpha'$q$, 'workshop.sharing_name_conflict', 'a rename that collides with another workshop of the other company is refused with a clear key');
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('alpha') and name = 'Renamed In Alpha'), 1::bigint, 'and nothing was changed');
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta') and name = 'Renamed In Alpha'), 1::bigint, 'in either company');
rollback;
