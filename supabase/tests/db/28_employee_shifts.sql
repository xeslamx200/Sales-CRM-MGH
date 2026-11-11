-- Employee shifts and the shift activity report (proposed migration 988). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..988 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/28_employee_shifts.sql
-- The company is switched to Africa/Cairo (the MGH zone, with daylight saving) for the whole test. ISO weekdays: 1 = Monday ... 7 = Sunday; Sun-Thu = {7,1,2,3,4}.
begin;
select tests.logout();
update public.companies set timezone = 'Africa/Cairo' where id = tests.ref('alpha');

-- who may set shifts ---------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-01-01')$q$, 'auth.forbidden', 'an agent cannot set a shift (not even their own)');
select tests.login('mgr_a');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-01-01')$q$, 'auth.forbidden', 'a sales manager cannot (admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-01-01')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_b'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-01-01')$q$, 'shift.invalid_user', 'the employee must be an active member of the company');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '10:00', array[7,1,2,3,4]::smallint[], date '2026-01-01')$q$, 'shift.invalid_value', 'start and end cannot be equal');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[]::smallint[], date '2026-01-01')$q$, 'shift.invalid_value', 'at least one weekday');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[8]::smallint[], date '2026-01-01')$q$, 'shift.invalid_value', 'weekdays are 1..7');
select tests.eq((select count(*) from public.employee_shifts), 0::bigint, 'failed attempts stored nothing');
select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4,1]::smallint[], date '2026-01-01');
select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a2'), time '22:00', time '06:00', array[7,1,2,3,4]::smallint[], date '2026-02-01');
select tests.eq((select weekdays::text from public.employee_shifts where user_id = tests.uid('agent_a1')), '{1,2,3,4,7}', 'weekdays are stored sorted and de-duplicated');
select tests.throws($q$insert into public.employee_shifts (company_id, user_id, starts_at, ends_at, weekdays, effective_from) values (tests.ref('alpha'), tests.uid('agent_a1'), '09:00', '17:00', '{1}', '2026-01-01')$q$, 'permission denied', 'no direct write');

-- in_shift: 10:00 - 19:00 Sunday-Thursday, Cairo time, end exclusive, daylight saving respected ---------------------------------------------------
select tests.logout();
create or replace function pg_temp.ins(p_user text, p_ts text) returns boolean language sql as $$ select app.in_shift(tests.ref('alpha'), tests.uid(p_user), p_ts::timestamptz) $$;
select tests.eq(pg_temp.ins('agent_a1', '2026-07-05 07:00:00+00'), true, 'July (UTC+3), Sunday 10:00 Cairo: inside');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-05 06:59:00+00'), false, 'Sunday 09:59: outside');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-05 15:59:00+00'), true, 'Sunday 18:59: inside');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-05 16:00:00+00'), false, 'Sunday 19:00: outside (the end is exclusive)');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-03 09:00:00+00'), false, 'Friday 12:00: a day off');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-04 09:00:00+00'), false, 'Saturday 12:00: a day off');
select tests.eq(pg_temp.ins('agent_a1', '2026-01-04 08:00:00+00'), true, 'January (UTC+2), Sunday 10:00 Cairo = 08:00Z: inside (daylight saving handled)');
select tests.eq(pg_temp.ins('agent_a1', '2026-01-04 07:00:00+00'), false, 'January 07:00Z is only 09:00 Cairo: outside');
select tests.eq(pg_temp.ins('agent_b', '2026-07-05 08:00:00+00'), false, 'someone without a shift is never "inside"');
-- a shift crossing midnight (22:00 - 06:00): it belongs to the day it started ------------------------------------------------------------------------
select tests.eq(pg_temp.ins('agent_a2', '2026-07-05 20:00:00+00'), true, 'night shift: Sunday 23:00 Cairo inside');
select tests.eq(pg_temp.ins('agent_a2', '2026-07-05 23:00:00+00'), true, 'night shift: Monday 02:00 Cairo is still the Sunday shift: inside');
select tests.eq(pg_temp.ins('agent_a2', '2026-07-09 23:00:00+00'), true, 'night shift: Friday 02:00 Cairo belongs to Thursday''s shift: inside');
select tests.eq(pg_temp.ins('agent_a2', '2026-07-10 20:00:00+00'), false, 'night shift: Friday 23:00 is not a working evening');
select tests.eq(pg_temp.ins('agent_a2', '2026-07-10 23:00:00+00'), false, 'night shift: Saturday 02:00 would belong to Friday: outside');
select tests.eq(pg_temp.ins('agent_a2', '2026-07-06 04:00:00+00'), false, 'night shift: Monday 07:00 Cairo is after 06:00: outside');

-- a new shift keeps history: past days are judged with the shift of that time -------------------------------------------------------------------
select tests.login('admin_a');
select tests.throws($q$select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '09:00', time '17:00', array[7,1,2,3,4]::smallint[], date '2025-12-01')$q$, 'shift.invalid_period', 'a new shift cannot start before the one it replaces');
select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '09:00', time '17:00', array[7,1,2,3,4]::smallint[], date '2026-08-01');
select tests.logout();
select tests.eq((select count(*) || '/' || count(*) filter (where effective_to is null) from public.employee_shifts where user_id = tests.uid('agent_a1')), '2/1', 'two rows: the old one closed, the new one open');
select tests.eq((select effective_to::text from public.employee_shifts where user_id = tests.uid('agent_a1') and effective_to is not null), '2026-07-31', 'the old shift ends the day before');
select tests.eq(pg_temp.ins('agent_a1', '2026-07-05 07:00:00+00'), true, 'July is judged with the OLD shift (10:00 inside)');
select tests.eq(pg_temp.ins('agent_a1', '2026-08-02 15:30:00+00'), false, 'August Sunday 18:30 Cairo: outside the NEW 09:00-17:00 shift');
select tests.eq(pg_temp.ins('agent_a1', '2026-08-02 06:30:00+00'), true, 'August Sunday 09:30 Cairo: inside the new shift');
select tests.login('admin_a');
select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-08-01');
select tests.logout();
select tests.eq((select count(*) from public.employee_shifts where user_id = tests.uid('agent_a1')), 2::bigint, 'setting again for the same start day replaces it (no duplicate)');
select tests.eq(pg_temp.ins('agent_a1', '2026-08-02 15:30:00+00'), true, 'and the replacement (10:00-19:00 again) applies');

-- the report ---------------------------------------------------------------------------------------------------------------------------------------
-- agent_a1, week 5-10 July 2026 (old shift 10:00-19:00 Sun-Thu): Sunday has replies / a lead / a payment, Monday nothing, Friday (day off) one reply
create temp table sh_conv as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'sh.c1', '97455570001', 'Shift Customer', 'text', 'hello', null, '2026-07-04 20:00+00') limit 1;
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select c.id, 'outbound', 'delivered', 'r', tests.uid('agent_a1'), x.ts::timestamptz, x.w from public.conversations c,
  (values ('2026-07-05 07:05+00', 'sh.o1'), ('2026-07-05 09:00+00', 'sh.o2'), ('2026-07-05 16:30+00', 'sh.o3'), ('2026-07-10 08:00+00', 'sh.o4')) x(ts, w) where c.customer_wa_id = '97455570001';
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select c.id, 'outbound', 'failed', 'never sent', tests.uid('agent_a1'), '2026-07-05 08:00+00'::timestamptz, 'sh.o5' from public.conversations c where c.customer_wa_id = '97455570001';
alter table public.leads disable trigger leads_guard;
insert into public.contacts (full_name, phone_e164) values ('Shift Lead', '+201099980001');
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
select tests.ref('alpha'), id, 'Shift lead', tests.uid('agent_a1'), tests.uid('agent_a1'), '2026-07-05 06:00+00'::timestamptz from public.contacts where phone_e164 = '+201099980001';
alter table public.leads enable trigger leads_guard;
insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Shift W', 'workshop');
insert into public.payments (company_id, contact_id, offering_id, amount, currency, fx_rate_to_egp, fx_source, kind, paid_on, created_by, created_at)
select tests.ref('alpha'), k.id, o.id, 100, 'EGP', 1, 'egp', 'partial', date '2026-07-05', tests.uid('agent_a1'), '2026-07-05 09:30+00'::timestamptz
from public.contacts k, public.company_offerings o where k.phone_e164 = '+201099980001' and o.name = 'Shift W';

select tests.login('admin_a');
create temp table sa as select * from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10') where user_id = tests.uid('agent_a1');
select tests.eq((select count(*) from sa), 6::bigint, 'agent_a1: Sunday-Thursday (working) plus Friday (day off with activity); Saturday is omitted');
select tests.eq((select in_shift || '/' || out_of_shift from sa where day = '2026-07-05'), '3/2', 'Sunday: 3 inside (2 replies + the payment), 2 outside (reply at 19:30, lead at 09:00)');
select tests.eq((select replies_in || '/' || replies_out || ' leads ' || leads_in || '/' || leads_out || ' pay ' || payments_in || '/' || payments_out from sa where day = '2026-07-05'), '2/1 leads 0/1 pay 1/0', 'by kind: the failed reply is not counted');
select tests.eq((select shift_starts || '-' || shift_ends from sa where day = '2026-07-05'), '10:00:00-19:00:00', 'the shift of the day is shown');
select tests.eq((select (first_activity at time zone 'Africa/Cairo')::time || ' ' || (last_activity at time zone 'Africa/Cairo')::time from sa where day = '2026-07-05'), '09:00:00 19:30:00', 'first and last activity (Cairo time)');
select tests.eq((select working_day || '/' || in_shift || '/' || out_of_shift || '/' || (first_activity is null)::text from sa where day = '2026-07-06'), 'true/0/0/true', 'Monday: a working day without any activity is listed (absent)');
select tests.eq((select working_day || '/' || in_shift || '/' || out_of_shift || '/' || (shift_starts is null)::text from sa where day = '2026-07-10'), 'false/0/1/true', 'Friday (day off): the reply is entirely outside the shift');
select tests.eq((select count(*) from sa where day = '2026-07-11'), 0::bigint, 'a day off without activity is not listed');
select tests.eq((select count(*) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-09') where user_id = tests.uid('agent_a2')), 5::bigint, 'agent_a2 (night shift): 5 working days listed');
select tests.throws($q$select * from public.report_shift_activity(tests.ref('alpha'), date '2026-07-10', date '2026-07-05')$q$, 'report.invalid_period', 'reversed period refused');
select tests.throws($q$select * from public.report_shift_activity(tests.ref('alpha'), date '2026-01-01', date '2026-07-05')$q$, 'report.invalid_period', 'more than 92 days refused');

-- visibility, exclusions, tenants ----------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select count(distinct user_id) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')), 1::bigint, 'an employee sees only their own shift report');
select tests.login('mgr_a');
select tests.eq((select count(distinct user_id) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')), 1::bigint, 'a team manager sees their team (agent_a1), not the other team (agent_a2)');
select tests.login('admin_a');
select tests.eq((select count(distinct user_id) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')), 2::bigint, 'an admin sees everyone with a shift');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), true, 'test account');
select tests.eq((select count(distinct user_id) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')), 1::bigint, 'people excluded from performance are left out');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), false);
select tests.login('admin_b');
select tests.throws($q$select * from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')$q$, 'auth.forbidden', 'another company is refused');
select tests.eq((select count(*) from public.employee_shifts), 0::bigint, 'and sees no shifts');
select tests.login('agent_a2');
select tests.eq((select count(*) from public.employee_shifts), 1::bigint, 'an employee can read their own shift row (not others'')');
select tests.login_anon();
select tests.throws($q$select * from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-10')$q$, 'permission denied', 'anonymous refused');

-- clearing ------------------------------------------------------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select tests.throws($q$select public.clear_employee_shift(tests.ref('alpha'), tests.uid('agent_a2'), date '2026-07-31')$q$, 'auth.forbidden', 'a manager cannot clear');
select tests.login('admin_a');
select tests.throws($q$select public.clear_employee_shift(tests.ref('alpha'), tests.uid('agent_b'), date '2026-07-31')$q$, 'shift.not_found', 'no open shift to clear');
select public.clear_employee_shift(tests.ref('alpha'), tests.uid('agent_a2'), date '2026-07-07');
select tests.eq((select count(*) from public.report_shift_activity(tests.ref('alpha'), date '2026-07-05', date '2026-07-09') where user_id = tests.uid('agent_a2')), 3::bigint, 'after clearing (to 7 July) only the days up to then are reported');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action in ('shift.set', 'shift.cleared')), 5::bigint, 'every change is audited');
rollback;
