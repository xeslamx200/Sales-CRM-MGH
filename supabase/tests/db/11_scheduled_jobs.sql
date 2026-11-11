-- Supabase-native scheduled jobs (0870): SQL webhook retries, dispatcher,
-- run log, permissions.
begin;
select tests.service();

-- A status update that arrived before its message existed (send result race).
select public.claim_webhook_event('status:wamid.LATE:delivered', 'status', 'PNID_ALPHA', jsonb_build_object(
  'kind', 'status', 'eventKey', 'status:wamid.LATE:delivered', 'phoneNumberId', 'PNID_ALPHA',
  'waMessageId', 'wamid.LATE', 'status', 'delivered', 'recipientWaId', '97455551313', 'at', now(),
  'errorCode', null, 'errorMessage', null));
select public.finish_webhook_event('status:wamid.LATE:delivered', 'failed', 'status.message_not_found');

-- An inbound message for a number that wasn't registered yet.
select public.claim_webhook_event('msg:wamid.NEWNUM', 'message', 'PNID_NEW', jsonb_build_object(
  'kind', 'message', 'eventKey', 'msg:wamid.NEWNUM', 'phoneNumberId', 'PNID_NEW', 'waMessageId', 'wamid.NEWNUM',
  'fromWaId', '97455551414', 'profileName', 'Late Number', 'messageType', 'text', 'body', 'hello', 'media', null,
  'sentAt', now()));
select public.finish_webhook_event('msg:wamid.NEWNUM', 'failed', 'whatsapp.unknown_phone_number_id');

-- An echo that failed once.
select public.claim_webhook_event('echo:wamid.ECHO9', 'message', 'PNID_ALPHA', jsonb_build_object(
  'kind', 'echo', 'eventKey', 'echo:wamid.ECHO9', 'phoneNumberId', 'PNID_ALPHA', 'waMessageId', 'wamid.ECHO9',
  'toWaId', '97455551515', 'messageType', 'text', 'body', 'from the phone app', 'media', null, 'sentAt', now()));
select public.finish_webhook_event('echo:wamid.ECHO9', 'failed', 'processing_error');

-- A dead letter that already used all its attempts.
select public.claim_webhook_event('msg:dead', 'message', 'PNID_NOPE', '{"kind":"message"}');
select public.finish_webhook_event('msg:dead', 'failed', 'processing_error');
select tests.logout();
update public.whatsapp_webhook_events set attempts = 8 where event_key = 'msg:dead';
select tests.service();

-- Run 1: status still has no message; the echo succeeds; the new number is unknown.
select tests.eq(public.process_webhook_retries() ->> 'processed', '1', 'first run processes the echo only');
select tests.eq((select status from public.whatsapp_webhook_events where event_key = 'status:wamid.LATE:delivered'), 'failed',
  'status for a missing message stays queued for retry');
select tests.eq((select attempts from public.whatsapp_webhook_events where event_key = 'status:wamid.LATE:delivered'), 2,
  'each retry counts an attempt');
select tests.ok(exists (select 1 from public.messages where wa_message_id = 'wamid.ECHO9' and sent_by is null),
  'retried echo is stored as outbound without an employee');

-- The missing pieces arrive.
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.Q1', '97455551313', 'Race', 'text', 'q', null, now());
select tests.logout();
insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, status, sent_by)
select c.id, 'outbound', 'wamid.LATE', 'text', 'reply', 'sent', tests.uid('agent_a1')
from public.conversations c where c.customer_wa_id = '97455551313';
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status)
values (tests.ref('alpha'), 'New Number', '+97440000099', 'PNID_NEW', 'test');
select tests.service();

-- Run 2 through the dispatcher (as pg_cron does).
select tests.eq(public.run_scheduled_job('webhook_retries') ->> 'processed', '2', 'second run processes the status and the message');
select tests.eq((select status::text from public.messages where wa_message_id = 'wamid.LATE'), 'delivered',
  'late status is applied to the message');
select tests.ok(exists (select 1 from public.messages where wa_message_id = 'wamid.NEWNUM'), 'message for the newly added number is ingested');
select tests.eq((select payload from public.whatsapp_webhook_events where event_key = 'msg:wamid.NEWNUM'), '{}'::jsonb,
  'processed payloads are redacted');
select tests.eq((select attempts from public.whatsapp_webhook_events where event_key = 'msg:dead'), 8,
  'events past the attempt limit are not retried');

-- Run 3: idempotent — nothing left to do, nothing duplicated.
select tests.eq(public.run_scheduled_job('webhook_retries') ->> 'processed', '0', 'a repeated run is a no-op');
select tests.eq((select count(*) from public.messages where wa_message_id in ('wamid.NEWNUM', 'wamid.ECHO9')), 2::bigint,
  'no duplicate messages after repeated runs');

-- Other jobs and the run log.
select tests.lives($q$select public.run_scheduled_job('task_reminders')$q$, 'task reminders job runs');
select tests.lives($q$select public.run_scheduled_job('retention')$q$, 'retention job runs');
select tests.throws($q$select public.run_scheduled_job('drop_everything')$q$, 'job.unknown', 'only known jobs can run');
select tests.logout();
select tests.eq((select count(*) from app.job_runs where ok), 4::bigint, 'every run is logged with its outcome');
select tests.ok((select details ? 'notifications' from app.job_runs where job = 'task_reminders' order by id desc limit 1),
  'run details are recorded');

-- Permissions.
select tests.login('admin_a');
select tests.throws($q$select public.run_scheduled_job('retention')$q$, 'permission denied', 'users cannot trigger jobs');
select tests.throws($q$select public.process_webhook_retries()$q$, 'permission denied', 'users cannot run retries');
select tests.eq(tests.count('select * from public.job_status()'), 0::bigint, 'company admins do not see system job status');
select tests.login('super');
select tests.eq(tests.count('select * from public.job_status() where last_ok'), 3::bigint, 'super admin sees the last run of each job');
select tests.login_anon();
select tests.throws($q$select * from public.job_status()$q$, 'permission denied', 'anon cannot read job status');

rollback;
