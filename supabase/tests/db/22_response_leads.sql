-- Leads per day and response speed (proposed migration 982). Lives outside supabase/tests/db: run only on databases that have 970..982.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..982 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/22_response_leads.sql
-- Alpha is on Asia/Qatar (UTC+3, no DST). Days below are Doha days.
begin;
select tests.logout();

-- conversation A: four customer turns, three kinds of answer; conversation B: never answered ------------------------------------------------
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.a1', '97455590001', 'Customer A', 'text', 'q1', null, '2026-10-20 10:00+03');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.a2', '97455590001', 'Customer A', 'text', 'q1 again', null, '2026-10-20 10:01+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'delivered', 'crm reply', tests.uid('agent_a1'), '2026-10-20 10:10+03', 'rs.o1' from public.conversations where customer_wa_id = '97455590001';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.a3', '97455590001', 'Customer A', 'text', 'q2', null, '2026-10-20 11:00+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id, provider_origin)
select id, 'outbound', 'delivered', 'phone-app reply', null, '2026-10-20 11:02+03', 'rs.o2', 'business_app' from public.conversations where customer_wa_id = '97455590001';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.a4', '97455590001', 'Customer A', 'text', 'q3 late', null, '2026-10-20 23:59+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id, provider_origin)
select id, 'outbound', 'delivered', 'phone-app reply next day', null, '2026-10-21 00:30+03', 'rs.o3', 'business_app' from public.conversations where customer_wa_id = '97455590001';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.a5', '97455590001', 'Customer A', 'text', 'q4', null, '2026-10-21 09:00+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'failed', 'never delivered', tests.uid('agent_a1'), '2026-10-21 09:05+03', 'rs.o4' from public.conversations where customer_wa_id = '97455590001';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'rs.b1', '97455590002', 'Customer B', 'text', 'anyone?', null, '2026-10-20 12:00+03');
select tests.logout();

-- lead timestamps: automatic leads were created "now" by the ingest; place them on the days of the first message, plus one manual lead ------
alter table public.leads disable trigger leads_guard;
update public.leads set created_at = '2026-10-20 10:00+03' where conversation_id = (select id from public.conversations where customer_wa_id = '97455590001');
update public.leads set created_at = '2026-10-20 12:00+03' where conversation_id = (select id from public.conversations where customer_wa_id = '97455590002');
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
values (tests.ref('alpha'), tests.ref('contact_shared'), 'Manual lead', tests.uid('agent_a1'), tests.uid('agent_a1'), '2026-10-21 08:00+03');
alter table public.leads enable trigger leads_guard;

-- leads per day -----------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
create temp table lpd as select * from public.report_leads_per_day(tests.ref('alpha'), '2026-10-19', '2026-10-22');
select tests.eq((select count(*) from lpd), 4::bigint, 'one row per day, including days without leads');
select tests.eq((select total || '/' || automatic || '/' || manual from lpd where day = '2026-10-19'), '0/0/0', 'a quiet day is zero, not missing');
select tests.eq((select total || '/' || automatic || '/' || manual from lpd where day = '2026-10-20'), '2/2/0', 'two automatic leads on the 20th');
select tests.eq((select total || '/' || automatic || '/' || manual from lpd where day = '2026-10-21'), '1/0/1', 'one manual lead on the 21st');
select tests.throws($q$select * from public.report_leads_per_day(tests.ref('alpha'), '2026-10-22', '2026-10-19')$q$, 'report.invalid_period', 'reversed period refused');
select tests.throws($q$select * from public.report_leads_per_day(tests.ref('alpha'), '2024-01-01', '2026-10-19')$q$, 'report.invalid_period', 'more than a year refused');
create temp table lpd_edge as select * from public.report_leads_per_day(tests.ref('alpha'), '2026-10-20', '2026-10-20');
select tests.eq((select total from lpd_edge), 2::bigint, 'single-day period');

-- a lead created at 23:30 Doha on the 20th is the 20th even though it is already the 21st in UTC+ zones east of Doha, and 20:30Z in UTC
select tests.logout();
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
values (tests.ref('alpha'), tests.ref('contact_shared'), 'Late lead', tests.uid('agent_a1'), tests.uid('agent_a1'), '2026-10-20 23:30+03');
select tests.login('admin_a');
select tests.eq((select total from public.report_leads_per_day(tests.ref('alpha'), '2026-10-20', '2026-10-20')), 3::bigint, 'the day boundary follows the company time zone (23:30 Doha counts on the 20th)');
select tests.eq((select total from public.report_leads_per_day(tests.ref('alpha'), '2026-10-21', '2026-10-21')), 1::bigint, 'and not on the 21st');

-- response speed ----------------------------------------------------------------------------------------------------------------------
create temp table rs as select * from public.report_response_speed(tests.ref('alpha'), '2026-10-19', '2026-10-22');
select tests.eq((select turns || '/' || answered || '/' || unanswered from rs where day = '2026-10-20'), '4/3/1', '20th: consecutive customer messages are one turn; 3 of 4 turns answered');
select tests.eq((select answered_by_crm || '/' || answered_by_phone from rs where day = '2026-10-20'), '1/2', 'one answered from the CRM, two from the phone app (echo)');
select tests.eq((select avg_seconds from rs where day = '2026-10-20'), 860::numeric, 'average of 600, 120 and 1860 seconds');
select tests.eq((select median_seconds from rs where day = '2026-10-20'), 600::numeric, 'median');
select tests.eq((select p90_seconds from rs where day = '2026-10-20'), 1608::numeric, '90th percentile (interpolated)');
select tests.eq((select within_5m from rs where day = '2026-10-20'), 0.3333::numeric, 'one of three answered within 5 minutes');
select tests.eq((select within_15m from rs where day = '2026-10-20'), 0.6667::numeric, 'two of three within 15 minutes');
select tests.eq((select within_60m from rs where day = '2026-10-20'), 1.0000::numeric, 'all three within 60 minutes (the slowest took 31)');
select tests.eq((select turns || '/' || answered || '/' || unanswered from rs where day = '2026-10-21'), '1/0/1', '21st: a failed reply is not an answer');
select tests.eq((select avg_seconds from rs where day = '2026-10-21') is null, true, 'no answers, no average');
select tests.eq((select turns || '/' || answered || '/' || unanswered from rs where day is null), '5/3/2', 'overall row');
select tests.eq((select count(*) from rs), 3::bigint, 'two days with turns plus the overall row');
select tests.eq((select avg_business_seconds from rs where day is null) is null, true, 'business-hours columns are NULL until opening hours are configured');

-- visibility --------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select turns from public.report_response_speed(tests.ref('alpha'), '2026-10-19', '2026-10-22') where day is null), 5::bigint,
  'an employee sees what the inbox shows them (unowned conversations are a shared queue)');
select tests.eq((select total from public.report_leads_per_day(tests.ref('alpha'), '2026-10-21', '2026-10-21')), 1::bigint, 'an employee sees their own manual lead');
select tests.eq((select total from public.report_leads_per_day(tests.ref('alpha'), '2026-10-20', '2026-10-20')), 1::bigint, 'but only their own on the 20th (the late one), not the unowned automatic ones');
select tests.login('admin_b');
select tests.throws($q$select * from public.report_response_speed(tests.ref('alpha'), '2026-10-19', '2026-10-22')$q$, 'auth.forbidden', 'another company''s admin is refused (speed)');
select tests.throws($q$select * from public.report_leads_per_day(tests.ref('alpha'), '2026-10-19', '2026-10-22')$q$, 'auth.forbidden', 'another company''s admin is refused (leads)');
select tests.throws($q$select * from public.report_waiting_now(tests.ref('alpha'))$q$, 'auth.forbidden', 'another company''s admin is refused (waiting)');
select tests.login_anon();
select tests.throws($q$select * from public.report_response_speed(tests.ref('alpha'), '2026-10-19', '2026-10-22')$q$, 'permission denied', 'anonymous refused');

-- waiting now -------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
create temp table wn as select * from public.report_waiting_now(tests.ref('alpha'));
select tests.eq((select count(*) from wn), 2::bigint, 'two conversations wait for an answer');
select tests.eq((select contact_name from wn order by waiting_since limit 1), 'Customer B', 'longest wait first');
select tests.eq((select waiting_since from wn where contact_name = 'Customer A'), '2026-10-21 09:00+03'::timestamptz, 'the wait starts at the first unanswered customer message');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.report_waiting_now(tests.ref('alpha'))), 2::bigint, 'an employee sees the unowned conversations waiting in the shared queue');

-- an answer takes a conversation off the list
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id, provider_origin)
select id, 'outbound', 'delivered', 'answered from the phone', null, now(), 'rs.o5', 'business_app' from public.conversations where customer_wa_id = '97455590002';
select tests.login('admin_a');
select tests.eq((select count(*) from public.report_waiting_now(tests.ref('alpha'))), 1::bigint, 'an answer from the phone app takes the conversation off the waiting list');

select tests.logout();
rollback;
