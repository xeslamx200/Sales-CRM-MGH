-- Discount approval workflow (proposed migration 986; needs 984 + 985). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..986 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/26_booking_discount_approval.sql
begin;
select tests.logout();

-- fixtures: a workshop with a QAR price and an EGP price, a second company admin, customers owned by the employee / the manager / the admin ----------
select public.upsert_fx_rates('{"QAR": 14.1}'::jsonb, 'test-source');
do $$
declare w uuid; g uuid; c uuid; i int;
begin
  perform tests.create_user('adm2', 'Second Admin');
  insert into public.company_memberships (company_id, user_id, role) values (tests.ref('alpha'), tests.uid('adm2'), 'company_admin');
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Discount W', 'workshop') returning id into w;
  insert into tests.refs values ('dw', w);
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 1000), (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 2000);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'DG', array[date '2027-12-06'], date '2027-12-06', date '2027-12-06') returning id into g;
  insert into tests.refs values ('dg', g);
  for i in 1..30 loop
    insert into public.contacts (full_name, phone_e164) values ('Disc ' || i, '+2010444' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'),
      case when i between 21 and 24 then tests.uid('mgr_a') when i between 25 and 28 then tests.uid('admin_a') else tests.uid('agent_a1') end);
    insert into tests.refs values ('c' || i, c);
  end loop;
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('beta'), 'Beta DW', 'workshop') returning id into w;
  insert into tests.refs values ('bdw', w);
end $$;
-- create a booking as a user and remember booking + request ids under a name
create or replace function pg_temp.mk(p_name text, p_user text, p_contact text, p_type text default 'none', p_value numeric default 0, p_reason text default null, p_country text default 'QA')
returns void language plpgsql as $$
declare v uuid; r uuid;
begin
  perform tests.login(p_user);
  v := public.create_workshop_booking(tests.ref(p_contact), tests.ref('dg'), p_country, 'online', p_type, p_value, p_reason);
  perform tests.logout();
  select id into r from public.booking_discount_requests where booking_id = v order by requested_at desc limit 1;
  insert into tests.refs values ('b_' || p_name, v);
  if r is not null then insert into tests.refs values ('r_' || p_name, r); end if;
  perform tests.login(p_user);
end $$;
create or replace function pg_temp.row(p_name text) returns text language sql as $$
  select final_price || '|' || discount_amount || '|' || discount_status || '|' || payment_status || '|' || remaining
  from public.workshop_bookings_list(tests.ref('dw')) where booking_id = tests.ref('b_' || p_name) $$;

-- the policy itself (pure functions) --------------------------------------------------------------------------------------------------------------
select tests.eq((select app.discount_required_level('percent', 10, 1000)), 'employee', '10 % -> employee');
select tests.eq((select app.discount_required_level('percent', 10.01, 1000)), 'manager', '10.01 % -> manager');
select tests.eq((select app.discount_required_level('percent', 25, 1000)), 'manager', '25 % -> manager');
select tests.eq((select app.discount_required_level('percent', 25.01, 1000)), 'admin', '25.01 % -> admin');
select tests.eq((select app.discount_required_level('percent', 100, 1000)), 'admin', '100 % -> admin');
select tests.eq((select app.discount_required_level('fixed', 100, 1000)), 'employee', 'fixed 100 of 1000 = 10 % -> employee');
select tests.eq((select app.discount_required_level('fixed', 100.01, 1000)), 'manager', 'fixed 100.01 of 1000 = 10.001 % -> manager (no rounding down)');
select tests.eq((select app.discount_required_level('fixed', 250, 1000)), 'manager', 'fixed 250 = 25 % -> manager');
select tests.eq((select app.discount_required_level('fixed', 250.01, 1000)), 'admin', 'fixed 250.01 = 25.001 % -> admin');
select tests.eq((select app.discount_required_level('fixed', 1000, 1000)), 'admin', 'fixed = the whole price = 100 % -> admin');
select tests.eq((select app.discount_effective_percent('fixed', 333.33, 1000)), 33.333::numeric, 'effective percent of a fixed discount uses the original price');
select tests.eq((select app.discount_required_level('none', 0, 1000)), 'none', 'no discount needs nothing');

-- requests at booking time ------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.create_workshop_booking(tests.ref('c1'), tests.ref('dg'), 'QA', 'online', 'percent', 5, null)$q$, 'booking.discount_reason_required', 'a reason is mandatory even for a small discount');
select tests.throws($q$select public.create_workshop_booking(tests.ref('c1'), tests.ref('dg'), 'QA', 'online', 'percent', 50, 'ab')$q$, 'booking.discount_reason_required', 'a 2-character reason is refused for a large one too');
select tests.throws($q$select public.create_workshop_booking(tests.ref('c1'), tests.ref('dg'), 'QA', 'online', 'fixed', 1000.01, 'too much')$q$, 'booking.invalid_discount', 'a fixed discount above the original price is refused');
select tests.throws($q$select public.create_workshop_booking(tests.ref('c1'), tests.ref('dg'), 'QA', 'online', 'percent', 100.01, 'too much')$q$, 'booking.invalid_discount', 'over 100 % refused');
select pg_temp.mk('e10', 'agent_a1', 'c1', 'percent', 10, 'loyal customer');
select tests.eq(pg_temp.row('e10'), '900.00|100.00|approved|unpaid|900.00', 'an employee discount up to 10 % applies at once');
select pg_temp.mk('ef10', 'agent_a1', 'c2', 'fixed', 100, 'coupon');
select tests.eq(pg_temp.row('ef10'), '900.00|100.00|approved|unpaid|900.00', 'a fixed discount equal to 10 % of the price applies at once');
select tests.logout();
select tests.eq((select decided_by = requested_by and required_level = 'employee' and status = 'approved' and effective_percent = 10 from public.booking_discount_requests where id = tests.ref('r_e10')), true,
  'the employee-level request is recorded as approved by the requester');
select pg_temp.mk('m11', 'agent_a1', 'c3', 'percent', 10.01, 'repeat customer');
select tests.eq(pg_temp.row('m11'), '1000.00|0.00|pending|unpaid|1000.00', 'above 10 %: the booking starts at the FULL price and the discount is only pending');
select tests.login('agent_a1');
select tests.eq((select requested_final || '/' || requested_percent || '/' || required_level from public.workshop_bookings_list(tests.ref('dw')) where booking_id = tests.ref('b_m11')), '899.90/10.0100/manager',
  'the pending request shows what the price WOULD be (899.90) and who must approve');
select pg_temp.mk('m25', 'agent_a1', 'c4', 'percent', 25, 'wholesale');
select pg_temp.mk('a26', 'agent_a1', 'c5', 'percent', 25.01, 'special deal');
select pg_temp.mk('a100', 'agent_a1', 'c6', 'percent', 100, 'sponsored seat');
select pg_temp.mk('af100', 'agent_a1', 'c7', 'fixed', 1000, 'sponsored seat (fixed)');
select tests.logout();
select tests.eq((select string_agg(required_level, ',' order by required_level) from public.booking_discount_requests where id in (tests.ref('r_m25'), tests.ref('r_a26'), tests.ref('r_a100'), tests.ref('r_af100'))), 'admin,admin,admin,manager',
  '25 % needs a manager; 25.01 %, 100 % and a fixed 100 % need an admin');
select tests.eq((select count(*) from public.booking_discount_requests where status = 'pending'), 5::bigint, 'five pending requests, none applied');

-- pending discounts change nothing -------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq(pg_temp.row('a100'), '1000.00|0.00|pending|unpaid|1000.00', 'a pending 100 % discount: full price, still unpaid, remaining 1000');
create temp table s0 as select * from public.workshop_stats(tests.ref('dw'));
select tests.login('mgr_a');
drop table s0;
create temp table s0 as select * from public.workshop_stats(tests.ref('dw'));
select tests.eq((select discounted_bookings || '/' || pending_discounts from s0), '2/5', 'stats: 2 bookings carry a real discount; 5 requests are only pending');
select tests.eq((select (by_currency -> 0 ->> 'discounts')::numeric || '/' || (by_currency -> 0 ->> 'total_final')::numeric from s0), '200.00/6800.00', 'discount totals count APPROVED discounts only (200); totals use the effective prices');

-- who may decide ---------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_m11'))$q$, 'discount.self_approval', 'the requester cannot approve their own request');
select tests.login('agent_a2');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_m11'))$q$, 'auth.forbidden', 'another employee cannot approve a manager-level request');
select tests.login('agent_b');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_m11'))$q$, 'discount.not_found', 'another company cannot even see the request');
select tests.login('mgr_a');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_a26'))$q$, 'auth.forbidden', 'a manager cannot approve an admin-level request');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_a100'))$q$, 'auth.forbidden', 'a manager cannot approve a 100 % discount');
select public.approve_booking_discount(tests.ref('r_m11'), 'ok, repeat customer');
select tests.eq(pg_temp.row('m11'), '899.90|100.10|approved|unpaid|899.90', 'a manager approves 10.01 %: the discount applies (899.90)');
select public.approve_booking_discount(tests.ref('r_m25'));
select tests.eq(pg_temp.row('m25'), '750.00|250.00|approved|unpaid|750.00', 'a manager approves exactly 25 %');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_m25'))$q$, 'discount.invalid_transition', 'a decided request cannot be decided again');
select tests.login('admin_a');
select public.approve_booking_discount(tests.ref('r_a26'));
select tests.eq(pg_temp.row('a26'), '749.90|250.10|approved|unpaid|749.90', 'an admin approves 25.01 %');
select public.approve_booking_discount(tests.ref('r_a100'), 'sponsor confirmed');
select tests.eq(pg_temp.row('a100'), '0.00|1000.00|approved|paid|0.00', 'an admin approves 100 %: the free seat is paid');
select tests.logout();
select tests.eq((select decided_by = tests.uid('admin_a') and applied_final = 0 and decision_note = 'sponsor confirmed' and decided_at is not null from public.booking_discount_requests where id = tests.ref('r_a100')), true,
  'who approved, when, the note and the applied final amount are recorded');
select tests.eq((select previous_final || '>' || calculated_final || ' req=' || discount_type || ' ' || discount_value || ' by ' || (requested_by = tests.uid('agent_a1'))::text from public.booking_discount_requests where id = tests.ref('r_a26')),
  '1000.00>749.90 req=percent 25.01 by true', 'previous and final amounts, requested value/type and requester are recorded');

-- self approval above employee level, for managers and admins ---------------------------------------------------------------------------------
select pg_temp.mk('mgr20', 'mgr_a', 'c21', 'percent', 20, 'my own customer');
select tests.eq(pg_temp.row('mgr20'), '1000.00|0.00|pending|unpaid|1000.00', 'a manager asking for 20 % also waits');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_mgr20'))$q$, 'discount.self_approval', 'a manager cannot approve their own discount');
select tests.login('adm2');
select public.approve_booking_discount(tests.ref('r_mgr20'));
select tests.eq(pg_temp.row('mgr20'), '800.00|200.00|approved|unpaid|800.00', 'another admin approves the manager''s request');
select pg_temp.mk('adm30', 'admin_a', 'c25', 'percent', 30, 'internal');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_adm30'))$q$, 'discount.self_approval', 'an admin cannot approve their own discount');
select tests.login('adm2');
select public.approve_booking_discount(tests.ref('r_adm30'));
select tests.eq(pg_temp.row('adm30'), '700.00|300.00|approved|unpaid|700.00', 'a different admin approves it');

-- rejection ---------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.mk('rej', 'agent_a1', 'c8', 'percent', 15, 'asked nicely');
select tests.login('agent_a2');
select tests.throws($q$select public.reject_booking_discount(tests.ref('r_rej'), 'no')$q$, 'auth.forbidden', 'an unrelated employee cannot reject');
select tests.login('mgr_a');
select tests.throws($q$select public.reject_booking_discount(tests.ref('r_rej'), ' ')$q$, 'discount.reason_required', 'a rejection needs a reason');
select public.reject_booking_discount(tests.ref('r_rej'), 'not at this level');
select tests.eq(pg_temp.row('rej'), '1000.00|0.00|rejected|unpaid|1000.00', 'a REJECTED discount leaves the booking at the full price');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_rej'))$q$, 'discount.invalid_transition', 'a rejected request cannot be approved later');
select tests.login('agent_a1');
select tests.eq((select decision_note from public.discount_requests_list(tests.ref('alpha'), 'rejected') where request_id = tests.ref('r_rej')), 'not at this level', 'the requester sees why');
-- the requester can withdraw their own pending request
select pg_temp.mk('wd', 'agent_a1', 'c9', 'percent', 30, 'withdrawn soon');
select public.reject_booking_discount(tests.ref('r_wd'), 'customer declined');
select tests.eq(pg_temp.row('wd'), '1000.00|0.00|rejected|unpaid|1000.00', 'the requester may withdraw (reject) their own pending request');
-- a new request after a rejection
select tests.throws($q$select public.request_booking_discount(tests.ref('b_rej'), 'percent', 5, null)$q$, 'booking.discount_reason_required', 'a new request needs a reason');
select public.request_booking_discount(tests.ref('b_rej'), 'percent', 5, 'smaller discount');
select tests.eq(pg_temp.row('rej'), '950.00|50.00|approved|unpaid|950.00', 'after a rejection a smaller (employee-level) request applies at once');
select tests.throws($q$select public.request_booking_discount(tests.ref('b_rej'), 'percent', 5, 'again')$q$, 'discount.invalid_transition', 'a booking with a discount cannot get another');
select pg_temp.mk('pend2', 'agent_a1', 'c10', 'percent', 40, 'big');
select tests.throws($q$select public.request_booking_discount(tests.ref('b_pend2'), 'percent', 5, 'again')$q$, 'discount.already_pending', 'only one open request per booking');

-- payments interplay ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.mk('pay', 'agent_a1', 'c11', 'percent', 20, 'will exceed');
select public.record_booking_payment(tests.ref('b_pay'), 950);
select tests.eq(pg_temp.row('pay'), '1000.00|0.00|pending|pending_approval|1000.00', 'a pending discount does not touch the money: 950 pending of 1000, nothing collected');
select tests.login('mgr_a');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_pay'))$q$, 'discount.exceeds_payments', 'approving would leave the customer with more paid than the discounted price (800): refused');
select tests.eq((select status from public.discount_requests_list(tests.ref('alpha'), null) where request_id = tests.ref('r_pay')), 'pending', 'and the request stays pending');
select tests.login('agent_a1');
select tests.throws($q$select public.request_booking_discount(tests.ref('b_pay'), 'fixed', 10, 'small')$q$, 'discount.already_pending', 'a second request is refused while one is open');
-- auto-approved request refused when it would undercut payments
select pg_temp.mk('pay2', 'agent_a1', 'c12');
select public.record_booking_payment(tests.ref('b_pay2'), 1000);
select tests.throws($q$select public.request_booking_discount(tests.ref('b_pay2'), 'percent', 5, 'late')$q$, 'discount.exceeds_payments', 'a late small discount cannot undercut money already paid');
-- cancelling closes the pending request
select pg_temp.mk('cn', 'agent_a1', 'c13', 'percent', 50, 'to be cancelled');
select public.cancel_workshop_booking(tests.ref('b_cn'), 'customer left');
select tests.login('mgr_a');
select tests.eq((select status || ' / ' || decision_note from public.discount_requests_list(tests.ref('alpha'), null) where request_id = tests.ref('r_cn')), 'rejected / booking cancelled', 'cancelling a booking rejects its pending discount request');
select tests.throws($q$select public.approve_booking_discount(tests.ref('r_cn'))$q$, 'discount.invalid_transition', 'nothing can be approved on a cancelled booking');

-- no way around the workflow ------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$update public.workshop_bookings set discount_type = 'percent', discount_value = 90, discount_amount = 900, final_price = 100 where id = tests.ref('b_pend2')$q$, 'permission denied', 'no direct update through the API');
select tests.throws($q$insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount, effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
  values (tests.ref('alpha'), tests.ref('b_pend2'), tests.uid('agent_a1'), 'percent', 90, 'forged', 1000, 900, 90, 'employee', 1000, 100, 'approved', tests.uid('agent_a1'), now(), 100)$q$, 'permission denied', 'no forged approved request through the API');
select tests.throws($q$update public.booking_discount_requests set status = 'approved'$q$, 'permission denied', 'no direct approval through the API');
select tests.logout();
select tests.throws($q$update public.workshop_bookings set discount_type = 'percent', discount_value = 90, discount_amount = 900, final_price = 100, discount_reason = 'sneaky' where id = tests.ref('b_pend2')$q$, 'booking.immutable', 'even the owner role cannot apply a discount without an approved request');
select tests.throws($q$do $d$ begin perform set_config('app.booking_discount_apply', gen_random_uuid()::text, true); update public.workshop_bookings set discount_type = 'percent', discount_value = 90, discount_amount = 900, final_price = 100, discount_reason = 'sneaky' where id = tests.ref('b_pend2'); end $d$$q$, 'booking.immutable', 'a made-up request id does not unlock the booking');
select tests.throws($q$do $d$ begin perform set_config('app.booking_discount_apply', tests.ref('r_rej')::text, true); update public.workshop_bookings set discount_type = 'percent', discount_value = 90, discount_amount = 900, final_price = 100, discount_reason = 'sneaky' where id = tests.ref('b_pend2'); end $d$$q$, 'booking.immutable', 'an approved request of ANOTHER booking does not unlock this one');
select tests.throws($q$do $d$ begin perform set_config('app.booking_discount_apply', tests.ref('r_m11')::text, true); update public.workshop_bookings set discount_type = 'percent', discount_value = 20, discount_amount = 200, final_price = 800, discount_reason = 'repeat customer' where id = tests.ref('b_m11'); end $d$$q$, 'booking.immutable', 'a booking that already has its discount cannot be changed again');
select tests.throws($q$update public.booking_discount_requests set status = 'approved', decided_by = tests.uid('admin_a'), decided_at = now(), applied_final = calculated_final where id = tests.ref('r_pend2')$q$, 'discount.immutable', 'a request cannot be approved outside approve_booking_discount (owner role)');
select tests.throws($q$update public.booking_discount_requests set reason = 'edited' where id = tests.ref('r_m11')$q$, 'discount.immutable', 'a decided request cannot be edited');
select tests.throws($q$delete from public.booking_discount_requests$q$, 'discount.immutable', 'requests cannot be deleted');
select tests.throws($q$truncate public.booking_discount_requests$q$, 'discount.immutable', 'nor truncated');
select tests.eq((select final_price from public.workshop_bookings where id = tests.ref('b_pend2')), 1000::numeric, 'the booking is still at the full price after all attempts');

-- snapshots and currency ---------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.set_workshop_price(tests.ref('dw'), 'QA', 'online', 'QAR', 1500);
select tests.login('agent_a1');
select tests.eq(pg_temp.row('m11'), '899.90|100.10|approved|unpaid|899.90', 'a price change does not touch an approved booking');
select tests.eq((select list_price from public.workshop_bookings where id = tests.ref('b_pend2')), 1000::numeric, 'nor a booking with a pending discount');
select tests.logout();
select tests.eq((select list_price || '>' || calculated_final from public.booking_discount_requests where id = tests.ref('r_pend2')), '1000.00>600.00', 'nor the request (its price snapshot stays 1000)');
select pg_temp.mk('eg', 'agent_a1', 'c14', 'percent', 20, 'egypt promo', 'EG');
select tests.login('mgr_a');
select public.approve_booking_discount(tests.ref('r_eg'));
create temp table s1 as select * from public.workshop_stats(tests.ref('dw'));
select tests.eq((select count(*) from s1, jsonb_array_elements(by_currency)), 2::bigint, 'two currencies in the statistics, never merged');
select tests.eq((select (e ->> 'currency') || ' ' || (e ->> 'discounts')::numeric || ' ' || (e ->> 'total_list')::numeric from s1, jsonb_array_elements(by_currency) e where e ->> 'currency' = 'EGP'), 'EGP 400.00 2000.00', 'EGP discount 400 on a 2000 price stays in EGP');
select tests.eq((select (e ->> 'currency') from s1, jsonb_array_elements(by_currency) e where e ->> 'currency' = 'QAR'), 'QAR', 'QAR is its own entry');

-- reads, visibility, isolation ---------------------------------------------------------------------------------------------------------------
select tests.login('agent_a2');
select tests.eq((select count(*) from public.discount_requests_list(tests.ref('alpha'), null)), 0::bigint, 'an unrelated employee sees no requests');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.discount_requests_list(tests.ref('alpha'), 'pending') where is_mine and not can_decide), (select count(*) from public.discount_requests_list(tests.ref('alpha'), 'pending')),
  'the requester sees their own pending requests and may not decide any');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.discount_requests_list(tests.ref('alpha'), 'pending') where can_decide), 1::bigint, 'the manager may decide only the manager-level pending request they did not create (the 40 % ones need an admin)');
select tests.login('admin_a');
select tests.eq((select count(*) from public.discount_requests_list(tests.ref('alpha'), 'pending') where can_decide), 3::bigint, 'the admin may decide every pending request that is not their own (admin level and manager level)');
select tests.login('admin_b');
select tests.throws($q$select * from public.discount_requests_list(tests.ref('alpha'))$q$, 'auth.forbidden', 'another company cannot list requests');
select tests.throws($q$select * from public.customer_payment_rows(tests.ref('alpha'))$q$, 'auth.forbidden', 'nor customer payments');
select tests.eq((select count(*) from public.booking_discount_requests), 0::bigint, 'nor read the table');
select tests.login('agent_a2');
select tests.eq((select count(*) from public.customer_payment_rows(tests.ref('alpha'))), 0::bigint, 'an employee sees only their own bookings in customer payments');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.customer_payment_rows(tests.ref('alpha'), tests.ref('dw'), null, null, 'paid')), 1::bigint, 'filter by status: one paid booking (the approved free seat)');
select tests.eq((select count(*) from public.customer_payment_rows(tests.ref('alpha'), null, null, null, null, 'EGP')), 1::bigint, 'filter by currency: EGP');
select tests.eq((select count(*) from public.customer_payment_rows(tests.ref('alpha'), null, null, tests.ref('c1'))), 1::bigint, 'filter by customer');
select tests.eq((select (select count(*) from public.customer_payment_rows(tests.ref('alpha'), null, null, null, null, null, t.d + 1, t.d + 5)) from (select (now() at time zone c.timezone)::date as d from public.companies c where c.id = tests.ref('alpha')) t), 0::bigint, 'filter by date: nothing booked in the future (company calendar day)');
select tests.eq((select (select count(*) from public.customer_payment_rows(tests.ref('alpha'), null, null, null, null, null, t.d, t.d)) from (select (now() at time zone c.timezone)::date as d from public.companies c where c.id = tests.ref('alpha')) t) > 10, true, 'filter by date: today''s bookings (company calendar day, not the UTC date)');
select tests.throws($q$select * from public.customer_payment_rows(tests.ref('alpha'), null, null, null, 'bogus')$q$, 'filter.invalid', 'an unknown status filter is refused');
select tests.eq((select pending || '/' || rejected || '/' || remaining from public.customer_payment_rows(tests.ref('alpha'), null, null, tests.ref('c11'))), '950.00/0.00/1000.00', 'money columns: pending 950, rejected 0, remaining 1000');

-- single-booking reads ---------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select final_price || '/' || discount_status || '/' || offering_name from public.booking_detail(tests.ref('b_m11'))), '899.90/approved/Discount W', 'booking_detail: the creator reads their booking');
select tests.login('agent_a2');
select tests.throws($q$select * from public.booking_detail(tests.ref('b_m11'))$q$, 'booking.not_found', 'booking_detail: an employee who did not create it gets nothing');
select tests.throws($q$select * from public.booking_payments(tests.ref('b_m11'))$q$, 'booking.not_found', 'booking_payments: same');
select tests.login('admin_b');
select tests.throws($q$select * from public.booking_detail(tests.ref('b_m11'))$q$, 'booking.not_found', 'booking_detail: another company gets nothing');
select tests.login('mgr_a');
select tests.eq((select count(*) from public.booking_payments(tests.ref('b_pay'))), 1::bigint, 'booking_payments: a manager reads the payments of a booking');
select tests.eq((select amount || ' ' || currency || ' ' || status || ' ' || recorded_by from public.booking_payments(tests.ref('b_pay'))), '950.00 QAR pending Agent Alpha One', 'booking_payments: amount, currency, status and recorder');

-- audit --------------------------------------------------------------------------------------------------------------------------------------
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'discount.approved'), 7::bigint, 'every approval is audited');
select tests.eq((select count(*) from public.audit_logs where action = 'discount.rejected'), 2::bigint, 'every rejection decision is audited (a request closed by a cancellation is covered by booking.cancelled)');
select tests.eq((select count(*) from public.audit_logs where action = 'discount.requested'), 16::bigint, 'every request is audited (15 at booking time or on an existing booking, plus the late one)');
rollback;
