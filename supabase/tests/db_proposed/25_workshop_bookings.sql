-- Workshop bookings, discounts and booking payments (proposed migration 985; needs 984). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..985 + _helpers.sql + _fixtures.sql> -f supabase/tests/db_proposed/25_workshop_bookings.sql
begin;
select tests.logout();

-- fixtures ----------------------------------------------------------------------------------------------------------------------------------
select public.upsert_fx_rates('{"QAR": 14.1}'::jsonb, 'test-source');
do $$
declare w uuid; g1 uuid; g2 uuid; g3 uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Booking W', 'workshop') returning id into w;
  insert into tests.refs values ('bw', w);
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 500), (tests.ref('alpha'), w, 'QA', 'offline', 'QAR', 750), (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 2500);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance) values
    (tests.ref('alpha'), w, 'G1', array[date '2026-12-06', date '2026-12-08'], date '2026-12-06', date '2026-12-08', 2, 'online') returning id into g1;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance) values
    (tests.ref('alpha'), w, 'G2', array[date '2026-12-13', date '2026-12-15'], date '2026-12-13', date '2026-12-15', null, null) returning id into g2;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, is_active) values
    (tests.ref('alpha'), w, 'G3 closed', array[date '2026-12-20'], date '2026-12-20', date '2026-12-20', false) returning id into g3;
  insert into tests.refs values ('g1', g1), ('g2', g2), ('g3', g3);
  for i in 1..8 loop
    insert into public.contacts (full_name, phone_e164, email) values ('Booker ' || i, '+2010666' || lpad(i::text, 5, '0'), 'booker' || i || '@example.test') returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('k' || i, c);
  end loop;
end $$;
create or replace function pg_temp.book(p_user text, p_contact text, p_group text, p_country text, p_att text, p_dt text default 'none', p_dv numeric default 0, p_reason text default null)
returns uuid language plpgsql as $$ declare v uuid; begin perform tests.login(p_user); v := public.create_workshop_booking(tests.ref(p_contact), tests.ref(p_group), p_country, p_att, p_dt, p_dv, p_reason); return v; end $$;
create or replace function pg_temp.st(p_booking uuid) returns text language sql as $$
  select payment_status || ' conf=' || confirmed || ' pend=' || pending || ' rem=' || remaining from public.workshop_bookings_list(tests.ref('bw')) where booking_id = p_booking $$;

create temp table bk (b1 uuid, b2 uuid, b3 uuid, b4 uuid, b5 uuid, p1 uuid, p2 uuid, p3 uuid, p4 uuid, p5 uuid);
insert into bk default values;
grant all on bk to public;

-- permissions and basic refusals ----------------------------------------------------------------------------------------------------------
select tests.login_anon();
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g1'), 'QA', 'online')$q$, 'permission denied', 'anonymous refused');
select tests.login('agent_b');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g1'), 'QA', 'online')$q$, 'booking.group_not_found', 'another company cannot book into this group');
select tests.login('agent_a2');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g1'), 'QA', 'online')$q$, 'booking.contact_not_found', 'an employee cannot book a customer they cannot see');
select tests.login('agent_a1');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g3'), 'QA', 'online')$q$, 'booking.group_inactive', 'an inactive group cannot be booked');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g1'), 'QA', 'offline')$q$, 'booking.attendance_mismatch', 'the group is online only');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g2'), 'SA', 'online')$q$, 'booking.price_not_configured', 'no price for Saudi Arabia: the system does not assume one');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g2'), 'EG', 'offline')$q$, 'booking.price_not_configured', 'no price for Egypt in person either');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g2'), 'QAT', 'online')$q$, 'booking.invalid_value', 'country must be 2 letters');
select tests.eq((select count(*) from public.workshop_bookings), 0::bigint, 'nothing was booked by the refused attempts');

-- price frozen at booking time ---------------------------------------------------------------------------------------------------------
update bk set b1 = pg_temp.book('agent_a1', 'k1', 'g1', 'QA', 'online');
select tests.eq((select list_price || ' ' || currency || ' final ' || final_price || ' ' || discount_type from public.workshop_bookings where id = (select b1 from bk)), '500.00 QAR final 500.00 none', 'booking 1: price read from the matrix and frozen (500 QAR, no discount)');
select tests.login('admin_a');
select public.set_workshop_price(tests.ref('bw'), 'QA', 'online', 'QAR', 600);
select tests.eq((select list_price from public.workshop_bookings where id = (select b1 from bk)), 500::numeric, 'a later price change does NOT touch the existing booking');

-- discounts ----------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'percent', 10, null)$q$, 'booking.discount_reason_required', 'a discount needs a reason');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'percent', 10, 'ab')$q$, 'booking.discount_reason_required', 'a too-short reason is refused');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'percent', 101, 'promo')$q$, 'booking.invalid_discount', 'over 100 % refused');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'percent', 0, 'promo')$q$, 'booking.invalid_discount', 'a zero discount is not a discount');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'fixed', 601, 'promo')$q$, 'booking.invalid_discount', 'a fixed discount above the price refused');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'fixed', 10.123, 'promo')$q$, 'booking.invalid_discount', 'more than 2 decimals refused');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k2'), tests.ref('g1'), 'QA', 'online', 'voucher', 10, 'promo')$q$, 'booking.invalid_discount', 'unknown discount type refused');
update bk set b2 = pg_temp.book('agent_a1', 'k2', 'g1', 'QA', 'online', 'percent', 10, 'loyal customer');
select tests.login('agent_a1');
select tests.eq((select list_price || '/' || discount_type || '/' || discount_value || '/' || discount_amount || '/' || final_price from public.workshop_bookings where id = (select b2 from bk)), '600.00/percent/10.00/60.00/540.00',
  'booking 2: new price 600, 10 % = 60, final 540 (the database computes it)');
select tests.eq((select discount_reason from public.workshop_bookings where id = (select b2 from bk)), 'loyal customer', 'the discount reason is stored');
update bk set b3 = pg_temp.book('agent_a1', 'k4', 'g2', 'EG', 'online', 'fixed', 500, 'bank holiday offer');
select tests.login('admin_a');
select public.approve_booking_discount((select id from public.booking_discount_requests where booking_id = (select b3 from bk)));   -- 986: 20 % needs a manager / admin
select tests.login('agent_a1');
select tests.eq((select list_price || '>' || final_price || ' ' || currency from public.workshop_bookings where id = (select b3 from bk)), '2500.00>2000.00 EGP', 'booking 3: 2500 EGP less a fixed 500 = 2000 EGP');
update bk set b4 = pg_temp.book('agent_a1', 'k5', 'g2', 'QA', 'offline', 'percent', 100, 'sponsored seat');
select tests.login('admin_a');
select public.approve_booking_discount((select id from public.booking_discount_requests where booking_id = (select b4 from bk)));   -- 986: 100 % needs an admin
select tests.login('agent_a1');
select tests.eq((select final_price from public.workshop_bookings where id = (select b4 from bk)), 0::numeric, '100 % discount: final price 0');
select tests.eq(pg_temp.st((select b4 from bk)), 'paid conf=0.00 pend=0.00 rem=0.00', 'a free seat is paid immediately');

-- duplicates and capacity --------------------------------------------------------------------------------------------------------------------
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g1'), 'QA', 'online')$q$, 'booking.duplicate', 'the same customer cannot be booked twice in a group');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k1'), tests.ref('g2'), 'QA', 'online')$q$, 'booking.duplicate', 'nor in a second group of the same workshop while the first has not finished');
select tests.throws($q$select public.create_workshop_booking(tests.ref('k3'), tests.ref('g1'), 'QA', 'online')$q$, 'booking.group_full', 'the group holds 2 and is full');
select tests.login('mgr_a');
select tests.throws($q$select public.cancel_workshop_booking((select b2 from bk), 'x')$q$, 'booking.reason_required', 'a cancellation needs a reason');
select public.cancel_workshop_booking((select b2 from bk), 'customer changed plans');
select tests.eq((select status from public.workshop_bookings where id = (select b2 from bk)), 'cancelled', 'a manager cancels a booking (never deletes)');
select tests.throws($q$select public.cancel_workshop_booking((select b2 from bk), 'again')$q$, 'booking.invalid_transition', 'cancelling twice is refused');
select tests.login('agent_a1');
update bk set b5 = pg_temp.book('agent_a1', 'k3', 'g1', 'QA', 'online');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.workshop_bookings where group_id = tests.ref('g1') and status = 'booked'), 2::bigint, 'the freed seat was taken: the group is full again');

-- payments -----------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.pay(p_user text, p_booking uuid, p_amount numeric) returns uuid language plpgsql as $$ begin perform tests.login(p_user); return public.record_booking_payment(p_booking, p_amount, current_date, null); end $$;
create or replace function pg_temp.decide(p_payment uuid, p_decision text) returns void language plpgsql as $$ begin perform tests.login('admin_a'); perform public.review_payment(p_payment, p_decision, case when p_decision = 'rejected' then 'not received' else null end); end $$;
select tests.login('agent_a2');
select tests.throws($q$select public.record_booking_payment((select b1 from bk), 100)$q$, 'booking.not_found', 'an employee cannot pay a booking they cannot see');
select tests.login('agent_a1');
select tests.throws($q$select public.record_booking_payment((select b1 from bk), 0)$q$, 'payment.invalid_amount', 'zero refused');
select tests.throws($q$select public.record_booking_payment((select b1 from bk), 10.123)$q$, 'payment.invalid_amount', 'more than 2 decimals refused');
update bk set p1 = pg_temp.pay('agent_a1', b1, 200);
select tests.login('agent_a1');
select tests.throws($q$select public.record_booking_payment((select b1 from bk), 400)$q$, 'booking.overpayment', 'pending money counts: 200 + 400 > 500');
update bk set p2 = pg_temp.pay('agent_a1', b1, 300);
select tests.login('agent_a1');
select tests.eq((select kind from public.payments where id = (select p2 from bk)), 'full', 'paying exactly the remainder is a full payment');
select tests.eq((select kind from public.payments where id = (select p1 from bk)), 'partial', 'the first was partial');
select tests.eq((select currency || ' ' || amount_egp || ' ' || (booking_id = (select b1 from bk))::text from public.payments where id = (select p1 from bk)), 'QAR 2820.00 true', 'the payment is in the booking currency, linked to it, with the rate read by the database (200 x 14.1)');
select tests.eq(pg_temp.st((select b1 from bk)), 'pending_approval conf=0.00 pend=500.00 rem=500.00', 'only pending money: Pending Approval, nothing collected');
select tests.throws($q$select public.record_booking_payment((select b1 from bk), 1)$q$, 'booking.overpayment', 'fully covered by pending money: nothing more can be paid');
select pg_temp.decide((select p1 from bk), 'confirmed');
select tests.login('agent_a1');
select tests.eq(pg_temp.st((select b1 from bk)), 'partially_paid conf=200.00 pend=300.00 rem=300.00', 'one confirmed: Partially Paid, remaining 300');
select pg_temp.decide((select p2 from bk), 'confirmed');
select tests.login('agent_a1');
select tests.eq(pg_temp.st((select b1 from bk)), 'paid conf=500.00 pend=0.00 rem=0.00', 'all confirmed: Paid, remaining 0');
select tests.throws($q$select public.cancel_workshop_booking((select b1 from bk), 'no longer')$q$, 'booking.has_payments', 'a booking with money cannot be cancelled');
-- EGP booking, partial
update bk set p3 = pg_temp.pay('agent_a1', b3, 1000);
select pg_temp.decide((select p3 from bk), 'confirmed');
select tests.login('agent_a1');
select tests.eq(pg_temp.st((select b3 from bk)), 'partially_paid conf=1000.00 pend=0.00 rem=1000.00', 'EGP booking: 1000 of 2000 collected; remaining 1000');
select tests.eq((select amount_egp from public.payments where id = (select p3 from bk)), 1000::numeric, 'EGP needs no conversion');
-- rejected then paid again
update bk set p4 = pg_temp.pay('agent_a1', b5, 100);
select pg_temp.decide((select p4 from bk), 'rejected');
select tests.login('agent_a1');
select tests.eq(pg_temp.st((select b5 from bk)), 'rejected conf=0.00 pend=0.00 rem=600.00', 'a rejected payment: status Rejected, the full amount is still due');
update bk set p5 = pg_temp.pay('agent_a1', b5, 600);
select tests.login('agent_a1');
select tests.eq(pg_temp.st((select b5 from bk)), 'pending_approval conf=0.00 pend=600.00 rem=600.00', 'paying again after a rejection works');
select tests.throws($q$select public.cancel_workshop_booking((select b5 from bk), 'cancel it')$q$, 'booking.has_payments', 'a pending payment also blocks cancellation');
select tests.throws($q$select public.record_booking_payment((select b2 from bk), 100)$q$, 'booking.invalid_transition', 'a cancelled booking cannot be paid');

-- immutability --------------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select tests.throws($q$update public.workshop_bookings set final_price = 1$q$, 'permission denied', 'no direct update of a booking');
select tests.throws($q$delete from public.workshop_bookings$q$, 'permission denied', 'no direct delete of a booking');
select tests.logout();
select tests.throws($q$update public.workshop_bookings set final_price = 1, discount_amount = 499, list_price = 500 where id = (select b1 from bk)$q$, 'booking.immutable', 'even the owner role cannot change the agreed price');
select tests.throws($q$update public.workshop_bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = 'sneaky' where id = (select b1 from bk)$q$, 'booking.immutable', 'nor cancel outside the function');
select tests.throws($q$delete from public.workshop_bookings$q$, 'booking.immutable', 'nor delete');
select tests.throws($q$update public.payments set booking_id = null where id = (select p1 from bk)$q$, 'payment.immutable', 'a payment cannot be moved to another booking');
select tests.throws($q$update public.workshop_bookings set discount_amount = 999 where id = (select b3 from bk)$q$, 'booking.immutable', 'the discount cannot be edited afterwards');
select tests.throws($q$insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price, discount_type, discount_value, discount_amount, final_price, created_by)
  values (tests.ref('alpha'), tests.ref('k6'), tests.ref('bw'), tests.ref('g2'), 'QA', 'online', 'QAR', 100, 'none', 0, 0, 90, tests.uid('agent_a1'))$q$, 'violates check constraint', 'a final price that is not price minus discount is impossible');

-- visibility, lists and statistics -------------------------------------------------------------------------------------------------------
select tests.login('agent_a2');
select tests.eq((select count(*) from public.workshop_bookings_list(tests.ref('bw'))), 0::bigint, 'an employee sees only bookings they created (none here)');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.workshop_bookings_list(tests.ref('bw'))), 5::bigint, 'the creator sees their 5 bookings (one cancelled)');
select tests.eq((select customer_name || ' ' || phone || ' ' || email || ' ' || country || ' ' || attendance || ' ' || group_name from public.workshop_bookings_list(tests.ref('bw')) where booking_id = (select b1 from bk)),
  'Booker 1 +201066600001 booker1@example.test QA online G1', 'the list carries customer, phone, email, country, attendance and group');
select tests.login('admin_b');
select tests.throws($q$select * from public.workshop_bookings_list(tests.ref('bw'))$q$, 'auth.forbidden', 'another company is refused');
select tests.throws($q$select * from public.workshop_stats(tests.ref('bw'))$q$, 'auth.forbidden', 'including the statistics');
select tests.login('admin_a');
create temp table ws as select * from public.workshop_stats(tests.ref('bw'));
select tests.eq((select active_bookings || '/' || paid || '/' || partially_paid || '/' || unpaid || '/' || pending_approval || '/' || rejected || '/' || cancelled_bookings from ws), '4/2/1/0/1/0/1',
  'stats: 4 active bookings = 2 paid (one is the free seat) + 1 partially paid + 1 pending approval; 1 cancelled');
select tests.eq((select online_participants || '/' || offline_participants from ws), '3/1', 'online 3, in person 1');
select tests.eq((select (by_currency -> 1 ->> 'currency') || ' ' || (by_currency -> 1 ->> 'collected')::numeric || ' ' || (by_currency -> 1 ->> 'outstanding')::numeric || ' ' || (by_currency -> 1 ->> 'total_final')::numeric || ' ' || (by_currency -> 1 ->> 'discounts')::numeric from ws),
  'QAR 500.00 600.00 1100.00 750.00', 'QAR: collected 500, outstanding 600, final total 1100, discounts 750 (the free seat)');
select tests.eq((select (by_currency -> 0 ->> 'currency') || ' ' || (by_currency -> 0 ->> 'collected')::numeric || ' ' || (by_currency -> 0 ->> 'outstanding')::numeric || ' ' || (by_currency -> 0 ->> 'total_final')::numeric || ' ' || (by_currency -> 0 ->> 'discounts')::numeric from ws),
  'EGP 1000.00 1000.00 2000.00 500.00', 'EGP is kept apart: collected 1000, outstanding 1000, final total 2000, discounts 500 (no currency mixing)');
select tests.eq((select count(*) from public.workshop_group_stats(tests.ref('bw')) where group_name = 'G1' and booked = 2 and capacity = 2), 1::bigint, 'group distribution: G1 holds 2 of 2');
select tests.eq((select count(*) from public.workshop_bookings_list(tests.ref('bw'), tests.ref('g2'))), 2::bigint, 'filtering by group: 2 bookings in G2');

-- money flows into commission only when CONFIRMED and by the person who recorded it --------------------------------------------------------------
select tests.eq((select achieved_amount from public.report_monthly_commission(tests.ref('alpha'), current_date) where user_id = tests.uid('agent_a1')), 8050::numeric,
  'commission base = confirmed money only, in EGP: (200 + 300) QAR x 14.1 = 7050, plus 1000 EGP = 8050 (pending and rejected excluded)');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'booking.created'), 5::bigint, 'every booking is audited');
select tests.eq((select count(*) from public.audit_logs where action = 'booking.cancelled'), 1::bigint, 'every cancellation is audited');
rollback;
