-- Voice / audio messages through queue_outbound (migration 999): accepted, caption-free, inside the 24-hour window only, other types unchanged.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with supabase/migrations + _helpers.sql + _fixtures.sql> -f supabase/tests/db/37_queue_outbound_audio.sql
begin;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AUD1', '97455554040', 'Audio Fresh', 'text', 'hello', null, now() - interval '1 hour');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AUD2', '97455554041', 'Audio Stale', 'text', 'hello', null, now() - interval '3 days');
select tests.logout();
insert into tests.refs select 'aud_fresh', id from public.conversations where customer_wa_id = '97455554040';
insert into tests.refs select 'aud_stale', id from public.conversations where customer_wa_id = '97455554041';

select tests.login('agent_a1');
select tests.lives(format($q$select * from public.queue_outbound(%L::uuid, gen_random_uuid(), 'audio', null,
  jsonb_build_object('storage_path', 'outbound/%s/abc123/voice.ogg', 'mime_type', 'audio/ogg', 'filename', 'voice.ogg', 'size', 4000))$q$,
  tests.ref('aud_fresh'), tests.ref('aud_fresh')), 'a voice note without a caption is queued');
select tests.eq((select message_type || '|' || (media ->> 'mime_type') || '|' || status from public.messages where conversation_id = tests.ref('aud_fresh') and direction = 'outbound'),
  'audio|audio/ogg|queued', 'it is stored as an audio message with its file');
select tests.throws(format($q$select * from public.queue_outbound(%L::uuid, gen_random_uuid(), 'audio', 'caption here',
  jsonb_build_object('storage_path', 'outbound/%s/abc123/voice.ogg', 'mime_type', 'audio/ogg', 'filename', 'voice.ogg', 'size', 4000))$q$,
  tests.ref('aud_fresh'), tests.ref('aud_fresh')), 'message.invalid_media', 'an audio message cannot carry a caption');
select tests.throws(format($q$select * from public.queue_outbound(%L::uuid, gen_random_uuid(), 'audio', null,
  jsonb_build_object('storage_path', 'outbound/%s/abc123/voice.ogg', 'mime_type', 'audio/ogg', 'filename', 'voice.ogg', 'size', 4000))$q$,
  tests.ref('aud_stale'), tests.ref('aud_stale')), 'whatsapp.outside_service_window', 'after 24 hours only a template may be sent, audio included');
select tests.throws(format($q$select * from public.queue_outbound(%L::uuid, gen_random_uuid(), 'audio', null,
  jsonb_build_object('storage_path', 'outbound/%s/abc123/voice.ogg', 'mime_type', 'audio/ogg', 'filename', 'voice.ogg', 'size', 4000))$q$,
  tests.ref('aud_fresh'), tests.ref('aud_stale')), 'message.invalid_media', 'the file must belong to this conversation');
select tests.throws($q$select * from public.queue_outbound(null, gen_random_uuid(), 'video', null, null)$q$, 'message.invalid_body', 'other types are still refused');
select tests.logout();
rollback;
