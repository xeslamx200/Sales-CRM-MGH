-- Dashboard figures from workshop bookings and payments (proposed migration 990; needs 984-989). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..990 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/30_workshop_dashboard.sql
-- Period under test: July 2026 (company time zone Asia/Qatar). Money is per currency, never added across currencies.
begin;
select tests.logout();
select public.upsert_fx_rates('{"QAR": 14.1}'::jsonb, 'test-source');

-- fixtures: one workshop (QAR 1000 for QA, EGP 2000 for EG), customers k1..k7 ------------------------------------------------------------------------
do $$
declare w uuid; g uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'WD W', 'workshop') returning id into w;
  insert into tests.refs values ('wdw', w);
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 1000), (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 2000);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'WDG', array[date '2027-12-06'], date '2027-12-06', date '2027-12-06') returning id into g;
  insert into tests.refs values ('wdg', g);
  for i in 1..7 loop
    insert into public.contacts (full_name, phone_e164) values ('WD ' || i, '+2010666' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), case when i = 4 then tests.uid('mgr_a') else tests.uid('agent_a1') end);
    insert into tests.refs values ('k' || i, c);
  end loop;
  -- agent_a1: b1 QAR 1000, b2 QAR 1000 with 10 % (900), b3 EGP 2000, b5 QAR (cancelled), b6 QAR (created in June); mgr_a: b4 QAR 1000
  perform tests.login('agent_a1');
  insert into tests.refs values ('b1', public.create_workshop_booking(tests.ref('k1'), g, 'QA', 'online', 'none', 0, null));
  insert into tests.refs values ('b2', public.create_workshop_booking(tests.ref('k2'), g, 'QA', 'online', 'percent', 10, 'early bird'));
  insert into tests.refs values ('b3', public.create_workshop_booking(tests.ref('k3'), g, 'EG', 'online', 'none', 0, null));
  insert into tests.refs values ('b5', public.create_workshop_booking(tests.ref('k5'), g, 'QA', 'online', 'none', 0, null));
  perform public.cancel_workshop_booking(tests.ref('b5'), 'customer changed mind');
  insert into tests.refs values ('b6', public.create_workshop_booking(tests.ref('k6'), g, 'QA', 'online', 'none', 0, null));
  perform tests.login('mgr_a');
  insert into tests.refs values ('b4', public.create_workshop_booking(tests.ref('k4'), g, 'QA', 'online', 'none', 0, null));
  perform tests.logout();
end $$;
alter table public.workshop_bookings disable trigger user;
update public.workshop_bookings set created_at = '2026-07-10 09:00+00' where id in (tests.ref('b1'), tests.ref('b2'), tests.ref('b3'), tests.ref('b4'), tests.ref('b5'));
update public.workshop_bookings set cancelled_at = '2026-07-12 09:00+00' where id = tests.ref('b5');
update public.workshop_bookings set created_at = '2026-06-20 09:00+00' where id = tests.ref('b6');
alter table public.workshop_bookings enable trigger user;
-- payments: confirmed / pending / rejected, inside and outside July
alter table public.payments disable trigger user;
insert into public.payments (company_id, contact_id, offering_id, booking_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, status, reviewed_by, reviewed_at, created_by, created_at)
select tests.ref('alpha'), (select contact_id from public.workshop_bookings where id = tests.ref(x.b)), tests.ref('wdw'), tests.ref(x.b), x.amt, x.cur,
       case when x.cur = 'EGP' then 1 else 14.1 end, case when x.cur = 'EGP' then 'egp' else 'auto' end, case when x.cur = 'EGP' then null::timestamptz else now() end,
       'partial', x.d::date, x.st, case when x.st = 'pending' then null::uuid else tests.uid('admin_a') end, case when x.st = 'pending' then null::timestamptz else now() end,
       tests.uid(x.who), (x.d || ' 10:00+00')::timestamptz
from (values ('b1', 400, 'QAR', '2026-07-11', 'confirmed', 'agent_a1'), ('b1', 100, 'QAR', '2026-07-12', 'pending', 'agent_a1'),
             ('b2', 900, 'QAR', '2026-07-11', 'confirmed', 'agent_a1'), ('b3', 500, 'EGP', '2026-07-13', 'confirmed', 'agent_a1'),
             ('b4', 50, 'QAR', '2026-07-14', 'rejected', 'mgr_a'), ('b4', 200, 'QAR', '2026-08-02', 'confirmed', 'mgr_a'),
             ('b6', 300, 'QAR', '2026-06-15', 'confirmed', 'agent_a1')) x(b, amt, cur, d, st, who);
alter table public.payments enable trigger user;
-- leads: one for a customer who booked, one for a customer who did not (created in July by agent_a1)
alter table public.leads disable trigger leads_guard;
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
select tests.ref('alpha'), tests.ref(x.k), 'WD lead ' || x.k, tests.uid('agent_a1'), tests.uid('agent_a1'), '2026-07-05 06:00+00'::timestamptz from (values ('k1'), ('k7')) x(k);
alter table public.leads enable trigger leads_guard;

-- admin: the whole company -----------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
create temp table wk as select * from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31');
select tests.eq((select bookings || '/' || cancelled || '/' || customers || '/' || leads_created || '/' || leads_booked from wk where currency is null), '4/1/4/2/1', 'counts of the period: 4 booked (the June one and the cancelled one are not), 1 cancelled, 4 customers, 2 leads of which 1 already booked');
select tests.eq((select count(*) from wk where currency is not null), 2::bigint, 'one money row per currency (QAR, EGP)');
select tests.eq((select bookings || ' ' || list_value || ' ' || discount_total || ' ' || booked_value from wk where currency = 'QAR'), '3 3000.00 100.00 2900.00', 'QAR: 3 bookings, list 3000, discount 100, booked (net) 2900');
select tests.eq((select collected || ' ' || pending || ' ' || remaining from wk where currency = 'QAR'), '1300.00 100.00 2100.00', 'QAR: collected = confirmed paid in July (400 + 900; the August and June ones and the rejected 50 are not); pending 100; remaining snapshot of all active QAR bookings 600 + 0 + 800 + 700');
select tests.eq((select bookings || ' ' || booked_value || ' ' || collected || ' ' || pending || ' ' || remaining from wk where currency = 'EGP'), '1 2000.00 500.00 0 1500.00', 'EGP is its own row, never mixed with QAR');
-- breakdown per workshop and currency
create temp table wb as select * from public.report_workshop_breakdown(tests.ref('alpha'), date '2026-07-01', date '2026-07-31');
select tests.eq((select count(*) from wb), 2::bigint, 'breakdown: one row per workshop and currency');
select tests.eq((select offering_name || ' ' || bookings || ' ' || booked_value || ' ' || collected || ' ' || remaining from wb where currency = 'QAR'), 'WD W 3 2900.00 1300.00 2100.00', 'breakdown QAR equals the KPI row');
select tests.eq((select bookings || ' ' || booked_value || ' ' || collected || ' ' || remaining from wb where currency = 'EGP'), '1 2000.00 500.00 1500.00', 'breakdown EGP');
-- daily series (the revenue chart)
create temp table wd as select * from public.report_workshop_daily(tests.ref('alpha'), date '2026-07-01', date '2026-07-31');
select tests.eq((select day || ' ' || currency || ' ' || bookings || ' ' || booked_value || ' ' || collected from wd where day = '2026-07-10' and currency = 'QAR'), '2026-07-10 QAR 3 2900.00 0', 'daily: 10 July QAR 3 bookings worth 2900, nothing collected that day');
select tests.eq((select day || ' ' || collected from wd where day = '2026-07-11' and currency = 'QAR'), '2026-07-11 1300.00', 'daily: 11 July QAR collected 400 + 900');
select tests.eq((select count(*) from wd), 4::bigint, 'daily: rows only for days and currencies with something (10 July QAR, 10 July EGP, 11 July QAR, 13 July EGP)');
select tests.eq((select sum(collected) from wd where currency = 'QAR'), 1300.00::numeric, 'daily collected adds up to the KPI figure');
-- another period: only the June booking
select tests.eq((select bookings || '/' || booked_value from public.report_workshop_kpis(tests.ref('alpha'), date '2026-06-01', date '2026-06-30') where currency = 'QAR'), '1/1000.00', 'June: the booking made in June');
select tests.eq((select collected from public.report_workshop_kpis(tests.ref('alpha'), date '2026-06-01', date '2026-06-30') where currency = 'QAR'), 300.00::numeric, 'June: collected 300');
-- user filter
select tests.eq((select booked_value || '/' || collected from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31', tests.uid('mgr_a')) where currency = 'QAR'), '1000.00/0', 'filtered to the manager: own booking, no confirmed payment in July (the August one is outside)');
select tests.throws($q$select * from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-31', date '2026-07-01')$q$, 'report.invalid_period', 'reversed period refused');
select tests.throws($q$select * from public.report_workshop_kpis(tests.ref('alpha'), date '2025-01-01', date '2026-07-31')$q$, 'report.invalid_period', 'more than 366 days refused');

-- visibility -------------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select booked_value || '/' || collected || '/' || remaining from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31') where currency = 'QAR'), '1900.00/1300.00/1300.00', 'an agent sees only their own bookings and payments (the manager''s are not included)');
select tests.eq((select bookings || '/' || cancelled from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31') where currency is null), '3/1', 'and own counts');
select tests.login('agent_a2');
select tests.eq((select count(*) from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31') where currency is not null), 0::bigint, 'an agent without bookings has no money rows');
select tests.eq((select bookings from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31') where currency is null), 0::bigint, 'and zero counts');
select tests.eq((select count(*) from public.report_workshop_breakdown(tests.ref('alpha'), date '2026-07-01', date '2026-07-31')), 0::bigint, 'and an empty breakdown');
select tests.login('admin_b');
select tests.throws($q$select * from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31')$q$, 'auth.forbidden', 'another company''s admin is refused');
select tests.throws($q$select * from public.report_workshop_breakdown(tests.ref('alpha'), date '2026-07-01', date '2026-07-31')$q$, 'auth.forbidden', 'also for the breakdown');
select tests.throws($q$select * from public.report_workshop_daily(tests.ref('alpha'), date '2026-07-01', date '2026-07-31')$q$, 'auth.forbidden', 'also for the daily series');
select tests.login_anon();
select tests.throws($q$select * from public.report_workshop_kpis(tests.ref('alpha'), date '2026-07-01', date '2026-07-31')$q$, 'permission denied', 'anonymous cannot call it');
select tests.logout();
rollback;
