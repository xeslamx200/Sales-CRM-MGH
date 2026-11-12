-- Kapso history sync (migration 997): only the service role may store history; existing messages are never touched; unread stays as it was.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with supabase/migrations + _helpers.sql + _fixtures.sql> -f supabase/tests/db/35_kapso_history_sync.sql
begin;
select tests.logout();

-- a real (production) Kapso number of company alpha
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, waba_id, provider, environment, connection_mode, status)
values (tests.ref('alpha'), 'T997', '+97450099701', '997000000000001', '997000000000002', 'kapso', 'production', 'coexistence', 'active');

create or replace function pg_temp.svc() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true); select set_config('role', 'service_role', true); $$;
create or replace function pg_temp.rows(p_prefix text, p_phone text, p_ts bigint) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('id', p_prefix || '.1', 'd', 'i', 'ts', p_ts, 'ph', p_phone, 'nm', 'History Customer', 'ty', 'text', 'b', 'hello', 'st', 'received'),
    jsonb_build_object('id', p_prefix || '.2', 'd', 'o', 'ts', p_ts + 60, 'ph', p_phone, 'ty', 'text', 'b', 'welcome', 'st', 'read'),
    jsonb_build_object('id', p_prefix || '.3', 'd', 'i', 'ts', p_ts + 120, 'ph', p_phone, 'ty', 'image', 'b', null, 'st', 'received')) $$;

-- 1. nobody but the service role
select tests.login('admin_a');
select tests.throws($q$select public.kapso_import_history('997000000000001', '[]'::jsonb)$q$, 'permission denied', 'a company admin cannot call it (service role only)');
select tests.login('super');
select tests.throws($q$select public.kapso_import_history('997000000000001', '[]'::jsonb)$q$, 'permission denied', 'not even a super admin directly (the app checks and then uses the service role)');
select tests.logout();

-- 2. a customer the CRM never saw: contact + conversation created, three messages stored, nothing unread, no lead, no notification
select pg_temp.svc();
create temp table t_before on commit drop as select (select count(*) from public.leads) as leads, (select count(*) from public.notifications) as notes;
select tests.eq((public.kapso_import_history('997000000000001', pg_temp.rows('wamid.T997A', '97455099701', 1785000000)) ->> 'inserted')::int, 3, 'three new messages stored');
select tests.eq((select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id where c.customer_wa_id = '97455099701'), 3::bigint, 'in one conversation of that customer');
select tests.eq((select unread_count from public.conversations where customer_wa_id = '97455099701'), 0, 'history does not show as unread');
select tests.eq((select company_id from public.conversations where customer_wa_id = '97455099701'), tests.ref('alpha'), 'the company comes from the number');
select tests.eq((select last_message_at from public.conversations where customer_wa_id = '97455099701'), to_timestamp(1785000120), 'the conversation moves to its latest message');
select tests.eq((select count(*) from public.leads) - (select leads from t_before), 0::bigint, 'no lead created');
select tests.eq((select count(*) from public.notifications) - (select notes from t_before), 0::bigint, 'no notification created');

-- 3. running it again changes nothing
select tests.eq(public.kapso_import_history('997000000000001', pg_temp.rows('wamid.T997A', '97455099701', 1785000000)) - 'failed_codes',
  '{"inserted": 0, "duplicate": 3, "failed": 0}'::jsonb, 'a second run only finds duplicates');

-- 4. an existing conversation with unread messages keeps its counter, and an OLDER message never moves it back in time
update public.conversations set unread_count = 2 where customer_wa_id = '97455099701';
select tests.eq((public.kapso_import_history('997000000000001', jsonb_build_array(jsonb_build_object('id', 'wamid.T997B.1', 'd', 'i', 'ts', 1784000000, 'ph', '97455099701', 'ty', 'text', 'b', 'older', 'st', 'received'))) ->> 'inserted')::int, 1, 'an older message is added');
select tests.eq((select unread_count from public.conversations where customer_wa_id = '97455099701'), 2, 'the unread counter is unchanged');
select tests.eq((select last_message_at from public.conversations where customer_wa_id = '97455099701'), to_timestamp(1785000120), 'the latest message time does not go back');

-- 5. bad rows are counted, never stored, and do not stop the others
select tests.eq(public.kapso_import_history('997000000000001', jsonb_build_array(
    jsonb_build_object('id', 'wamid.T997C.1', 'd', 'i', 'ts', 1785000500, 'ty', 'text', 'b', 'no identity'),
    jsonb_build_object('id', 'bad id with spaces', 'd', 'i', 'ts', 1785000500, 'ph', '97455099701'),
    jsonb_build_object('id', 'wamid.T997C.3', 'd', 'i', 'ts', 1785000600, 'ph', '97455099702', 'ty', 'text', 'b', 'fine'))) - 'failed_codes',
  '{"inserted": 1, "duplicate": 0, "failed": 2}'::jsonb, 'two bad rows counted, the good one stored');
select tests.eq((select count(*) from public.messages where wa_message_id in ('wamid.T997C.1', 'bad id with spaces')), 0::bigint, 'the bad rows were not stored');

-- 6. input limits and unknown numbers
select tests.throws($q$select public.kapso_import_history('997000000000001', '{"not": "an array"}'::jsonb)$q$, 'kapso.invalid_history_rows', 'the rows must be a list');
select tests.throws($q$select public.kapso_import_history('997000000000001', (select jsonb_agg(jsonb_build_object('id', 'x' || g)) from generate_series(1, 5001) g))$q$, 'kapso.history_batch_too_large', 'at most 5,000 rows per call');
select tests.throws($q$select public.kapso_import_history('000000000000000', '[]'::jsonb)$q$, 'kapso.unknown_account', 'an unknown number is refused');
rollback;
