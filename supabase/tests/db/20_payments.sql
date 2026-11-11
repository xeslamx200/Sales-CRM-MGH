-- Workshop payments (proposed migration 980). Lives outside supabase/tests/db so scripts/db/test.sh does not run it on databases without 980.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..980 + supabase/tests/db/_helpers.sql + _fixtures.sql> -f supabase/tests/db/20_payments.sql
-- Money rules: rate read by the database and frozen, EGP total computed by the database, manager confirmation, company isolation,
-- immutability, proof images through the attachments system.
begin;
select tests.logout();

do $$ begin
  if to_regclass('public.payments') is null then raise notice 'ok - SKIPPED: migration 980 is not installed'; end if;
end $$;

-- fixtures -------------------------------------------------------------------------------------------------------------------------
select tests.service();
select public.upsert_fx_rates('{"USD": 50, "EUR": 55.5, "SAR": 13.2}'::jsonb, 'test-source');
select tests.logout();
do $$
declare o1 uuid; o2 uuid; ob uuid; c1 uuid; c_g uuid;
begin
  if to_regclass('public.payments') is null then return; end if;
  insert into public.company_offerings (company_id, name, kind, price_egp) values (tests.ref('alpha'), 'Workshop One', 'course', 10000) returning id into o1;
  insert into public.company_offerings (company_id, name, kind, price_egp, is_active) values (tests.ref('alpha'), 'Old Workshop', 'course', 500, false) returning id into o2;
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('beta'), 'Beta Workshop', 'course') returning id into ob;
  insert into public.contacts (full_name, phone_e164) values ('Alpha Payer', '+201055500001') returning id into c1;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c1, tests.ref('alpha'), tests.uid('agent_a1'));   -- agent_a1 works with this customer (agents only see the contacts they work with)
  insert into public.contacts (full_name, phone_e164) values ('Gamma Only Payer', '+201055500002') returning id into c_g;
  insert into public.contact_companies (contact_id, company_id) values (c_g, tests.ref('gamma'));
  insert into tests.refs values ('off_a', o1), ('off_a_inactive', o2), ('off_b', ob), ('payer', c1), ('payer_gamma', c_g);
end $$;

-- recording ------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
do $$ begin if to_regclass('public.payments') is null then return; end if;
  perform tests.ok((select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 2500, 'EGP', 'partial', null, 'first installment')) is not null,
    'an agent records an EGP payment');
  perform tests.eq((select amount_egp from public.payments where created_by = tests.uid('agent_a1') and currency = 'EGP'), 2500.00::numeric,
    'EGP: the total equals the amount');
  perform tests.eq((select status from public.payments where created_by = tests.uid('agent_a1') and currency = 'EGP'), 'pending', 'new payments are pending');
  perform tests.eq((select company_id from public.payments limit 1), tests.ref('alpha'), 'the company comes from the workshop, not from the caller');
end $$;

do $$ begin if to_regclass('public.payments') is null then return; end if;
  perform public.record_payment(tests.ref('payer'), tests.ref('off_a'), 100, 'usd', 'partial', current_date, null);
  perform tests.eq((select amount_egp from public.payments where currency = 'USD'), 5000.00::numeric, 'USD 100 x 50 = EGP 5000.00 (lower-case input accepted)');
  perform tests.eq((select fx_rate_to_egp from public.payments where currency = 'USD'), 50::numeric, 'the rate used is frozen in the row');
  perform tests.eq((select fx_source from public.payments where currency = 'USD'), 'auto', 'rate source recorded');
end $$;

-- the rate changes later: the old payment keeps its total, a new one uses the new rate
select tests.service();
select public.upsert_fx_rates('{"USD": 60}'::jsonb, 'test-source-2');
select tests.login('agent_a1');
do $$ begin if to_regclass('public.payments') is null then return; end if;
  perform public.record_payment(tests.ref('payer'), tests.ref('off_a'), 100, 'USD', 'partial', null, null);
  perform tests.eq((select array_agg(amount_egp order by amount_egp) from public.payments where currency = 'USD'), array[5000.00, 6000.00]::numeric[],
    'a later rate never changes an earlier payment');
  perform tests.eq((select round(sum(amount_egp), 2) from public.payments where status = 'pending'), 13500.00::numeric, 'running total in EGP (2500 + 5000 + 6000)');
end $$;

-- rejected inputs
do $$ begin if to_regclass('public.payments') is null then return; end if; end $$;
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 100, 'XYZ', 'partial')$q$, 'payment.rate_unavailable', 'an unknown currency has no rate');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 0, 'EGP', 'partial')$q$, 'payment.invalid_amount', 'amount must be positive');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), -5, 'EGP', 'partial')$q$, 'payment.invalid_amount', 'negative amount refused');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 10.123, 'EGP', 'partial')$q$, 'payment.invalid_amount', 'more than 2 decimals refused');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 10, 'EGP', 'maybe')$q$, 'payment.invalid_kind', 'kind is partial or full');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 10, 'EGP', 'full', current_date + 30)$q$, 'payment.invalid_date', 'a future payment date is refused');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a_inactive'), 10, 'EGP', 'full')$q$, 'payment.offering_inactive', 'inactive workshop refused');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_b'), 10, 'EGP', 'full')$q$, 'payment.offering_not_found', 'a workshop of a company the caller is not in is invisible');
select tests.throws($q$select public.record_payment(tests.ref('payer_gamma'), tests.ref('off_a'), 10, 'EGP', 'full')$q$, 'payment.contact_not_found', 'a customer of another company cannot pay this workshop');
select tests.throws($q$select public.record_payment(gen_random_uuid(), tests.ref('off_a'), 10, 'EGP', 'full')$q$, 'payment.contact_not_found', 'unknown customer refused');

-- stale rates
select tests.service();
update public.fx_rates set fetched_at = now() - interval '3 days' where currency = 'EUR';
select tests.login('agent_a1');
select tests.throws($q$select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 10, 'EUR', 'full')$q$, 'payment.rate_stale', 'a rate older than 48 hours is refused');

-- no direct writes ------------------------------------------------------------------------------------------------------------------
select tests.throws($q$insert into public.payments (company_id, contact_id, offering_id, amount, currency, fx_rate_to_egp, fx_source, kind, created_by)
  values (tests.ref('alpha'), tests.ref('payer'), tests.ref('off_a'), 1, 'EGP', 1, 'egp', 'full', tests.uid('agent_a1'))$q$, 'permission denied', 'no direct INSERT');
select tests.throws($q$update public.payments set amount = 1$q$, 'permission denied', 'no direct UPDATE');
select tests.throws($q$delete from public.payments$q$, 'permission denied', 'no direct DELETE');
select tests.throws($q$select public.upsert_fx_rates('{"USD": 1}', 'x')$q$, 'permission denied', 'users cannot write exchange rates');
select tests.throws($q$insert into public.fx_rates (currency, rate_to_egp, fetched_at, source) values ('GBP', 1, now(), 'x')$q$, 'permission denied', 'no direct rate insert');
select tests.ok((select count(*) from public.fx_rates) >= 3, 'users can read the rates (the form shows the EGP preview)');

-- visibility -------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a2');
select tests.eq((select count(*) from public.payments), 0::bigint, 'another agent does not see a colleague''s payments');
select tests.login('agent_b');
select tests.eq((select count(*) from public.payments), 0::bigint, 'another company sees nothing');
select tests.login('outsider');
select tests.eq((select count(*) from public.payments), 0::bigint, 'a user without memberships sees nothing');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.payments), 3::bigint, 'a manager sees every payment of the company');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.payments), 3::bigint, 'the recorder sees their own');

-- review -----------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a2');
select tests.throws($q$select public.review_payment((select id from public.payments limit 1), 'confirmed')$q$, 'payment.not_found', 'an agent cannot review (the row is invisible to them)');
select tests.login('agent_a1');
select tests.throws($q$select public.review_payment((select id from public.payments limit 1), 'confirmed')$q$, 'payment.not_found', 'the recorder (an agent) cannot confirm their own payment');

select tests.login('mgr_a');
do $$ declare p uuid; begin if to_regclass('public.payments') is null then return; end if;
  select id into p from public.payments where currency = 'EGP';
  perform public.review_payment(p, 'confirmed', 'checked the transfer');
  perform tests.eq((select status from public.payments where id = p), 'confirmed', 'a manager confirms');
  perform tests.eq((select reviewed_by from public.payments where id = p), tests.uid('mgr_a'), 'the reviewer is recorded');
end $$;
select tests.throws($q$select public.review_payment((select id from public.payments where currency = 'EGP'), 'confirmed')$q$, 'payment.invalid_transition', 'confirming twice is refused');
select tests.throws($q$select public.review_payment((select id from public.payments where currency = 'EGP'), 'rejected', 'oops')$q$, 'payment.invalid_transition', 'a manager cannot reverse a confirmed payment');
select tests.throws($q$select public.review_payment((select id from public.payments where currency = 'USD' limit 1), 'rejected')$q$, 'payment.reason_required', 'a rejection needs a reason');
select tests.throws($q$select public.review_payment((select id from public.payments where currency = 'USD' limit 1), 'maybe')$q$, 'payment.invalid_decision', 'only confirmed / rejected');
select public.record_payment(tests.ref('payer'), tests.ref('off_a'), 70, 'EGP', 'full');
select tests.throws($q$select public.review_payment((select id from public.payments where created_by = tests.uid('mgr_a')), 'confirmed')$q$, 'payment.cannot_review_own', 'a manager cannot confirm their own payment');
select tests.login('admin_a');
do $$ declare p uuid; begin if to_regclass('public.payments') is null then return; end if;
  select id into p from public.payments where created_by = tests.uid('mgr_a');
  perform public.review_payment(p, 'confirmed');
  perform tests.eq((select status from public.payments where id = p), 'confirmed', 'a company admin can confirm a manager''s payment');
  select id into p from public.payments where currency = 'EGP' and amount = 2500;
  perform public.review_payment(p, 'rejected', 'bank reversed the transfer');
  perform tests.eq((select status from public.payments where id = p), 'rejected', 'only an admin reverses a confirmed payment, with a reason');
end $$;
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 2500), 'confirmed')$q$, 'payment.invalid_transition', 'a rejected payment is final');
select tests.eq((select round(sum(amount_egp), 2) from public.payments where status = 'confirmed'), 70.00::numeric, 'only confirmed payments are counted (70 confirmed)');

-- immutability (even for the maintenance role: only review_payment may change a row) ---------------------------------------------------
select tests.logout();
select tests.throws($q$update public.payments set amount = 999999$q$, 'payment.immutable', 'amount can never be edited');
select tests.throws($q$update public.payments set fx_rate_to_egp = 1000$q$, 'payment.immutable', 'the frozen rate can never be edited');
select tests.throws($q$update public.payments set status = 'confirmed' where status = 'pending'$q$, 'payment.immutable', 'status changes only through review_payment');
select tests.throws($q$delete from public.payments$q$, 'payment.immutable', 'payments are never deleted');

select tests.eq((select count(*) from public.audit_logs where action = 'payment.recorded'), 4::bigint, 'every recorded payment is audited');
select tests.eq((select count(*) from public.audit_logs where action = 'payment.confirmed'), 2::bigint, 'every confirmation is audited');
select tests.eq((select count(*) from public.audit_logs where action = 'payment.rejected'), 1::bigint, 'every rejection is audited');

-- proof images ------------------------------------------------------------------------------------------------------------------------
do $$ declare p uuid; begin if to_regclass('public.payments') is null then return; end if;
  select id into p from public.payments where currency = 'USD' order by amount_egp limit 1; insert into tests.refs values ('pay_usd', p);
end $$;
create or replace function pg_temp.ppath(p_name text default 'aaaaaaaaaaaaaaaaaaaaaaaa.png') returns text
language sql as $$ select tests.ref('alpha') || '/payment/' || tests.ref('pay_usd') || '/' || p_name $$;
select tests.login('agent_a1');
select tests.lives($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'payment', tests.ref('pay_usd'), pg_temp.ppath(), 'transfer.png', 'image/png', 12345)$q$, 'the recorder attaches the proof image to their payment');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('beta'), 'payment', tests.ref('pay_usd'), tests.ref('beta') || '/payment/' || tests.ref('pay_usd') || '/bbbbbbbbbbbbbbbbbbbbbbbb.png', 'x.png', 'image/png', 10)$q$,
  'attachment.company_mismatch', 'the proof must be filed under the payment''s own company');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'payment', tests.ref('pay_usd'), pg_temp.ppath('cccccccccccccccccccccccc.html'), 'x.html', 'text/html', 10)$q$,
  'attachment.unsupported_type', 'only allowed file types');
select tests.ok((select count(*) from public.attachments where entity_type = 'payment') = 1, 'the recorder sees the proof');
select tests.login('mgr_a');
select tests.ok((select count(*) from public.attachments where entity_type = 'payment') = 1, 'a manager sees the proof');
select tests.login('agent_a2');
select tests.ok((select count(*) from public.attachments where entity_type = 'payment') = 0, 'a colleague does not see the proof');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'payment', tests.ref('pay_usd'), pg_temp.ppath('dddddddddddddddddddddddd.png'), 'x.png', 'image/png', 10)$q$,
  'row-level security', 'a colleague cannot attach to someone else''s payment');
select tests.login('agent_b');
select tests.ok((select count(*) from public.attachments where entity_type = 'payment') = 0, 'another company does not see the proof');

-- workshop price ------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select tests.lives($q$update public.company_offerings set price_egp = 12000 where id = tests.ref('off_a')$q$, 'a company admin sets the workshop price');
select tests.eq((select price_egp from public.company_offerings where id = tests.ref('off_a')), 12000.00::numeric, 'price stored');
select tests.login('agent_a1');
select tests.eq((select price_egp from public.payment_balance(tests.ref('payer'), tests.ref('off_a'))), 12000.00::numeric, 'balance: the workshop price');
select tests.eq((select confirmed_egp from public.payment_balance(tests.ref('payer'), tests.ref('off_a'))), 70.00::numeric, 'balance: confirmed total includes a colleague''s confirmed payment');
select tests.eq((select pending_egp from public.payment_balance(tests.ref('payer'), tests.ref('off_a'))), 11000.00::numeric, 'balance: pending total (5000 + 6000)');
select tests.throws($q$select * from public.payment_balance(tests.ref('payer_gamma'), tests.ref('off_a'))$q$, 'payment.contact_not_found', 'balance: a customer the caller cannot see');
select tests.login('agent_b');
select tests.throws($q$select * from public.payment_balance(tests.ref('payer'), tests.ref('off_a'))$q$, 'payment.offering_not_found', 'balance: another company''s workshop is invisible');
select tests.login('agent_a1');
do $$ declare n int; begin if to_regclass('public.payments') is null then return; end if;
  update public.company_offerings set price_egp = 1 where id = tests.ref('off_a');
  get diagnostics n = row_count;
  perform tests.eq(n, 0, 'an agent cannot change the price (RLS hides the row from the update)');
end $$;
select tests.login('admin_a');
select tests.throws($q$update public.company_offerings set price_egp = -1 where id = tests.ref('off_a')$q$, 'check constraint', 'negative prices are refused (check constraint)');

-- rate writer validation (service role) --------------------------------------------------------------------------------------------------
select tests.service();
select tests.throws($q$select public.upsert_fx_rates('{"EGP": 1}', 'x')$q$, 'payment.invalid_rates', 'EGP is never a stored rate');
select tests.throws($q$select public.upsert_fx_rates('{"usd": 50}', 'x')$q$, 'payment.invalid_rates', 'currency codes are upper-case');
select tests.throws($q$select public.upsert_fx_rates('{"USD": -3}', 'x')$q$, 'payment.invalid_rates', 'non-positive rates refused');
select tests.throws($q$select public.upsert_fx_rates('[1]', 'x')$q$, 'payment.invalid_rates', 'rates must be an object');
select tests.eq((select public.upsert_fx_rates('{"GBP": 62.4}', 'x')), 1, 'valid rates are stored');

rollback;
