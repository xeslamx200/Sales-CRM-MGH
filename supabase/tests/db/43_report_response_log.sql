-- Migration 1005: report_response_log - one row per customer turn, with the first answer and where it came from.
begin;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RL1', '97455558001', 'Waits Today', 'text', 'hello?', null, now() - interval '2 hours');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RL2', '97455558002', 'Answered In CRM', 'text', 'price?', null, now() - interval '3 hours');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RL3', '97455558003', 'Answered On Phone', 'text', 'hi', null, now() - interval '4 hours');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RL4', '97455558003', 'Answered On Phone', 'text', 'anyone?', null, now() - interval '3 hours 50 minutes');   -- same turn
select tests.logout();
insert into tests.refs select 'rl1', id from public.conversations where customer_wa_id = '97455558001';
insert into tests.refs select 'rl2', id from public.conversations where customer_wa_id = '97455558002';
insert into tests.refs select 'rl3', id from public.conversations where customer_wa_id = '97455558003';
-- an employee answers conversation 2 in the CRM; conversation 3 is answered from the phone (an echo: no CRM sender)
insert into public.messages (conversation_id, direction, message_type, body, status, sent_by, sent_at) values (tests.ref('rl2'), 'outbound', 'text', 'ok', 'sent', tests.uid('agent_a1'), now() - interval '2 hours 50 minutes');
insert into public.messages (conversation_id, direction, message_type, body, status, sent_by, sent_at) values (tests.ref('rl3'), 'outbound', 'text', 'phone reply', 'sent', null, now() - interval '3 hours');

select tests.login('admin_a');
create temp table log as select * from public.report_response_log(tests.ref('alpha'), (now() - interval '1 day')::date, (now() + interval '1 day')::date);
grant select on log to public;
select tests.eq((select count(*) from log), 3::bigint, 'one row per customer turn (two messages in a row are one turn)');
select tests.eq((select contact_name from log limit 1), 'Waits Today', 'waiting turns come first');
select tests.eq((select count(*) from log where answered_at is null), 1::bigint, 'only the first customer is still waiting');
select tests.eq((select answered_by || '/' || answered_by_name from log where contact_name = 'Answered In CRM'), 'crm/' || (select full_name from public.profiles where id = tests.uid('agent_a1')), 'answered in the CRM: by the employee');
select tests.eq((select answered_by from log where contact_name = 'Answered On Phone'), 'phone', 'answered from the phone: an echo with no CRM sender');
select tests.eq((select phone from log where contact_name = 'Waits Today'), '+97455558001', 'the customer number is returned');
select tests.ok((select wait_seconds from log where contact_name = 'Waits Today') between 7100 and 7400, 'a waiting turn counts up to now (about 2 hours)');
select tests.ok((select wait_seconds from log where contact_name = 'Answered In CRM') between 550 and 650, 'an answered turn: the time to the first answer (10 minutes)');
select tests.ok((select asked_at from log where contact_name = 'Answered On Phone') < (select asked_at from log where contact_name = 'Answered In CRM'), 'the turn starts at the FIRST of two customer messages in a row');
select tests.logout();
select tests.login('outsider');
select tests.throws(format($q$select * from public.report_response_log(%L::uuid, current_date - 1, current_date)$q$, tests.ref('alpha')), 'auth.forbidden', 'outsiders are refused');
select tests.logout();
rollback;
