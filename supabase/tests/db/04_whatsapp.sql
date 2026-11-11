-- WhatsApp conversations and messages. Brief §19 scenarios 7 and 8.
begin;

-- --------------------------------------------- 7. idempotent ingestion
select tests.service();
create temp table i1 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.X1', '97455559999',
  'New Customer', 'text', 'Hi, price list please', null, now() - interval '10 minutes');
create temp table i2 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.X1', '97455559999',
  'New Customer', 'text', 'Hi, price list please', null, now() - interval '10 minutes');
select tests.ok((select not duplicate from i1) and (select duplicate from i2), 'second delivery is reported as duplicate');
select tests.eq((select message_id from i1), (select message_id from i2), 'duplicate returns the same message id');
select tests.logout();
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.X1'$q$), 1::bigint,
  'duplicate webhook delivery stores one message');
select tests.eq((select unread_count from public.conversations where id = (select conversation_id from i1)), 1,
  'duplicate delivery does not inflate unread count');
insert into tests.refs select 'conv_x', conversation_id from i1;
select tests.ok(exists (select 1 from public.contacts where phone_e164 = '+97455559999' and full_name = 'New Customer'),
  'unknown sender becomes a contact with their WhatsApp profile name');
select tests.ok(exists (select 1 from public.contact_companies cc join public.contacts c on c.id = cc.contact_id
  where c.phone_e164 = '+97455559999' and cc.company_id = tests.ref('alpha')), 'contact linked to the number''s default company');

select tests.service();
select tests.throws($q$select * from public.ingest_whatsapp_message('PNID_UNKNOWN', 'wamid.X2', '97455559999', 'x', 'text', 'x', null, now())$q$,
  'whatsapp.unknown_phone_number_id', 'messages for an unknown phone number id are rejected');
select tests.throws($q$select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.X3', 'not-a-number', 'x', 'text', 'x', null, now())$q$,
  'whatsapp.invalid_payload', 'malformed sender id rejected');
-- A second message from the same customer joins the same conversation.
create temp table i3 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.X4', '97455559999',
  'New Customer', 'text', 'Are you open today?', null, now() - interval '5 minutes');
select tests.eq((select conversation_id from i3), tests.ref('conv_x'), 'same customer + same number = same conversation');
select tests.logout();

-- -------------------------------------------------------- visibility & claim
select tests.login('agent_a2');   -- has number access but cannot reply
select tests.eq(tests.count('select * from public.conversations'), 1::bigint, 'agent with number access sees unassigned conversation');
select tests.login('agent_b');    -- other company, no number access
select tests.eq(tests.count('select * from public.conversations'), 0::bigint, 'agent without access sees no conversation');
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.messages where conversation_id = tests.ref('conv_x')$q$), 0::bigint,
  'other company admin cannot read the messages');

select tests.login('agent_a1');
select tests.lives($q$select public.assign_conversation(tests.ref('conv_x'), auth.uid())$q$, 'agent claims unassigned conversation');
select tests.login('agent_a2');
select tests.eq(tests.count('select * from public.conversations'), 0::bigint, 'once claimed, other agents no longer see it');
select tests.throws($q$select public.assign_conversation(tests.ref('conv_x'), auth.uid())$q$, 'conversation.not_found',
  'another agent cannot steal a claimed conversation');
select tests.login('mgr_a');
select tests.throws($q$select public.assign_conversation(tests.ref('conv_x'), tests.uid('agent_b'))$q$,
  'conversation.owner_needs_number_access', 'cannot assign to someone without access to the number');
select tests.lives($q$select public.assign_conversation(tests.ref('conv_x'), tests.uid('agent_a2'), 'cover shift')$q$,
  'manager can reassign to an agent whose number grant they cannot read themselves');
select tests.lives($q$select public.assign_conversation(tests.ref('conv_x'), tests.uid('agent_a1'))$q$, 'and back');
select tests.logout();
select tests.ok(exists (select 1 from public.conversation_assignments where conversation_id = tests.ref('conv_x')
  and to_user_id = tests.uid('agent_a1') and assigned_by = tests.uid('agent_a1')), 'claim recorded in assignment history');

-- ------------------------------------------------------------- replies
select tests.login('agent_a1');
select tests.throws($q$update public.conversations set last_inbound_at = now() where id = tests.ref('conv_x')$q$,
  'conversation.system_field', 'users cannot tamper with the 24h window timestamps');
select tests.lives($q$update public.conversations set unread_count = 0 where id = tests.ref('conv_x')$q$, 'agent marks conversation read');
create temp table q1 as select * from public.queue_outbound_message(tests.ref('conv_x'), 'Sure — sending the list now.',
  '11111111-1111-1111-1111-111111111111');
select tests.ok((select not already_queued and phone_number_id = 'PNID_ALPHA' and to_wa_id = '97455559999' from q1),
  'reply queued with routing info for the sender');
create temp table q2 as select * from public.queue_outbound_message(tests.ref('conv_x'), 'Sure — sending the list now.',
  '11111111-1111-1111-1111-111111111111');
select tests.ok((select already_queued from q2) and (select message_id from q1) = (select message_id from q2),
  'retrying with the same request id does not send twice');
insert into tests.refs select 'msg_q1', message_id from q1;
select tests.ok((select sent_by = auth.uid() and status = 'queued' from public.messages where id = (select message_id from q1)),
  'outbound message linked to the authenticated sender');
select tests.throws($q$insert into public.messages (conversation_id, direction, status, body) values
  (tests.ref('conv_x'), 'outbound', 'sent', 'forged')$q$, 'row-level security', 'users cannot insert messages directly');

select tests.login('agent_a2');
select tests.throws($q$select * from public.queue_outbound_message(tests.ref('conv_x'), 'x', gen_random_uuid())$q$,
  'conversation.not_found|no_reply_permission', 'agent without reply permission cannot send');
select tests.login('mgr_a');
select tests.lives($q$select * from public.queue_outbound_message(tests.ref('conv_x'), 'Manager here', gen_random_uuid())$q$,
  'manager with reply permission can reply on a colleague''s conversation');

-- 24-hour customer service window.
select tests.logout();
update public.conversations set last_inbound_at = now() - interval '25 hours' where id = tests.ref('conv_x');
select tests.login('agent_a1');
select tests.throws($q$select * from public.queue_outbound_message(tests.ref('conv_x'), 'late reply', gen_random_uuid())$q$,
  'whatsapp.outside_service_window', 'free-form replies are blocked outside the 24h window');

-- ------------------------------------------- 8. failed outbound handled safely
select tests.service();
select tests.lives($q$select public.record_outbound_result(tests.ref('msg_q1'), null, '131047', 'Re-engagement message')$q$,
  'record a send failure');
select tests.logout();
select tests.ok((select status = 'failed' and error_code = '131047' and wa_message_id is null
  from public.messages where id = tests.ref('msg_q1')), 'failed message keeps error details and no Meta id');
select tests.eq((select body from public.messages where id = tests.ref('msg_q1')), 'Sure — sending the list now.',
  'failed message content preserved for retry/review');

-- Status updates only move forward; out-of-order webhooks cannot regress.
select tests.service();
create temp table q3 as select id from public.messages where body = 'Manager here';
select tests.lives($q$select public.record_outbound_result((select id from q3), 'wamid.OUT1')$q$, 'record a successful send');
select tests.ok(public.apply_whatsapp_status('wamid.OUT1', 'read'), 'apply read status');
select tests.ok(public.apply_whatsapp_status('wamid.OUT1', 'delivered'), 'late delivered status accepted but ignored');
select tests.ok(public.apply_whatsapp_status('wamid.OUT1', 'failed', '1', 'x'), 'late failed status accepted but ignored');
select tests.ok(not public.apply_whatsapp_status('wamid.UNKNOWN', 'read'), 'status for an unknown message reports not-found');
select tests.logout();
select tests.eq((select status::text from public.messages where wa_message_id = 'wamid.OUT1'), 'read',
  'out-of-order delivered/failed did not regress a read message');
select tests.throws($q$update public.messages set body = 'rewritten' where wa_message_id = 'wamid.OUT1'$q$,
  'message.immutable_field', 'message content is immutable even for maintenance');

-- --------------------------------------------- internal notes vs messages
select tests.login('agent_a1');
select tests.logout();
update public.conversations set last_inbound_at = now() where id = tests.ref('conv_x');
select tests.login('agent_a1');
select tests.lives($q$insert into public.conversation_notes (conversation_id, author_id, body)
  values (tests.ref('conv_x'), auth.uid(), 'Customer prefers Arabic')$q$, 'agent adds an internal note');
select tests.eq(tests.count($q$select * from public.messages where body = 'Customer prefers Arabic'$q$), 0::bigint,
  'internal notes are never stored as customer messages');
select tests.login('admin_b');
select tests.eq(tests.count('select * from public.conversation_notes'), 0::bigint, 'notes are not visible to another company');

-- ------------------------------------------------- company re-association
select tests.login('mgr_a');
select tests.throws($q$update public.conversations set company_id = tests.ref('beta') where id = tests.ref('conv_x')$q$,
  'conversation.company_change_forbidden|row-level security', 'manager of only one company cannot move a conversation');
select tests.login('super');
select tests.lives($q$update public.conversations set company_id = tests.ref('beta') where id = tests.ref('conv_x')$q$,
  'super admin can move a conversation to another company');

rollback;
