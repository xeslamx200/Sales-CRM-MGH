-- Presence and the per-employee daily report (proposed migration 989; needs 984-988). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..989 + _helpers.sql + _fixtures.sql> -f supabase/tests/db_proposed/29_employee_daily_report.sql
-- Day under test: Sunday 2026-07-05, company time zone Africa/Cairo (UTC+3 in July). Shift of agent_a1: 10:00-19:00 Sun-Thu.
begin;
select tests.logout();
update public.companies set timezone = 'Africa/Cairo' where id = tests.ref('alpha');

-- presence --------------------------------------------------------------------------------------------------------------------------------------
select tests.login_anon();
select tests.throws($q$select public.touch_presence(tests.ref('alpha'))$q$, 'permission denied', 'anonymous cannot send a presence signal');
select tests.login('agent_b');
select tests.throws($q$select public.touch_presence(tests.ref('alpha'))$q$, 'auth.forbidden', 'a user of another company cannot');
select tests.login('agent_a1');
select tests.throws($q$insert into public.user_presence_days (company_id, user_id, day) values (tests.ref('alpha'), tests.uid('agent_a1'), current_date)$q$, 'permission denied', 'no direct write');
select public.touch_presence(tests.ref('alpha'));
select tests.eq((select count(*) from public.user_presence_days), 1::bigint, 'the first signal creates today''s row');
select pg_sleep(0.1);
select public.touch_presence(tests.ref('alpha'));
select tests.eq((select count(*) from public.user_presence_days), 1::bigint, 'a second signal keeps one row per day');
select tests.eq((select (last_seen = first_seen)::text from public.user_presence_days), 'true', 'a signal less than 30 seconds after the last write changes nothing (throttle)');
select tests.logout();
update public.user_presence_days set first_seen = now() - interval '2 minutes', last_seen = now() - interval '1 minute';
select tests.login('agent_a1');
select public.touch_presence(tests.ref('alpha'));
select tests.ok((select last_seen > now() - interval '5 seconds' from public.user_presence_days), 'after 30 seconds the last-seen moves forward');
select tests.ok((select first_seen < now() - interval '1 minute' from public.user_presence_days), 'the first-seen never moves');
select tests.login('mgr_a');
select public.touch_presence(tests.ref('alpha'));
select tests.eq((select count(*) from public.user_presence_days), 2::bigint, 'a manager sees both rows');
select tests.login('agent_a2');
select public.touch_presence(tests.ref('alpha'));
select tests.eq((select count(*) from public.user_presence_days), 1::bigint, 'an agent sees only their own presence');
select tests.logout();
delete from public.user_presence_days;
-- known values for the report: agent_a1 opened the CRM at 09:55 Cairo and was last seen at 19:20 (Sunday)
insert into public.user_presence_days (company_id, user_id, day, first_seen, last_seen)
values (tests.ref('alpha'), tests.uid('agent_a1'), date '2026-07-05', '2026-07-05 06:55+00', '2026-07-05 16:20+00');

-- fixtures ----------------------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.set_employee_shift(tests.ref('alpha'), tests.uid('agent_a1'), time '10:00', time '19:00', array[7,1,2,3,4]::smallint[], date '2026-01-01');
select tests.logout();
select public.upsert_fx_rates('{"QAR": 14.1}'::jsonb, 'test-source');
-- chats: c1 opened Sunday 10:30 Cairo (07:30Z), customer asks at 07:30, agent answers 07:32 (120 s); asks again 08:00, answered 08:05 (300 s); c2 opened Sunday, never answered;
-- c3 opened Saturday (outside the day); all owned by agent_a1
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'dr.c1a', '97455580001', 'Daily C1', 'text', 'hello', null, '2026-07-05 07:30+00');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'dr.c2a', '97455580002', 'Daily C2', 'text', 'hello', null, '2026-07-05 09:00+00');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'dr.c3a', '97455580003', 'Daily C3', 'text', 'hello', null, '2026-07-04 09:00+00');
alter table public.conversations disable trigger conversations_guard;
alter table public.conversations disable trigger conversations_sync_lead_owner;
update public.conversations set owner_id = tests.uid('agent_a1'), created_at = '2026-07-05 07:30+00' where customer_wa_id in ('97455580001', '97455580002');
update public.conversations set owner_id = tests.uid('agent_a1'), created_at = '2026-07-04 09:00+00' where customer_wa_id = '97455580003';
alter table public.conversations enable trigger conversations_guard;
alter table public.conversations enable trigger conversations_sync_lead_owner;
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select c.id, 'outbound', 'delivered', 'r', tests.uid('agent_a1'), x.ts::timestamptz, x.w from public.conversations c, (values ('2026-07-05 07:32+00', 'dr.o1')) x(ts, w) where c.customer_wa_id = '97455580001';
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'dr.c1b', '97455580001', 'Daily C1', 'text', 'and another thing', null, '2026-07-05 08:00+00');
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select c.id, 'outbound', 'delivered', 'r2', tests.uid('agent_a1'), '2026-07-05 08:05+00'::timestamptz, 'dr.o2' from public.conversations c where c.customer_wa_id = '97455580001';
-- a reply sent by someone else on a conversation of agent_a1: it counts for the sender, not for the owner
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select c.id, 'outbound', 'delivered', 'by manager', tests.uid('mgr_a'), '2026-07-04 09:10+00'::timestamptz, 'dr.o3' from public.conversations c where c.customer_wa_id = '97455580003';

-- bookings: two QAR (1000 each) and one EGP (2000), one cancelled QAR; payments: one pending QAR 300, one confirmed QAR 200, one rejected QAR 50
do $$
declare w uuid; g uuid; c uuid; i int; b uuid;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Daily W', 'workshop') returning id into w;
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 1000), (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 2000);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'DG1', array[date '2027-12-06'], date '2027-12-06', date '2027-12-06') returning id into g;
  insert into tests.refs values ('dw', w);
  for i in 1..4 loop
    insert into public.contacts (full_name, phone_e164) values ('Daily B ' || i, '+2010555' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('k' || i, c);
  end loop;
  perform tests.login('agent_a1');
  perform public.create_workshop_booking(tests.ref('k1'), g, 'QA', 'online', 'none', 0, null);
  perform public.create_workshop_booking(tests.ref('k2'), g, 'QA', 'online', 'none', 0, null);
  perform public.create_workshop_booking(tests.ref('k3'), g, 'EG', 'online', 'none', 0, null);
  b := public.create_workshop_booking(tests.ref('k4'), g, 'QA', 'online', 'none', 0, null);
  perform public.cancel_workshop_booking(b, 'customer changed mind');
  perform tests.logout();
end $$;
alter table public.workshop_bookings disable trigger user;
update public.workshop_bookings set created_at = '2026-07-05 08:30+00' where created_by = tests.uid('agent_a1');
alter table public.workshop_bookings enable trigger user;
alter table public.payments disable trigger user;
insert into public.payments (company_id, contact_id, offering_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, status, reviewed_by, reviewed_at, created_by, created_at)
select tests.ref('alpha'), tests.ref('k1'), tests.ref('dw'), x.amt, 'QAR', 14.1, 'auto', now(), 'partial', date '2026-07-05', x.st, case when x.st = 'pending' then null::uuid else tests.uid('admin_a') end,
       case when x.st = 'pending' then null::timestamptz else now() end, tests.uid('agent_a1'), '2026-07-05 09:30+00'::timestamptz
from (values (300, 'pending'), (200, 'confirmed'), (50, 'rejected')) x(amt, st);
alter table public.payments enable trigger user;
-- calls, leads, interested ------------------------------------------------------------------------------------------------------------------------
insert into public.activities (company_id, type, actor_id, occurred_at) values
  (tests.ref('alpha'), 'call', tests.uid('agent_a1'), '2026-07-05 09:00+00'), (tests.ref('alpha'), 'call', tests.uid('agent_a1'), '2026-07-05 09:10+00'),
  (tests.ref('alpha'), 'note', tests.uid('agent_a1'), '2026-07-05 09:20+00');
alter table public.leads disable trigger leads_guard;
insert into public.contacts (full_name, phone_e164) values ('Daily Lead 1', '+201099970001'), ('Daily Lead 2', '+201099970002');
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
select tests.ref('alpha'), id, 'Daily lead ' || phone_e164, tests.uid('agent_a1'), tests.uid('agent_a1'), '2026-07-05 06:30+00'::timestamptz from public.contacts where phone_e164 like '+2010999700%';
alter table public.leads enable trigger leads_guard;
-- lead 1: qualified, bounced back and qualified again the same day (one interested customer); lead 2: qualified by the manager
insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by, created_at)
select l.id, tests.ref('alpha'), 'new', 'qualified', tests.uid('agent_a1'), '2026-07-05 08:00+00'::timestamptz from public.leads l where l.title like '%0001';
insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by, created_at)
select l.id, tests.ref('alpha'), 'qualified', 'contacted', tests.uid('agent_a1'), '2026-07-05 08:10+00'::timestamptz from public.leads l where l.title like '%0001';
insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by, created_at)
select l.id, tests.ref('alpha'), 'contacted', 'qualified', tests.uid('agent_a1'), '2026-07-05 08:20+00'::timestamptz from public.leads l where l.title like '%0001';
insert into public.lead_status_history (lead_id, company_id, from_status, to_status, changed_by, created_at)
select l.id, tests.ref('alpha'), 'new', 'qualified', tests.uid('mgr_a'), '2026-07-05 08:30+00'::timestamptz from public.leads l where l.title like '%0002';

-- the report --------------------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
create temp table dr as select * from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05');
select tests.eq((select first_seen::text || ' ' || last_seen::text from dr where user_id = tests.uid('agent_a1')), '2026-07-05 06:55:00+00 2026-07-05 16:20:00+00', 'first and last seen are reported');
select tests.eq((select working_day || ' ' || shift_starts || '-' || shift_ends from dr where user_id = tests.uid('agent_a1')), 'true 10:00:00-19:00:00', 'the shift of the day is shown');
select tests.eq((select chats_opened || '/' || chats_replied from dr where user_id = tests.uid('agent_a1')), '2/1', 'chats opened that day: 2 (the Saturday one is not counted); answered from the CRM by the owner: 1');
select tests.eq((select turns_answered || '/' || turns_waiting from dr where user_id = tests.uid('agent_a1')), '2/1', 'customer messages answered by the employee: 2; still waiting on the employee''s chats: 1 (the unanswered chat)');
select tests.eq((select avg_reply_seconds || '/' || median_reply_seconds from dr where user_id = tests.uid('agent_a1')), '210/210', 'reply speed: (120 s + 300 s) / 2 = 210 s');
select tests.eq((select calls_logged from dr where user_id = tests.uid('agent_a1')), 2::bigint, 'two logged calls; the note is not a call');
select tests.eq((select leads_created from dr where user_id = tests.uid('agent_a1')), 2::bigint, 'two leads created');
select tests.eq((select interested_leads from dr where user_id = tests.uid('agent_a1')), 1::bigint, 'interested: lead moved to qualified (twice on the same day counts once; the manager''s one is the manager''s)');
select tests.eq((select bookings_count || ' ' || (bookings_amounts ->> 'QAR') || ' ' || (bookings_amounts ->> 'EGP') from dr where user_id = tests.uid('agent_a1')), '3 2000.00 2000.00', 'bookings: 3 (the cancelled one is left out), totals per currency, never added together');
select tests.eq((select payments_count || ' ' || (payments_amounts ->> 'QAR') from dr where user_id = tests.uid('agent_a1')), '2 500.00', 'payments recorded: pending + confirmed = 500 QAR; the rejected one is left out');
select tests.eq((select interested_leads from dr where user_id = tests.uid('mgr_a')), 1::bigint, 'the manager gets the interested customer they qualified');
select tests.eq((select count(*) from dr where user_id is null), 0::bigint, 'no unassigned row when no conversation lacks an owner and nothing happened');
-- the Saturday chat answered by the manager belongs to the manager, on Saturday
create temp table dr6 as select * from public.report_employee_day(tests.ref('alpha'), date '2026-07-04', date '2026-07-04');
select tests.eq((select turns_answered from dr6 where user_id = tests.uid('mgr_a')), 1::bigint, 'a reply sent by the manager counts for the manager');
select tests.eq((select chats_opened || '/' || turns_waiting from dr6 where user_id = tests.uid('agent_a1')), '1/0', 'Saturday: the chat opened then is the owner''s, and it was answered');
select tests.eq((select working_day::text from dr6 where user_id = tests.uid('agent_a1')), 'false', 'Saturday is a day off');
select tests.eq((select has_shift::text from dr6 where user_id = tests.uid('agent_a1')) || '/' || (select has_shift::text from dr6 where user_id = tests.uid('mgr_a')), 'true/false', 'has_shift tells a day off (shift configured) from no shift at all');
-- an unowned chat shows up on the "unassigned" row
select tests.logout();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'dr.c9a', '97455580009', 'Daily C9', 'text', 'hello', null, '2026-07-05 09:30+00');
alter table public.conversations disable trigger conversations_guard;
update public.conversations set owner_id = null, created_at = '2026-07-05 09:30+00' where customer_wa_id = '97455580009';
alter table public.conversations enable trigger conversations_guard;
select tests.login('admin_a');
select tests.eq((select chats_opened || '/' || turns_waiting from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id is null), '1/1', 'a chat without an owner is reported on the unassigned row');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05', tests.uid('agent_a1')) where user_id is null), 0::bigint, 'filtering by employee drops the unassigned row');
select tests.throws($q$select * from public.report_employee_day(tests.ref('alpha'), date '2026-07-06', date '2026-07-05')$q$, 'report.invalid_period', 'reversed period refused');
select tests.throws($q$select * from public.report_employee_day(tests.ref('alpha'), date '2026-01-01', date '2026-07-05')$q$, 'report.invalid_period', 'more than 92 days refused');

-- visibility --------------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id <> tests.uid('agent_a1')), 0::bigint, 'an agent sees only their own report');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id is null), 0::bigint, 'and no unassigned row');
select tests.login('agent_a2');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id = tests.uid('agent_a1')), 0::bigint, 'another agent cannot see agent_a1''s numbers');
select tests.login('admin_b');
select tests.throws($q$select * from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05')$q$, 'auth.forbidden', 'another company''s admin is refused');
select tests.logout();
select tests.throws($q$select * from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05')$q$, 'auth.forbidden', 'no session, no report');
-- people excluded from performance are left out
select tests.login('admin_a');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id = tests.uid('agent_a1')), 1::bigint, 'before the exclusion agent_a1 is listed');
select tests.logout();
insert into public.performance_exclusions (company_id, user_id) values (tests.ref('alpha'), tests.uid('agent_a1'));
select tests.login('admin_a');
select tests.eq((select count(*) from public.report_employee_day(tests.ref('alpha'), date '2026-07-05', date '2026-07-05') where user_id = tests.uid('agent_a1')), 0::bigint, 'an excluded person is not in the report');
select tests.logout();
rollback;
