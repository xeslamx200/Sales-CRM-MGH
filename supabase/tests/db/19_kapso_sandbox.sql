-- Kapso Sandbox, Phase 1 (0960): provider/account ownership checks, idempotency, status races, retries,
-- tenant isolation, the Phase 1 send block and, above all, PROOF that sandbox data never reaches any
-- real company's metrics. Sandbox traffic can only live in a sandbox company; the differential section
-- compares every report function for 7 callers before and after full sandbox activity.
begin;

-- ===================================================================== setup
insert into public.companies (name, slug, timezone, currency, is_sandbox)
values ('Sandbox Co', 'sandbox-co', 'Asia/Qatar', 'QAR', true);
insert into tests.refs select 'sandbox', id from public.companies where slug = 'sandbox-co';
insert into public.company_memberships (company_id, user_id, role) values
  (tests.ref('sandbox'), tests.uid('mgr_a'), 'sales_manager'),
  (tests.ref('sandbox'), tests.uid('agent_a1'), 'sales_agent');
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status)
values (tests.ref('sandbox'), 'Kapso Sandbox', '+15550000001', 'KAPSO_PNID_1', 'kapso', true, 'test');
insert into tests.refs select 'wa_kapso', id from public.whatsapp_accounts where phone_number_id = 'KAPSO_PNID_1';
insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply) values
  (tests.ref('wa_kapso'), tests.uid('agent_a1'), true), (tests.ref('wa_kapso'), tests.uid('mgr_a'), true);

-- ============================================================ A. static rules
select tests.eq((select count(*) from public.whatsapp_accounts where provider = 'meta' and not is_sandbox), 2::bigint,
  'existing Meta accounts keep provider=meta and are not sandbox');
select tests.eq((select count(*) from public.companies where is_sandbox), 1::bigint, 'only the new company is a sandbox');
select tests.throws($q$update public.companies set is_sandbox = false where slug = 'sandbox-co'$q$, 'company.sandbox_immutable',
  'a sandbox company can never be turned into a real one');
select tests.throws($q$update public.companies set is_sandbox = true where slug = 'alpha'$q$, 'company.sandbox_immutable',
  'nor a real company into a sandbox');
select tests.throws($q$insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status)
  values (tests.ref('alpha'), 'Kapso in real company', '+15550000002', 'KAPSO_BAD_1', 'kapso', true, 'test')$q$,
  'whatsapp.sandbox_company_mismatch', 'a Kapso sandbox account cannot live in a real company');
select tests.throws($q$insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status)
  values (tests.ref('sandbox'), 'Meta in sandbox', '+15550000003', 'META_BAD_1', 'meta', false, 'test')$q$,
  'whatsapp.sandbox_company_mismatch', 'a Meta account cannot live in the sandbox company');
select tests.throws($q$insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status)
  values (tests.ref('alpha'), 'Kapso not sandbox', '+15550000004', 'KAPSO_BAD_2', 'kapso', false, 'test')$q$,
  'whatsapp_accounts_sandbox_chk|wa_accounts_mode_env_chk', 'Phase 1 has no non-sandbox Kapso account (0960: whatsapp_accounts_sandbox_chk; Rev6 replaces it by wa_accounts_mode_env_chk)');
select tests.throws($q$update public.whatsapp_accounts set default_company_id = tests.ref('alpha') where id = tests.ref('wa_kapso')$q$,
  'whatsapp.sandbox_company_mismatch', 'a sandbox account cannot be moved into a real company');
select tests.throws($q$update public.whatsapp_accounts set default_company_id = tests.ref('sandbox') where id = tests.ref('wa_alpha')$q$,
  'whatsapp.sandbox_company_mismatch', 'and a Meta account cannot be moved into the sandbox company');

-- ============================================ B. wrapper guards (provider / account / privileges)
select tests.service();
select tests.throws($q$select * from public.ingest_kapso_message('PNID_ALPHA', 'wamid.K.META1', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'kapso.unknown_account', 'a Meta account id is refused by the Kapso intake');
select tests.throws($q$select * from public.ingest_kapso_message('NO_SUCH_ID', 'wamid.K.NOACC', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'kapso.unknown_account', 'an unknown phone_number_id is refused');
select tests.throws($q$select public.apply_kapso_status('PNID_BETA', 'wamid.K.MS', 'sent', null, null)$q$,
  'kapso.unknown_account', 'status events for a Meta account id are refused');
select tests.logout();
update public.whatsapp_accounts set status = 'disabled' where id = tests.ref('wa_kapso');
select tests.service();
select tests.throws($q$select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.DIS', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'kapso.unknown_account', 'a disabled sandbox account does not ingest');
select tests.logout();
update public.whatsapp_accounts set status = 'pending_setup' where id = tests.ref('wa_kapso');
select tests.service();
select tests.throws($q$select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.PEND', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'kapso.unknown_account', 'nor one that is still pending setup');
select tests.logout();
update public.whatsapp_accounts set status = 'test' where id = tests.ref('wa_kapso');
select tests.login('agent_a1');
select tests.throws($q$select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.USER', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'permission denied', 'employees cannot call the Kapso intake');
select tests.throws($q$select public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.USER', 'sent', null, null)$q$, 'permission denied', 'nor the status wrapper');
select tests.login_anon();
select tests.throws($q$select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.ANON', '97455590001', 'X', 'text', 'hi', null, now())$q$,
  'permission denied', 'nor can anonymous callers');
select tests.logout();

-- ===================================================== C. intake behaviour (sandbox traffic)
-- A customer that is ALSO a contact of a real company: reused, never marked sandbox.
insert into public.contacts (full_name, phone_e164) values ('Shared Phone', '+97455590010');
insert into public.contact_companies (contact_id, company_id)
select id, tests.ref('alpha') from public.contacts where phone_e164 = '+97455590010';

select tests.service();
create temp table s1 as select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.IN1', '97455590001', 'Sandy One', 'text', 'hello sandbox', null, now() - interval '3 minutes');
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.IN2', '97455590001', 'Sandy One', 'text', 'second message', null, now() - interval '2 minutes');
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.IN3', '97455590010', 'Shared Phone', 'text', 'from a shared contact', null, now() - interval '1 minute');
select tests.logout();
insert into tests.refs select 'sconv1', conversation_id from s1;
select tests.ok((select c.company_id = tests.ref('sandbox') and c.is_sandbox and not c.is_simulated and c.whatsapp_account_id = tests.ref('wa_kapso')
                  from public.conversations c where c.id = tests.ref('sconv1')),
  'the conversation is in the sandbox company, flagged sandbox, on the Kapso account');
select tests.ok((select bool_and(m.is_sandbox) and count(*) = 2 from public.messages m where m.conversation_id = tests.ref('sconv1')), 'its messages are flagged sandbox');
select tests.ok((select k.is_sandbox from public.contacts k where k.phone_e164 = '+97455590001'),
  'a contact created by the sandbox intake is flagged sandbox');
select tests.ok((select not k.is_sandbox from public.contacts k where k.phone_e164 = '+97455590010'),
  'a pre-existing contact of a real company is reused and NOT flagged');
select tests.eq(tests.count($q$select * from public.contact_companies cc join public.contacts k on k.id = cc.contact_id where k.phone_e164 = '+97455590010'$q$), 2::bigint,
  'it is now linked to Alpha and to the sandbox company (the shared-identity model)');
select tests.ok((select l.is_sandbox and l.auto_created and l.company_id = tests.ref('sandbox') from public.leads l where l.conversation_id = tests.ref('sconv1')),
  'the automatic lead is in the sandbox company and flagged');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts k on k.id = l.contact_id where k.phone_e164 = '+97455590010' and l.company_id = tests.ref('alpha')$q$), 0::bigint,
  'no lead was created in Alpha for the shared contact');

select tests.throws($q$update public.whatsapp_accounts set provider = 'meta' where id = tests.ref('wa_kapso')$q$,
  'whatsapp.provider_immutable', 'the provider of an account with conversations cannot change');

-- Real-company users keep seeing the shared contact exactly as before; the sandbox link adds nothing for them.
select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.contacts where phone_e164 = '+97455590010'$q$), 1::bigint, 'the Alpha employee still sees the shared contact');
select tests.eq(tests.count($q$select * from public.contact_companies cc join public.contacts k on k.id = cc.contact_id where k.phone_e164 = '+97455590010' and cc.company_id = tests.ref('alpha')$q$), 1::bigint, 'with its Alpha link and no extra Alpha rows');
select tests.eq(tests.count($q$select * from public.messages m join public.conversations c on c.id = m.conversation_id where c.customer_wa_id = '97455590010' and c.company_id = tests.ref('alpha')$q$), 0::bigint, 'and no sandbox message appears in an Alpha conversation');
select tests.logout();

-- duplicates
select tests.service();
create temp table sd as select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.IN1', '97455590001', 'Sandy One', 'text', 'hello sandbox', null, now());
select tests.logout();
select tests.ok((select duplicate from sd), 'redelivery of the same message id is a duplicate');
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.K.IN1'$q$), 1::bigint, 'no second message');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('sconv1')$q$), 1::bigint, 'and still one lead');

-- a message id that belongs to a META account can never be touched through the Kapso wrapper
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.K.META_OWNED', '97455590020', 'Meta Customer', 'text', 'meta message', null, now());
select tests.throws($q$select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.META_OWNED', '97455590020', 'Meta Customer', 'text', 'meta message', null, now())$q$,
  'kapso.message_account_mismatch', 'a Meta message id replayed through Kapso is refused');
select tests.throws($q$select public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.META_OWNED', 'delivered', null, null)$q$,
  'kapso.message_account_mismatch', 'and so is a status for it');
select tests.logout();
select tests.ok((select status = 'received' and not is_sandbox from public.messages where wa_message_id = 'wamid.K.META_OWNED'), 'the Meta message is untouched');

-- The same person later writes to a REAL number: contacts are shared by phone, so the contact stops being
-- "sandbox only" (the flag is a display hint; metrics never read it).
select tests.ok((select is_sandbox from public.contacts where phone_e164 = '+97455591050') is not true, 'precondition: contact not flagged yet');
select tests.service();
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.UF1', '97455591050', 'Both Worlds', 'text', 'sandbox first', null, now());
select tests.logout();
select tests.ok((select is_sandbox from public.contacts where phone_e164 = '+97455591050'), 'a sandbox-only contact is flagged');
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.K.UF2', '97455591050', 'Both Worlds', 'text', 'now from a real number', null, now());
select tests.logout();
select tests.ok((select not is_sandbox from public.contacts where phone_e164 = '+97455591050'), 'the first link to a real company clears the flag');
select tests.eq(tests.count($q$select * from public.contact_companies cc join public.contacts k on k.id = cc.contact_id where k.phone_e164 = '+97455591050'$q$), 2::bigint, 'and the contact belongs to both companies');
select tests.eq((select count(*) from public.leads l join public.contacts k on k.id = l.contact_id where k.phone_e164 = '+97455591050' and l.company_id = tests.ref('sandbox')), 1::bigint, 'its sandbox lead stays in the sandbox company');
select tests.eq((select count(*) from public.leads l join public.contacts k on k.id = l.contact_id where k.phone_e164 = '+97455591050' and l.company_id = tests.ref('alpha')), 1::bigint, 'and its real lead stays in Alpha');

-- ============================================ D. statuses, echoes and races
select tests.service();
-- A status event for a message the CRM did not create: recorded as an echo (no employee), then applied.
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.OUT1', 'sent', null, null, '97455590001', 'text', 'reply sent from Kapso', null, now() - interval '90 seconds'),
  'an unknown outbound message with its content becomes an echo and takes the status');
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.OUT1', 'delivered', null, null, '97455590001', 'text', 'reply sent from Kapso', null, now()), 'delivered');
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.OUT1', 'read', null, null, '97455590001', 'text', 'reply sent from Kapso', null, now()), 'read');
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.OUT1', 'sent', null, null, '97455590001', 'text', 'reply sent from Kapso', null, now()), 'a late duplicate "sent" is accepted');
select tests.logout();
select tests.ok((select direction = 'outbound' and sent_by is null and is_sandbox and status = 'read' from public.messages where wa_message_id = 'wamid.K.OUT1'),
  'it is an outbound echo without a sender, flagged sandbox; statuses only move forward (a late "sent" did not regress "read")');
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.K.OUT1'$q$), 1::bigint, 'and exists exactly once');

select tests.service();
-- Status BEFORE the message (race): delivered arrives first, creates the echo, later events are harmless.
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.RACE', 'delivered', null, null, '97455590001', 'text', 'raced', null, now()), 'status-before-message creates the record');
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.RACE', 'sent', null, null, '97455590001', 'text', 'raced', null, now()), 'the earlier "sent" arrives late');
select tests.logout();
select tests.eq((select status::text from public.messages where wa_message_id = 'wamid.K.RACE'), 'delivered', 'the race ends at the furthest status');
select tests.service();
select tests.ok(public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.FAIL', 'failed', '131047', 'Re-engagement message', '97455590001', 'text', 'will fail', null, now()), 'failed status with an error');
select tests.logout();
select tests.ok((select status = 'failed' and error_code = '131047' from public.messages where wa_message_id = 'wamid.K.FAIL'), 'the failure code is recorded');
select tests.service();
select tests.ok(not public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.UNKNOWN', 'delivered', null, null), 'without the customer phone an unknown message cannot be recorded (returns false, retried later)');
select tests.ok(not public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.IN1', 'delivered', null, null), 'inbound messages never take a delivery status');
select tests.logout();
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.K.UNKNOWN'$q$), 0::bigint, 'nothing was invented for the unknown message');

-- ===================================================== E. retries (additive branch, Meta untouched)
select tests.service();
select public.claim_webhook_event('kapso:msg:wamid.K.RETRY1', 'message', 'KAPSO_PNID_1', jsonb_build_object(
  'kind', 'kapso_message', 'phoneNumberId', 'KAPSO_PNID_1', 'waMessageId', 'wamid.K.RETRY1', 'fromWaId', '97455590030',
  'profileName', 'Retry Sandy', 'messageType', 'text', 'body', 'retry me', 'media', null, 'sentAt', now()));
select public.finish_webhook_event('kapso:msg:wamid.K.RETRY1', 'failed', 'processing_error');
select public.claim_webhook_event('kapso:status:wamid.K.RETRYST:delivered', 'status', 'KAPSO_PNID_1', jsonb_build_object(
  'kind', 'kapso_status', 'phoneNumberId', 'KAPSO_PNID_1', 'waMessageId', 'wamid.K.RETRYST', 'status', 'delivered',
  'errorCode', null, 'errorMessage', null, 'toWaId', '97455590030', 'messageType', 'text', 'body', 'retry status', 'media', null, 'sentAt', now()));
select public.finish_webhook_event('kapso:status:wamid.K.RETRYST:delivered', 'failed', 'processing_error');
-- a Kapso event whose account was never a sandbox account stays failed and creates nothing
select public.claim_webhook_event('kapso:msg:wamid.K.RETRYBAD', 'message', 'PNID_ALPHA', jsonb_build_object(
  'kind', 'kapso_message', 'phoneNumberId', 'PNID_ALPHA', 'waMessageId', 'wamid.K.RETRYBAD', 'fromWaId', '97455590031',
  'profileName', 'Bad', 'messageType', 'text', 'body', 'x', 'media', null, 'sentAt', now()));
select public.finish_webhook_event('kapso:msg:wamid.K.RETRYBAD', 'failed', 'processing_error');
select tests.eq(public.process_webhook_retries() ->> 'processed', '2', 'the retry job re-runs Kapso events through the wrappers (2 of 3 succeed)');
select tests.eq(public.process_webhook_retries() ->> 'processed', '0', 'a second run changes nothing');
select tests.logout();
select tests.eq(tests.count($q$select * from public.messages where wa_message_id in ('wamid.K.RETRY1', 'wamid.K.RETRYST')$q$), 2::bigint, 'exactly one message each');
select tests.eq((select status from public.whatsapp_webhook_events where event_key = 'kapso:msg:wamid.K.RETRYBAD'), 'failed', 'the non-sandbox event stays failed');
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.K.RETRYBAD'$q$), 0::bigint, 'and wrote nothing into a Meta account');

-- ============================================ F. Phase 1: no sending from sandbox conversations
select tests.login('agent_a1');
select tests.throws(format($q$select * from public.queue_outbound(%L, gen_random_uuid(), 'text', 'reply from CRM')$q$, tests.ref('sconv1')),
  'whatsapp.sandbox_send_disabled', 'an employee cannot queue a reply in a sandbox conversation');
select tests.logout();
select tests.eq(tests.count($q$select * from public.messages where conversation_id = tests.ref('sconv1') and sent_by is not null$q$), 0::bigint, 'no employee message exists in it');

-- ============================================ G. flags cannot be forged; boundary cannot be crossed
select tests.login('super');
update public.leads set is_sandbox = false where conversation_id = tests.ref('sconv1');
update public.conversations set is_sandbox = false where id = tests.ref('sconv1');
update public.contacts set is_sandbox = true where phone_e164 = '+97455590010';
insert into public.contacts (full_name, phone_e164, is_sandbox) values ('Forged Flag', '+97455590099', true);
select tests.logout();
select tests.ok((select l.is_sandbox from public.leads l where l.conversation_id = tests.ref('sconv1')) and (select c.is_sandbox from public.conversations c where c.id = tests.ref('sconv1')),
  'lead and conversation flags are re-derived from the company, whatever the request says');
select tests.ok((select not is_sandbox from public.contacts where phone_e164 = '+97455590010') and (select not is_sandbox from public.contacts where phone_e164 = '+97455590099'),
  'a user cannot set a contact''s sandbox flag');
select tests.login('super');
select tests.throws(format($q$select public.move_conversation_company(%L, tests.ref('alpha'), 'test crossing out')$q$, tests.ref('sconv1')),
  'conversation.sandbox_boundary', 'a sandbox conversation cannot move to a real company');
select tests.throws($q$select public.move_conversation_company((select conversation_id from public.messages where wa_message_id = 'wamid.K.META_OWNED'), tests.ref('sandbox'), 'test crossing in')$q$,
  'conversation.sandbox_boundary', 'nor a real one into the sandbox company');
select tests.throws($q$update public.leads set company_id = tests.ref('alpha') where conversation_id = tests.ref('sconv1')$q$, 'immutable',
  'a lead cannot change company');
select tests.logout();

-- ===================================================== H. PROOF: sandbox never reaches real metrics
create schema if not exists tests;
create or replace function tests.snap_call(p_label text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  begin
    execute format('select coalesce(jsonb_agg(to_jsonb(q) order by to_jsonb(q)::text), ''[]''::jsonb) from (%s) q', p_sql) into v;
  exception when others then
    v := to_jsonb('ERR:' || sqlerrm);
  end;
  return jsonb_build_object(p_label, v);
end $$;

create or replace function tests.metrics_snapshot() returns jsonb language plpgsql as $$
declare
  v_from date := current_date - 120;
  v_to date := current_date + 1;
  ids uuid[] := array[tests.ref('alpha'), tests.ref('beta'), tests.ref('gamma'), tests.ref('sandbox')];
  c uuid;
  d jsonb := '{}'::jsonb;
begin
  d := d || tests.snap_call('kpis_default', format('select * from public.report_company_kpis(%L, %L)', v_from, v_to));
  d := d || tests.snap_call('kpis_all_ids', format('select * from public.report_company_kpis(%L, %L, %L::uuid[])', v_from, v_to, ids));
  foreach c in array ids loop
    d := d || tests.snap_call('kpis_' || c, format('select * from public.report_company_kpis(%L, %L, array[%L]::uuid[])', v_from, v_to, c));
    d := d || tests.snap_call('daily_' || c, format('select * from public.report_daily_series(%L, %L, %L)', c, v_from, v_to));
    d := d || tests.snap_call('emp_' || c, format('select * from public.report_employee_performance(%L, %L, %L)', c, v_from, v_to));
    d := d || tests.snap_call('targets_' || c, format('select * from public.report_target_progress(%L, current_date)', c));
    d := d || tests.snap_call('resp_' || c, format('select * from public.report_whatsapp_response(%L, %L, %L, false)', c, v_from, v_to));
    d := d || tests.snap_call('respsim_' || c, format('select * from public.report_whatsapp_response(%L, %L, %L, true)', c, v_from, v_to));
  end loop;
  d := d || tests.snap_call('workload_null', 'select * from public.report_whatsapp_workload()');
  d := d || tests.snap_call('workload_ids', format('select * from public.report_whatsapp_workload(%L::uuid[])', ids));
  return d;
end $$;

create table tests.snap (phase text, caller text, doc jsonb);
grant all on tests.snap to public;
create or replace function tests.take_snapshots(p_phase text) returns void language plpgsql as $$
declare u text;
begin
  foreach u in array array['super', 'admin_a', 'mgr_a', 'agent_a1', 'shared', 'admin_b', 'agent_b'] loop
    perform tests.login(u);
    insert into tests.snap select p_phase, u, tests.metrics_snapshot();
  end loop;
  perform tests.logout();
end $$;
create or replace function tests.snap_diff(p_a text, p_b text) returns text language sql as $$
  select coalesce(string_agg(a.caller || ':' || k, ', '), '')
  from tests.snap a join tests.snap b on b.caller = a.caller and b.phase = p_b,
       lateral (select key as k from jsonb_object_keys(a.doc || b.doc) key where (a.doc -> key) is distinct from (b.doc -> key)) d
  where a.phase = p_a
$$;

-- Real-company activity that exists BEFORE any further sandbox traffic: leads, deals (won/lost/open), tasks,
-- activities, a target and WhatsApp conversations in Alpha and Beta.
do $$
declare
  a uuid := tests.ref('alpha'); b uuid := tests.ref('beta');
  a1 uuid := tests.uid('agent_a1'); ab uuid := tests.uid('agent_b'); adm uuid := tests.uid('admin_a');
  ct uuid := tests.ref('contact_shared');
  pa uuid; sa_won uuid; sa_lost uuid; sa_open uuid; pb uuid; sb_won uuid;
  l1 uuid;
begin
  select id into pa from public.pipelines where company_id = a and kind = 'deal' and is_default;
  select id into sa_won from public.pipeline_stages where pipeline_id = pa and stage_type = 'won';
  select id into sa_lost from public.pipeline_stages where pipeline_id = pa and stage_type = 'lost';
  select id into sa_open from public.pipeline_stages where pipeline_id = pa and stage_type = 'open' order by position limit 1;
  select id into pb from public.pipelines where company_id = b and kind = 'deal' and is_default;
  select id into sb_won from public.pipeline_stages where pipeline_id = pb and stage_type = 'won';
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
    values (a, ct, 'Real lead A1', a1, a1, now() - interval '20 days') returning id into l1;
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
    values (b, ct, 'Real lead B1', ab, ab, now() - interval '15 days');
  insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at, created_at)
    values (a, l1, ct, pa, sa_won, 'Real won', 1500, a1, a1, now() - interval '10 days', now() - interval '18 days');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, lost_at, loss_reason)
    values (a, ct, pa, sa_lost, 'Real lost', 400, a1, a1, now() - interval '9 days', 'price');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, probability)
    values (a, ct, pa, sa_open, 'Real open', 900, a1, a1, 50);
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at)
    values (b, ct, pb, sb_won, 'Real won B', 700, ab, ab, now() - interval '5 days');
  insert into public.tasks (company_id, title, assigned_to, created_by, status, completed_at, completed_by)
    values (a, 'Real task done', a1, a1, 'completed', now() - interval '8 days', a1);
  insert into public.tasks (company_id, title, assigned_to, created_by, due_at) values (a, 'Real overdue', a1, a1, now() - interval '2 days');
  insert into public.activities (company_id, type, actor_id, lead_id, occurred_at)
    values (a, 'call', a1, l1, now() - interval '12 days'), (a, 'meeting', a1, l1, now() - interval '11 days');
  insert into public.sales_targets (company_id, user_id, metric, period_start, period_end, target_value, created_by)
    values (a, a1, 'won_revenue', current_date - 30, current_date + 30, 3000, adm);
end $$;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.K.REAL_A', '97455590040', 'Real Alpha Customer', 'text', 'real alpha', null, now() - interval '3 days');
select * from public.ingest_whatsapp_message('PNID_BETA', 'wamid.K.REAL_B', '97455590041', 'Real Beta Customer', 'text', 'real beta', null, now() - interval '2 days');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select conversation_id, 'outbound', 'delivered', 'real reply', tests.uid('agent_a1'), now() - interval '3 days' + interval '5 minutes', 'wamid.K.REAL_A_OUT'
from public.messages where wa_message_id = 'wamid.K.REAL_A';

-- Snapshot: every report function, 7 callers, 4 companies, aggregates, with and without the sandbox id.
select tests.take_snapshots('before');

-- Make sure the test is not vacuous: the snapshot is not empty for real companies.
select tests.ok((select (doc -> ('kpis_' || tests.ref('alpha'))) <> '[]'::jsonb from tests.snap where phase = 'before' and caller = 'super'),
  'precondition: the super admin snapshot contains real Alpha metrics');

-- ---- FULL sandbox activity: contacts, conversations, messages, leads, a won deal, a lost deal, tasks,
-- ---- activities, a target, employee activity: everything a real company would have.
select tests.service();
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.BULK1', '97455591001', 'Bulk One', 'text', 'bulk one', null, now() - interval '1 day');
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.BULK2', '97455591002', 'Bulk Two', 'text', 'bulk two', null, now() - interval '1 day');
select * from public.ingest_kapso_message('KAPSO_PNID_1', 'wamid.K.BULK3', '97455591003', 'Bulk Three', 'text', 'bulk three', null, now() - interval '1 day');
select public.apply_kapso_status('KAPSO_PNID_1', 'wamid.K.BULKOUT1', 'read', null, null, '97455591001', 'text', 'answered in Kapso', null, now() - interval '23 hours');
-- The EXISTING Meta intake is unchanged and does not check the provider: a Meta-signed payload that names a Kapso
-- phone_number_id can only ever create sandbox data (company, flags and metrics exclusion all follow the account).
select * from public.ingest_whatsapp_message('KAPSO_PNID_1', 'wamid.K.VIAMETA', '97455591077', 'Via Meta Path', 'text', 'through the Meta route', null, now() - interval '20 hours');
select tests.logout();
do $$
declare
  s uuid := tests.ref('sandbox');
  sm uuid := tests.uid('mgr_a'); sa uuid := tests.uid('agent_a1');
  ps uuid; ss_won uuid; ss_lost uuid; ss_open uuid;
  l uuid; ct uuid;
begin
  select id into ps from public.pipelines where company_id = s and kind = 'deal' and is_default;
  select id into ss_won from public.pipeline_stages where pipeline_id = ps and stage_type = 'won';
  select id into ss_lost from public.pipeline_stages where pipeline_id = ps and stage_type = 'lost';
  select id into ss_open from public.pipeline_stages where pipeline_id = ps and stage_type = 'open' order by position limit 1;
  select id, contact_id into l, ct from public.leads where company_id = s order by created_at limit 1;
  -- manual lead + conversions + all the child records
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values (s, ct, 'Sandbox manual lead', sa, sa, now() - interval '5 days');
  insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at, created_at)
    values (s, l, ct, ps, ss_won, 'Sandbox won', 888000, sa, sa, now() - interval '4 days', now() - interval '6 days');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, lost_at, loss_reason)
    values (s, ct, ps, ss_lost, 'Sandbox lost', 12345, sa, sa, now() - interval '3 days', 'price');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, probability)
    values (s, ct, ps, ss_open, 'Sandbox open', 555000, sa, sa, 90);
  insert into public.tasks (company_id, title, assigned_to, created_by, status, completed_at, completed_by)
    values (s, 'Sandbox task done', sa, sa, 'completed', now() - interval '2 days', sa);
  insert into public.tasks (company_id, title, assigned_to, created_by, due_at) values (s, 'Sandbox overdue', sa, sa, now() - interval '3 days');
  insert into public.activities (company_id, type, actor_id, lead_id, occurred_at)
    values (s, 'call', sa, l, now() - interval '4 days'), (s, 'meeting', sm, l, now() - interval '3 days'), (s, 'whatsapp', sa, l, now() - interval '2 days');
  insert into public.sales_targets (company_id, user_id, metric, period_start, period_end, target_value, created_by)
    values (s, sa, 'won_revenue', current_date - 30, current_date + 30, 100, sm);
  -- Messages of employees are blocked in Phase 1, but the intake can record a sender-less answer; also contacts and notes.
  insert into public.conversation_notes (conversation_id, author_id, body)
    select c.id, sa, 'sandbox note' from public.conversations c where c.company_id = s limit 1;
end $$;
-- employee sign-ins by sandbox members are not company data, but make the sandbox members busy anyway
update public.leads set interest = 'interested' where company_id = tests.ref('sandbox');
-- Contact merges: links move with the merge, and a flagged contact that gains a real company link is unflagged.
insert into public.contacts (full_name) values ('Merge Target'), ('Merge Target 2');
insert into public.contact_companies (contact_id, company_id)
select id, tests.ref('alpha') from public.contacts where full_name in ('Merge Target', 'Merge Target 2');
select tests.login('super');
select tests.lives($q$select public.merge_contacts((select id from public.contacts where full_name = 'Merge Target'),
  (select id from public.contacts where phone_e164 = '+97455591003'))$q$, 'a real contact absorbs a sandbox contact');
select tests.lives($q$select public.merge_contacts((select id from public.contacts where phone_e164 = '+97455591002'),
  (select id from public.contacts where full_name = 'Merge Target 2'))$q$, 'a flagged contact absorbs a real contact');
select tests.logout();
select tests.ok((select not k.is_sandbox and k.phone_e164 = '+97455591003' from public.contacts k where k.full_name = 'Merge Target'), 'the surviving real contact is not flagged');
select tests.ok((select not k.is_sandbox from public.contacts k where k.phone_e164 = '+97455591002'), 'the flagged survivor is unflagged once it belongs to a real company');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts k on k.id = l.contact_id where k.full_name = 'Merge Target' and l.company_id = tests.ref('sandbox')$q$), 1::bigint,
  'the merged sandbox lead is still in the sandbox company');

-- Control: sandbox data really exists, in volume, in every table the metrics read.
-- (The contact flag is only a display hint set by the Kapso wrappers; it is not required for isolation.)
select tests.ok((select c.company_id = tests.ref('sandbox') and c.is_sandbox and m.is_sandbox
                  from public.messages m join public.conversations c on c.id = m.conversation_id
                  where m.wa_message_id = 'wamid.K.VIAMETA')
                and (select l.company_id = tests.ref('sandbox') and l.is_sandbox from public.leads l
                     join public.conversations c on c.id = l.conversation_id join public.messages m on m.conversation_id = c.id
                     where m.wa_message_id = 'wamid.K.VIAMETA'),
  'sandbox data created through the unchanged Meta intake still lands only in the sandbox company, flagged (conversation, message, lead)');
select tests.ok((select count(*) >= 4 from public.leads where company_id = tests.ref('sandbox')), 'sandbox leads exist');
select tests.ok((select count(*) = 3 and sum(amount) > 1000000 from public.deals where company_id = tests.ref('sandbox')), 'sandbox deals exist, including a very large won one');
select tests.ok((select count(*) >= 2 from public.tasks where company_id = tests.ref('sandbox')), 'sandbox tasks exist');
select tests.ok((select count(*) >= 3 from public.activities where company_id = tests.ref('sandbox')), 'sandbox activities exist');
select tests.ok((select count(*) >= 6 from public.messages m join public.conversations c on c.id = m.conversation_id where c.company_id = tests.ref('sandbox')), 'sandbox messages exist');
select tests.ok((select count(*) >= 1 from public.sales_targets where company_id = tests.ref('sandbox')), 'a sandbox target exists');

select tests.take_snapshots('after');

-- THE PROOF: identical results for every report function, every caller, every company, every aggregate.
select tests.eq(tests.snap_diff('before', 'after'), '', 'NO report result changed for any of 7 callers after full sandbox activity (all report functions, per-company and aggregate)');
select tests.eq((select count(*) from tests.snap where phase = 'after'), 7::bigint, 'all 7 callers were snapshotted');
select tests.eq(coalesce((select string_agg(v.key || '=' || (v.value #>> '{}'), ' | ') from tests.snap s, jsonb_each(s.doc) v
                          where s.phase = 'after' and s.caller = 'super' and jsonb_typeof(v.value) <> 'array'), ''), '',
  'for the super admin every report call succeeded (no hidden errors in the snapshot)');

-- The sandbox company's own reports are empty (sandbox companies are out of report scope).
select tests.eq(coalesce((select string_agg(v.key || '=' || left(v.value::text, 300), ' | ')
                          from tests.snap s, jsonb_each(s.doc) v
                          where s.phase = 'after' and s.caller = 'super' and v.key like '%' || tests.ref('sandbox')::text and v.key not like 'daily\_%' and v.value <> '[]'::jsonb), ''), '',
  'reports for the sandbox company return nothing, even for the super admin and with simulated data included');
select tests.eq(coalesce((select string_agg(kv.key || '=' || kv.value, ',')
                          from tests.snap s, jsonb_each(s.doc) v, jsonb_array_elements(v.value) e, jsonb_each_text(e) kv
                          where s.phase = 'after' and s.caller = 'super' and v.key = 'daily_' || tests.ref('sandbox')::text
                            and kv.key <> 'day' and kv.value <> '0'), ''), '',
  'the sandbox company''s daily series (a zero-filled calendar) contains only zeros');
select tests.ok((select (doc -> 'kpis_default') -> 0 ->> 'company_id' is not null and jsonb_array_length(doc -> 'kpis_default') = 3 from tests.snap where phase = 'after' and caller = 'super'),
  'the super admin''s all-companies KPIs list the 3 real companies, never the sandbox');
select tests.ok((select (doc -> ('kpis_' || tests.ref('sandbox'))) = '[]'::jsonb and (doc -> ('emp_' || tests.ref('sandbox'))) = '[]'::jsonb from tests.snap where phase = 'after' and caller = 'mgr_a'),
  'a sandbox company member sees no sandbox metrics either');
select tests.ok((select (doc -> 'kpis_all_ids') = (doc -> 'kpis_default') from tests.snap where phase = 'after' and caller = 'super'),
  'asking explicitly for the sandbox id alongside real companies changes nothing');
select tests.ok((select not exists (select 1 from jsonb_array_elements(doc -> 'workload_null') w where w ->> 'company_id' = tests.ref('sandbox')::text)
                    and not exists (select 1 from jsonb_array_elements(doc -> 'workload_ids') w where w ->> 'company_id' = tests.ref('sandbox')::text)
                 from tests.snap where phase = 'after' and caller = 'super'),
  'the WhatsApp workload snapshot never lists the sandbox company');

-- Non-vacuity control: the same snapshot DOES change when a REAL company gets activity.
insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at)
values (tests.ref('alpha'), tests.ref('contact_shared'), 'Real lead after', tests.uid('agent_a1'), tests.uid('agent_a1'), now() - interval '1 day');
select tests.take_snapshots('control');
select tests.ok(tests.snap_diff('after', 'control') <> '', 'control: the snapshot detects a change in a real company (it is not blind)');
select tests.ok(tests.snap_diff('after', 'control') like '%kpis_' || tests.ref('alpha') || '%', 'and it is the real company''s KPIs that changed');

-- ===================================================== I. invariants: nothing crosses the boundary
select tests.eq((select count(*) from public.leads l where l.is_sandbox is distinct from app.company_is_sandbox(l.company_id)), 0::bigint, 'every lead flag matches its company');
select tests.eq((select count(*) from public.conversations c where c.is_sandbox is distinct from app.company_is_sandbox(c.company_id)), 0::bigint, 'every conversation flag matches its company');
select tests.eq((select count(*) from public.messages m where m.is_sandbox is distinct from app.conversation_is_sandbox(m.conversation_id)), 0::bigint, 'every message flag matches its conversation');
select tests.eq((select count(*) from public.contacts k where k.is_sandbox and exists (select 1 from public.contact_companies cc where cc.contact_id = k.id and not app.company_is_sandbox(cc.company_id))), 0::bigint,
  'no flagged contact is linked to a real company');
select tests.eq((select count(*) from public.deals d where app.company_is_sandbox(d.company_id) and d.lead_id is not null and exists (select 1 from public.leads l where l.id = d.lead_id and l.company_id <> d.company_id)), 0::bigint,
  'no sandbox deal points at a lead of another company');
select tests.eq((select count(*) from public.whatsapp_accounts a where a.is_sandbox <> app.company_is_sandbox(a.default_company_id)), 0::bigint, 'every account matches its company');
select tests.eq((select count(*) from public.conversations c join public.whatsapp_accounts a on a.id = c.whatsapp_account_id where c.company_id <> a.default_company_id and (c.is_sandbox or a.is_sandbox)), 0::bigint,
  'no sandbox conversation sits outside its account''s company');

-- Existing Meta data is untouched by sandbox activity.
select tests.eq((select status::text from public.messages where wa_message_id = 'wamid.K.REAL_A_OUT'), 'delivered', 'a real Alpha reply keeps its status');
select tests.eq(tests.count($q$select * from public.messages m join public.conversations c on c.id = m.conversation_id join public.whatsapp_accounts a on a.id = c.whatsapp_account_id where a.provider = 'meta' and (m.is_sandbox or c.is_sandbox)$q$), 0::bigint,
  'no Meta message or conversation is flagged sandbox');

-- ===================================================== J. tripwire: any new function reading business tables needs review
select tests.eq(coalesce((select string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app') and p.prokind = 'f' and p.prosrc ~* '\m(leads|deals|tasks|activities|messages|conversations|sales_targets)\M'), ''),
  case when to_regprocedure('public.ingest_kapso_inbound(text,text,text,text,text,text,text,text,jsonb,timestamptz)') is null
    then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_lead,app.guard_stage,app.guard_task,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_target_progress,public.report_whatsapp_response,public.report_whatsapp_workload'
    when to_regprocedure('app.kapso_lock_conversation_contact(uuid)') is null
    then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_target_progress,public.report_whatsapp_response,public.report_whatsapp_workload'
    when to_regprocedure('public.report_monthly_commission(uuid,date)') is null
      then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_target_progress,public.report_whatsapp_response,public.report_whatsapp_workload'
    when to_regprocedure('public.report_waiting_now(uuid)') is null
      then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_monthly_commission,public.report_target_progress,public.report_whatsapp_response,public.report_whatsapp_workload,public.set_monthly_target'
    when to_regprocedure('public.report_shift_activity(uuid,date,date,uuid)') is null
      then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_leads_per_day,public.report_monthly_commission,public.report_response_speed,public.report_target_progress,public.report_waiting_now,public.report_whatsapp_response,public.report_whatsapp_workload,public.set_monthly_target'
    when to_regprocedure('public.report_employee_day(uuid,date,date,uuid)') is null
      then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_performance,public.report_leads_per_day,public.report_monthly_commission,public.report_response_speed,public.report_shift_activity,public.report_target_progress,public.report_waiting_now,public.report_whatsapp_response,public.report_whatsapp_workload,public.set_monthly_target'
    when to_regprocedure('public.report_workshop_kpis(uuid,date,date,uuid)') is null
      then 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_day,public.report_employee_performance,public.report_leads_per_day,public.report_monthly_commission,public.report_response_speed,public.report_shift_activity,public.report_target_progress,public.report_waiting_now,public.report_whatsapp_response,public.report_whatsapp_workload,public.set_monthly_target'
    else 'app.after_activity_insert,app.after_message_insert,app.after_task_change,app.block_kapso_unready_send,app.can_access_conversation,app.can_access_deal,app.can_access_entity,app.can_access_lead,app.can_see_contact,app.conversation_has_open_lead,app.conversation_is_sandbox,app.conversation_matches,app.ensure_whatsapp_lead,app.guard_account_sandbox,app.guard_activity,app.guard_attachment,app.guard_conversation,app.guard_lead,app.guard_stage,app.guard_task,app.kapso_lock_conversation_contact,app.kapso_resolve_conversation,app.sync_auto_lead_owner,app.unlink_leads_on_conversation_move,app.visible_contact_ids,public.apply_kapso_status,public.apply_kapso_status_v2,public.apply_whatsapp_status,public.assign_conversation,public.assign_lead,public.convert_lead_to_deal,public.expire_unconfirmed_outbound,public.find_or_create_contact,public.generate_task_reminders,public.global_search,public.import_leads,public.ingest_kapso_echo,public.ingest_kapso_inbound,public.ingest_kapso_message,public.ingest_whatsapp_echo,public.ingest_whatsapp_message,public.lead_from_conversation,public.merge_contacts,public.move_conversation_company,public.queue_outbound,public.record_outbound_result,public.record_outbound_unconfirmed,public.report_company_kpis,public.report_daily_series,public.report_employee_day,public.report_employee_performance,public.report_leads_per_day,public.report_monthly_commission,public.report_response_speed,public.report_shift_activity,public.report_target_progress,public.report_waiting_now,public.report_whatsapp_response,public.report_whatsapp_workload,public.report_workshop_kpis,public.set_monthly_target' end,
  'TRIPWIRE: the set of functions reading business tables changed. Review whether a metric, KPI or report now needs sandbox exclusion, then update this list (the second list applies once the Rev6 migration, which adds 7 ingest/guard functions, is installed; the third once patch 20261104000972, which adds app.kapso_lock_conversation_contact, is installed too)');

rollback;
