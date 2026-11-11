-- Coexistence echoes and webhook event bookkeeping (dedup, retry, redaction).
begin;

select tests.service();
select tests.eq(public.claim_webhook_event('msg:w1', 'message', 'PNID_ALPHA', '{"body":"secret"}'), 'new', 'first claim is new');
select tests.eq(public.claim_webhook_event('msg:w1', 'message', 'PNID_ALPHA', '{"body":"secret"}'), 'retry',
  'unfinished event can be retried');
select tests.lives($q$select public.finish_webhook_event('msg:w1', 'failed', 'whatsapp.unknown_phone_number_id')$q$, 'mark failed');
select tests.eq((select count(*) from public.pending_webhook_retries()), 1::bigint, 'failed event is queued for retry');
select tests.lives($q$select public.finish_webhook_event('msg:w1', 'processed')$q$, 'mark processed');
select tests.eq(public.claim_webhook_event('msg:w1', 'message', 'PNID_ALPHA', '{}'), 'duplicate', 'processed event is a duplicate');
select tests.eq((select count(*) from public.pending_webhook_retries()), 0::bigint, 'processed events leave the retry queue');
select tests.logout();
select tests.eq((select payload from public.whatsapp_webhook_events where event_key = 'msg:w1'), '{}'::jsonb,
  'payload (message content) is redacted once processed');
select tests.eq((select attempts from public.whatsapp_webhook_events where event_key = 'msg:w1'), 2, 'attempts counted (duplicates are not attempts)');

-- Echo: a message the business sent from the phone app.
select tests.service();
create temp table e1 as select * from public.ingest_whatsapp_echo('PNID_ALPHA', 'wamid.E1', '97455553333', 'text',
  'sent from the phone', null, now() - interval '1 minute');
create temp table e2 as select * from public.ingest_whatsapp_echo('PNID_ALPHA', 'wamid.E1', '97455553333', 'text',
  'sent from the phone', null, now() - interval '1 minute');
select tests.ok((select not duplicate from e1) and (select duplicate from e2), 'echo ingestion is idempotent');
select tests.logout();
select tests.ok((select direction = 'outbound' and sent_by is null and status = 'sent' from public.messages
  where wa_message_id = 'wamid.E1'), 'echo is outbound with no attributed employee');
select tests.ok((select last_inbound_at is null from public.conversations where customer_wa_id = '97455553333'),
  'an echo does not open the 24h customer-service window');

select tests.login('admin_a');
select tests.throws($q$select public.claim_webhook_event('k', 'message', null, '{}')$q$, 'permission denied',
  'users cannot touch the webhook queue');
select tests.throws($q$select * from public.ingest_whatsapp_echo('PNID_ALPHA', 'x', '97455553333', 'text', 'x', null, now())$q$,
  'permission denied', 'users cannot inject echoes');

select tests.service();
update public.whatsapp_webhook_events set received_at = now() - interval '40 days';
select tests.eq(public.purge_old_webhook_events(30), 1, 'retention purge removes old processed events');

-- Contract with the app: event_kind is message|status|other. Echoes must be
-- claimed as 'message' (src/lib/whatsapp/processor.ts dbEventKind).
select tests.throws($q$select public.claim_webhook_event('echo:x', 'echo', 'PNID_ALPHA', '{}')$q$,
  'whatsapp_webhook_events_event_kind_check', 'event_kind outside message|status|other is rejected');

rollback;
