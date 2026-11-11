-- Conversation → company reassignment (0880).
begin;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.MV1', '97455552020', 'Mover', 'text', 'hi', null, now());
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.MV2', '97455552021', 'Mover Two', 'text', 'hi', null, now());
select tests.logout();
insert into tests.refs select 'mv1', id from public.conversations where customer_wa_id = '97455552020';
insert into tests.refs select 'mv2', id from public.conversations where customer_wa_id = '97455552021';
update public.conversations set owner_id = tests.uid('agent_a1') where id = tests.ref('mv1');   -- member of Alpha only
update public.conversations set owner_id = tests.uid('shared') where id = tests.ref('mv2');     -- member of Alpha and Beta

select tests.login('agent_a1');
select tests.throws($q$select public.move_conversation_company(tests.ref('mv1'), tests.ref('beta'), 'customer belongs to Beta')$q$,
  'conversation.company_change_forbidden', 'an agent cannot move a conversation to another company');
select tests.login('admin_a');
select tests.throws($q$select public.move_conversation_company(tests.ref('mv1'), tests.ref('beta'), 'customer belongs to Beta')$q$,
  'conversation.company_change_forbidden', 'managing only the source company is not enough');

select tests.logout();
insert into public.company_memberships (company_id, user_id, role) values (tests.ref('beta'), tests.uid('admin_a'), 'company_admin');
select tests.login('admin_a');
select tests.throws($q$select public.move_conversation_company(tests.ref('mv1'), tests.ref('beta'), '  ')$q$,
  'conversation.move_reason_required', 'a reason is required');
select tests.lives($q$select public.move_conversation_company(tests.ref('mv1'), tests.ref('beta'), 'customer belongs to Beta')$q$,
  'someone managing both companies can move it');
select tests.lives($q$select public.move_conversation_company(tests.ref('mv2'), tests.ref('beta'), 'Beta account')$q$,
  'second move');
select tests.logout();
select tests.eq((select company_id from public.conversations where id = tests.ref('mv1')), tests.ref('beta'), 'company changed');
select tests.eq((select owner_id from public.conversations where id = tests.ref('mv1')), null::uuid,
  'owner who is not a member of the new company is cleared');
select tests.eq((select owner_id from public.conversations where id = tests.ref('mv2')), tests.uid('shared'),
  'owner who is a member of both companies is kept');
select tests.ok(exists (select 1 from public.conversation_notes where conversation_id = tests.ref('mv1') and body like '%customer belongs to Beta'),
  'the reason is kept as an internal note');
select tests.ok(exists (select 1 from public.audit_logs where entity_id = tests.ref('mv1') and action = 'conversation.company_changed'),
  'the move is audited');
select tests.ok(exists (select 1 from public.contact_companies cc join public.conversations c on c.contact_id = cc.contact_id
  where c.id = tests.ref('mv1') and cc.company_id = tests.ref('beta')), 'the contact is linked to the new company');
select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.conversations where id = tests.ref('mv1')$q$), 0::bigint,
  'the previous owner (Alpha only) no longer sees it');

rollback;
