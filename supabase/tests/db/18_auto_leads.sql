-- Automatic WhatsApp → Lead pipeline (0950).
-- Fixture: Alpha (admin_a, mgr_a, agent_a1 [reply], agent_a2 [read-only], shared),
--          Beta (admin_b, agent_b, cs_b); numbers PNID_ALPHA and PNID_BETA.
begin;

-- Extra fixtures for this file: a second Alpha number and a simulated one.
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status)
values (tests.ref('alpha'), 'Alpha Second Line', '+97440000011', 'PNID_ALPHA2', 'test');
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status, is_simulated)
values (tests.ref('alpha'), 'Alpha Demo', '+97440000012', 'PNID_ALPHA_SIM', 'test', true);

-- Offerings: Alpha's catalogue is managed by its admin; Beta has its own.
select tests.login('admin_a');
insert into public.company_offerings (company_id, name, kind, keywords) values
  (tests.ref('alpha'), 'Graphic Design', 'course', array['graphic design', 'تصميم جرافيك']),
  (tests.ref('alpha'), 'Excel Workshop', 'workshop', array['  Excel ', 'EXCEL', 'اكسل', 'x']),
  (tests.ref('alpha'), 'Python Course', 'course', array['python']),
  (tests.ref('alpha'), 'Data Course', 'course', array['python', 'data analysis']),
  (tests.ref('alpha'), 'C++ Basics', 'course', array['c++']),
  (tests.ref('alpha'), 'Legacy Course', 'course', array['legacy']);
update public.company_offerings set is_active = false where name = 'Legacy Course';
select tests.login('admin_b');
insert into public.company_offerings (company_id, name, kind, keywords) values
  (tests.ref('beta'), 'Beta Only', 'service', array['graphic design', 'betaword']);
select tests.logout();
insert into tests.refs select 'off_' || split_part(lower(name), ' ', 1), id from public.company_offerings;

-- ------------------------------------------------------------- 1. first message
select tests.service();
create temp table i1 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AL1', '97455580001', 'Lina Customer', 'text', 'hello', null, now() - interval '5 minutes');
select tests.logout();
insert into tests.refs select 'conv1', conversation_id from i1;
select tests.eq(tests.count($q$select * from public.contacts where phone_e164 = '+97455580001'$q$), 1::bigint, 'first message creates the contact');
select tests.eq(tests.count($q$select * from public.conversations where customer_wa_id = '97455580001'$q$), 1::bigint, 'first message creates the conversation');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'first message creates exactly one lead');
select tests.ok((select l.source = 'whatsapp' and l.auto_created and l.created_by is null and l.interest = 'unassessed' and l.status = 'new'
                   and l.company_id = tests.ref('alpha') and l.owner_id is null and l.title = 'Lina Customer'
                   and l.offering_id is null and l.offering_source is null
                   and l.contact_id = (select contact_id from public.conversations where id = tests.ref('conv1'))
                 from public.leads l where l.conversation_id = tests.ref('conv1')),
  'the lead is automatic, WhatsApp-sourced, unassessed, new, unowned, in the number''s company, linked to contact and conversation');
select tests.ok(exists (select 1 from public.audit_logs where action = 'lead.created' and actor_id is null
                          and metadata ->> 'automatic' = 'true' and metadata ->> 'conversation_id' = tests.ref('conv1')::text),
  'the audit trail records an automatic creation without an actor');
select tests.ok(exists (select 1 from public.lead_status_history h join public.leads l on l.id = h.lead_id
                         where l.conversation_id = tests.ref('conv1') and h.to_status = 'new' and h.changed_by is null),
  'status history starts without crediting an employee');

-- ------------------------------------------------------- 2. subsequent messages
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AL2', '97455580001', 'Lina Customer', 'text', 'are you there?', null, now() - interval '4 minutes');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AL3', '97455580001', 'Lina Customer', 'text', 'price please', null, now() - interval '3 minutes');
select tests.logout();
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'later messages do not create another lead');
select tests.eq(tests.count($q$select * from public.messages where conversation_id = tests.ref('conv1')$q$), 3::bigint, 'all messages are stored in the same conversation');
select tests.eq((select unread_count from public.conversations where id = tests.ref('conv1')), 3, 'unread counter keeps working');
select tests.ok((select last_inbound_at > now() - interval '3 minutes 30 seconds' from public.conversations where id = tests.ref('conv1')),
  'last-message timestamps keep updating');

-- ---------------------------------------------------- 3. duplicate Meta delivery
select tests.service();
create temp table d1 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.AL2', '97455580001', 'Lina Customer', 'text', 'are you there?', null, now() - interval '4 minutes');
select tests.logout();
select tests.ok((select duplicate from d1), 'redelivery of the same Meta message id is reported as a duplicate');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455580001'$q$), 1::bigint,
  'duplicate delivery creates no second lead');
select tests.eq(tests.count($q$select * from public.messages where wa_message_id = 'wamid.AL2'$q$), 1::bigint, 'nor a second message');

-- ------------------------------------------ 5. missing WhatsApp profile name
select tests.service();
create temp table n1 as select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.NN1', '97455580002', null, 'text', 'hi', null, now());
select tests.logout();
select tests.eq((select l.title from public.leads l where l.conversation_id = (select conversation_id from n1)), '+97455580002',
  'without a profile name the lead falls back to the phone number');

-- ---------------------------------------------- 6-9. offering matching (Alpha)
create or replace function pg_temp.ingest_for(p_id text, p_wa text, p_text text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform tests.service();
  select conversation_id into v from public.ingest_whatsapp_message('PNID_ALPHA', p_id, p_wa, 'Match ' || p_wa, 'text', p_text, null, now());
  perform tests.logout();
  return v;
end $$;
create or replace function pg_temp.offering_of(p_conv uuid) returns text
language sql as $$
  select coalesce(o.name || '/' || l.offering_source, '-') from public.leads l
  left join public.company_offerings o on o.id = l.offering_id where l.conversation_id = p_conv $$;

select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M1', '97455581001', 'Hello, I have a question')), '-',
  'an unidentifiable course leaves the offering unset');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M2', '97455581002', 'I want to join the Excel workshop please')), 'Excel Workshop/auto_keyword',
  'exactly one keyword match attaches the offering and records the automatic source');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M3', '97455581003', 'عايز اعرف تفاصيل دورة تَصْمِيم جرافيك')), 'Graphic Design/auto_keyword',
  'Arabic keywords match (diacritics are ignored)');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M4', '97455581004', 'عايز كورس اكسل')), 'Excel Workshop/auto_keyword',
  'a second keyword of the same offering still counts as one offering');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M5', '97455581005', 'python')), '-',
  'two offerings sharing the matching keyword leave the offering unset');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M6', '97455581006', 'excel and graphic design')), '-',
  'keywords of two different offerings in one message leave it unset');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M7', '97455581007', 'do you still run the legacy course?')), '-',
  'inactive offerings are never selected automatically');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M8', '97455581008', 'betaword')), '-',
  'another company''s keywords never match');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M9', '97455581009', 'I would like to learn C++ now')), 'C++ Basics/auto_keyword',
  'regex characters in keywords are literal');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M10', '97455581010', 'my ID is abc++')), '-',
  'Latin keywords match whole words only');
select tests.eq(pg_temp.offering_of(pg_temp.ingest_for('wamid.M11', '97455581011', 'EXCELLENT service')), '-',
  '"excel" does not match inside "excellent"');

select tests.login('admin_a');
select tests.ok((select keywords @> array['excel', 'اكسل'] and cardinality(keywords) = 2 from public.company_offerings where name = 'Excel Workshop'),
  'keywords are normalised: trimmed, lower-cased, de-duplicated, too-short ones dropped');
select tests.throws($q$insert into public.company_offerings (company_id, name, keywords) values (tests.ref('alpha'), 'Long', array[repeat('a', 61)])$q$,
  'offering.keyword_too_long', 'keywords are length-limited');
select tests.throws($q$insert into public.company_offerings (company_id, name, keywords)
  select tests.ref('alpha'), 'Many', array_agg('kw' || g) from generate_series(1, 21) g$q$, '(offering.too_many_keywords|check)', 'and count-limited');
select tests.throws($q$insert into public.company_offerings (company_id, name) values (tests.ref('alpha'), '  graphic DESIGN ')$q$,
  'duplicate|unique', 'names are unique per company, ignoring case');

-- ---------------------------------------- permissions for the offering catalogue
select tests.login('mgr_a');
select tests.throws($q$insert into public.company_offerings (company_id, name) values (tests.ref('alpha'), 'Manager Made')$q$, 'row-level security', 'managers cannot edit the catalogue');
select tests.login('agent_a1');
select tests.ok(tests.count('select * from public.company_offerings') >= 6, 'employees can read their company''s catalogue');
select tests.throws($q$insert into public.company_offerings (company_id, name) values (tests.ref('alpha'), 'Agent Made')$q$, 'row-level security', 'agents cannot add offerings');
select tests.eq(tests.count($q$select * from public.company_offerings where company_id = tests.ref('beta')$q$), 0::bigint, 'agents cannot read another company''s catalogue');
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.company_offerings where company_id = tests.ref('alpha')$q$), 0::bigint, 'another company''s admin cannot read it either');
select tests.throws($q$insert into public.company_offerings (company_id, name) values (tests.ref('alpha'), 'Cross Company')$q$, 'row-level security', 'nor write to it');
update public.company_offerings set is_active = false where company_id = tests.ref('alpha');
select tests.logout();
select tests.eq(tests.count($q$select * from public.company_offerings where company_id = tests.ref('alpha') and not is_active$q$), 1::bigint, 'nor change it (only the already inactive one stays inactive)');
select tests.login('admin_b');
select tests.throws($q$delete from public.company_offerings where company_id = tests.ref('beta')$q$, 'permission denied', 'offerings are deactivated, never deleted');
select tests.logout();

-- ---------------------------------------- 10-11. qualify from the inbox
-- The customer's conversation is unowned: Agents cannot see the lead yet, managers and admins can.
select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv1')$q$), 0::bigint, 'an agent does not see the unassigned lead');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 0::bigint, 'nor through the inbox view');
select tests.login('mgr_a');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'a sales manager sees it');
select tests.login('admin_a');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'the company admin sees it');
select tests.login('super');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'the super admin sees it');
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 0::bigint, 'another company''s admin does not');

-- The agent claims the conversation: the automatic lead follows, and becomes visible and editable.
select tests.login('agent_a1');
update public.conversations set owner_id = auth.uid() where id = tests.ref('conv1');
select tests.eq((select owner_id from public.leads where conversation_id = tests.ref('conv1')), tests.uid('agent_a1'),
  'claiming the conversation assigns the automatic lead to the same employee');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id = tests.ref('conv1')$q$), 1::bigint, 'the assigned agent now sees the lead');
select tests.eq(tests.count($q$select * from public.lead_assignments where lead_id = (select id from public.leads where conversation_id = tests.ref('conv1'))$q$), 1::bigint,
  'the assignment is recorded in the lead history');

update public.leads set interest = 'interested' where conversation_id = tests.ref('conv1');
select tests.ok((select interest = 'interested' and status = 'new' from public.leads where conversation_id = tests.ref('conv1')),
  'changing interest does not change the lead status');
update public.leads set status = 'contacted' where conversation_id = tests.ref('conv1');
select tests.ok((select interest = 'interested' and status = 'contacted' from public.leads where conversation_id = tests.ref('conv1')),
  'changing the status does not overwrite the interest');
update public.leads set interest = 'follow_up_required' where conversation_id = tests.ref('conv1');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'lead.interest_changed' and actor_id = tests.uid('agent_a1')
                  and entity_id = (select id from public.leads where conversation_id = tests.ref('conv1'))), 2::bigint,
  'interest changes are audited with the employee who made them');
select tests.login('agent_a1');
select tests.throws($q$update public.leads set interest = 'very_interested' where conversation_id = tests.ref('conv1')$q$, 'invalid input value', 'only the four interest values exist');

update public.leads set offering_id = tests.ref('off_excel') where conversation_id = tests.ref('conv1');
select tests.ok((select offering_id = tests.ref('off_excel') and offering_source = 'employee' from public.leads where conversation_id = tests.ref('conv1')),
  'an employee''s offering is recorded with source "employee"');
select tests.throws($q$update public.leads set offering_id = tests.ref('off_beta') where conversation_id = tests.ref('conv1')$q$, 'leads_offering_fk|foreign key', 'another company''s offering is refused');
select tests.throws($q$update public.leads set offering_id = tests.ref('off_legacy') where conversation_id = tests.ref('conv1')$q$, 'lead.offering_inactive', 'an inactive offering cannot be selected');
update public.leads set offering_source = 'auto_keyword' where conversation_id = tests.ref('conv1');
select tests.eq((select offering_source from public.leads where conversation_id = tests.ref('conv1')), 'employee', 'the database ignores a client-supplied offering source');
select tests.logout();
select tests.ok((select count(*) = 1 from public.audit_logs where action = 'lead.offering_changed' and metadata ->> 'source' = 'employee'
                   and actor_id = tests.uid('agent_a1')), 'offering changes are audited');
select tests.login('agent_a1');
update public.leads set offering_id = null where conversation_id = tests.ref('conv1');
select tests.ok((select offering_id is null and offering_source is null from public.leads where conversation_id = tests.ref('conv1')), 'an offering can be cleared');

-- Another agent (read-only on the number) cannot touch it.
select tests.login('agent_a2');
update public.leads set interest = 'not_interested' where conversation_id = tests.ref('conv1');
select tests.logout();
select tests.eq((select interest::text from public.leads where conversation_id = tests.ref('conv1')), 'follow_up_required',
  'an agent who does not own the lead cannot change its interest');

-- --------------------------------------------- 24. ownership synchronisation
-- (assertions run as the table owner: after a reassignment the manager may no longer see the lead)
select tests.login('mgr_a');
update public.conversations set owner_id = tests.uid('agent_a2') where id = tests.ref('conv1');
select tests.logout();
select tests.eq((select owner_id from public.leads where conversation_id = tests.ref('conv1')), tests.uid('agent_a2'),
  'reassigning the conversation moves the automatic lead (it still had the conversation''s owner)');
-- An explicit lead assignment is never overwritten.
select tests.login('admin_a');
update public.leads set owner_id = tests.uid('mgr_a') where conversation_id = tests.ref('conv1');
select tests.login('mgr_a');
update public.conversations set owner_id = tests.uid('agent_a1') where id = tests.ref('conv1');
select tests.logout();
select tests.eq((select owner_id from public.conversations where id = tests.ref('conv1')), tests.uid('agent_a1'), 'the conversation did change hands');
select tests.eq((select owner_id from public.leads where conversation_id = tests.ref('conv1')), tests.uid('mgr_a'),
  'a manually assigned lead keeps its owner when the conversation changes hands');
-- Un-assigning a conversation releases a lead that still follows it, and only that one.
-- Manual leads and leads of other conversations are not synchronised.
select tests.logout();
insert into public.leads (company_id, contact_id, title, source, created_by, owner_id)
select tests.ref('alpha'), c.contact_id, 'Manual unlinked', 'phone', tests.uid('admin_a'), tests.uid('agent_a1')
from public.conversations c where c.customer_wa_id = '97455581003';
select tests.login('mgr_a');
update public.conversations set owner_id = tests.uid('agent_a2') where customer_wa_id = '97455581003';
select tests.eq((select owner_id from public.leads where title = 'Manual unlinked'), tests.uid('agent_a1'), 'a manual lead is never synchronised');
select tests.logout();

-- ------------------------------------------- 25. closed leads don't re-trigger
create or replace function pg_temp.msg(p_id text, p_wa text) returns void language plpgsql as $$
begin perform tests.service(); perform public.ingest_whatsapp_message('PNID_ALPHA', p_id, p_wa, 'Closer', 'text', 'ping', null, now()); perform tests.logout(); end $$;

select pg_temp.msg('wamid.C1', '97455582001');
insert into tests.refs select 'conv_c', conversation_id from public.messages m where wa_message_id = 'wamid.C1';
select tests.login('admin_a');
update public.leads set status = 'lost' where conversation_id = tests.ref('conv_c');
select tests.logout();
select pg_temp.msg('wamid.C2', '97455582001');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv_c')$q$), 1::bigint, 'a lost lead does not trigger another automatic lead for the conversation');

select pg_temp.msg('wamid.C3', '97455582002');
insert into tests.refs select 'conv_c2', conversation_id from public.messages where wa_message_id = 'wamid.C3';
select tests.login('admin_a');
update public.leads set status = 'unqualified' where conversation_id = tests.ref('conv_c2');
select tests.logout();
select pg_temp.msg('wamid.C4', '97455582002');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv_c2')$q$), 1::bigint, 'an unqualified lead does not either');

select pg_temp.msg('wamid.C5', '97455582003');
insert into tests.refs select 'conv_c3', conversation_id from public.messages where wa_message_id = 'wamid.C5';
select tests.login('admin_a');
select tests.lives($q$select public.convert_lead_to_deal((select id from public.leads where conversation_id = tests.ref('conv_c3')), 'Deal', 100)$q$, 'the lead is converted');
select tests.logout();
select pg_temp.msg('wamid.C6', '97455582003');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv_c3')$q$), 1::bigint, 'a converted lead does not either');

select pg_temp.msg('wamid.C7', '97455582004');
insert into tests.refs select 'conv_c4', conversation_id from public.messages where wa_message_id = 'wamid.C7';
select tests.login('admin_a');
update public.leads set archived_at = now() where conversation_id = tests.ref('conv_c4');
select tests.logout();
select pg_temp.msg('wamid.C8', '97455582004');
select tests.eq(tests.count($q$select * from public.leads where conversation_id = tests.ref('conv_c4')$q$), 1::bigint, 'nor does an archived lead');

-- ----------------------------- 14-15. two numbers, one company, one customer
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.T1', '97455583001', 'Two Lines', 'text', 'first line', null, now() - interval '2 minutes');
select * from public.ingest_whatsapp_message('PNID_ALPHA2', 'wamid.T2', '97455583001', 'Two Lines', 'text', 'second line', null, now() - interval '1 minute');
select tests.logout();
insert into tests.refs select 'line1', conversation_id from public.messages where wa_message_id = 'wamid.T1';
insert into tests.refs select 'line2', conversation_id from public.messages where wa_message_id = 'wamid.T2';
select tests.ok(tests.ref('line1') <> tests.ref('line2'), 'each number has its own conversation');
select tests.eq((select ca.contact_id = cb.contact_id from public.conversations ca, public.conversations cb
                  where ca.id = tests.ref('line1') and cb.id = tests.ref('line2')), true, 'both conversations share one contact');
select tests.eq((select ca.whatsapp_account_id = tests.ref('wa_alpha') and cb.whatsapp_account_id <> tests.ref('wa_alpha')
                  from public.conversations ca, public.conversations cb where ca.id = tests.ref('line1') and cb.id = tests.ref('line2')), true,
  'and map to their own WhatsApp numbers');
select tests.eq(tests.count($q$select * from public.leads l where l.contact_id = (select contact_id from public.conversations where id = tests.ref('line1')) and l.company_id = tests.ref('alpha')$q$),
  1::bigint, 'the same customer on two numbers of one company has one open lead');
select tests.login('admin_a');
select tests.eq((select count(distinct lead_id) from public.conversation_leads where conversation_id in (tests.ref('line1'), tests.ref('line2'))), 1::bigint,
  'both conversations show the same lead in the inbox');
select tests.eq((select linked from public.conversation_leads where conversation_id = tests.ref('line1')), true, 'the first conversation is linked');
select tests.eq((select linked from public.conversation_leads where conversation_id = tests.ref('line2')), false, 'the second one reuses it without being the lead''s origin');
select tests.logout();

-- ------------------------------- 16. another company: separate contact link, lead
select tests.service();
select * from public.ingest_whatsapp_message('PNID_BETA', 'wamid.B1X', '97455583001', 'Two Lines', 'text', 'hello beta', null, now());
select tests.logout();
insert into tests.refs select 'beta_conv', conversation_id from public.messages where wa_message_id = 'wamid.B1X';
select tests.eq((select l.company_id from public.leads l where l.conversation_id = tests.ref('beta_conv')), tests.ref('beta'), 'the same customer contacting Beta gets a lead in Beta');
select tests.eq(tests.count($q$select * from public.leads where company_id = tests.ref('alpha') and contact_id = (select contact_id from public.conversations where id = tests.ref('beta_conv'))$q$),
  1::bigint, 'and Alpha''s lead is untouched (one per company)');
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.leads where company_id = tests.ref('alpha')$q$), 0::bigint, 'Beta''s admin sees no Alpha lead');
select tests.eq(tests.count($q$select * from public.conversations where company_id = tests.ref('alpha')$q$), 0::bigint, 'nor Alpha conversation');
select tests.eq(tests.count($q$select * from public.conversation_leads where conversation_id in (select id from public.conversations where company_id = tests.ref('alpha'))$q$), 0::bigint, 'nor through the view');
select tests.ok(tests.count($q$select * from public.leads where company_id = tests.ref('beta') and auto_created$q$) >= 1, 'but sees Beta''s own automatic lead');
select tests.login('admin_a');
select tests.eq(tests.count($q$select * from public.leads where company_id = tests.ref('beta')$q$), 0::bigint, 'and Alpha''s admin sees no Beta lead');
select tests.logout();

-- ------------------------------------------- 17. the Owner sees everything of the company
create temp table expect as select
  (select count(*) from public.conversations where company_id = tests.ref('alpha')) as convs,
  (select count(*) from public.leads where company_id = tests.ref('alpha')) as leads;
grant select on expect to public;
select tests.login('admin_a');
select tests.eq((select count(*) from public.conversations where company_id = tests.ref('alpha')), (select convs from expect), 'the Owner sees all conversations of the company');
select tests.eq((select count(*) from public.leads where company_id = tests.ref('alpha')), (select leads from expect), 'and all its leads');
select tests.login('agent_a2');
select tests.ok((select count(*) from public.leads where company_id = tests.ref('alpha')) < (select leads from expect), 'while an agent sees only their own');
select tests.logout();

-- --------------------------------------------- simulated numbers and history
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA_SIM', 'wamid.SIM1', '97455584001', 'Demo', 'text', 'demo', null, now());
select tests.logout();
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455584001'$q$), 0::bigint,
  'simulated (demo) numbers never create leads');

-- Historical conversations: nothing was created for them; the next inbound message does it.
insert into public.contacts (full_name, phone_e164) values ('Historic One', '+97455585001'), ('Historic Two', '+97455585002');
insert into public.contact_companies (contact_id, company_id)
select id, tests.ref('alpha') from public.contacts where phone_e164 in ('+97455585001', '+97455585002');
insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id)
select tests.ref('wa_alpha'), tests.ref('alpha'), id, substr(phone_e164, 2) from public.contacts where phone_e164 in ('+97455585001', '+97455585002');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 in ('+97455585001', '+97455585002')$q$), 0::bigint,
  'conversations that existed before the feature have no lead (no backfill)');
insert into public.leads (company_id, contact_id, title, source, created_by)
select tests.ref('alpha'), id, 'Manual open lead', 'phone', tests.uid('admin_a') from public.contacts where phone_e164 = '+97455585002';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.H1', '97455585001', 'Historic One', 'text', 'new message', null, now());
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.H2', '97455585002', 'Historic Two', 'text', 'new message', null, now());
select tests.logout();
select tests.ok((select l.auto_created from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455585001'),
  'a returning customer without a lead gets an automatic one on the next inbound message');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455585002'$q$), 1::bigint,
  'an existing open manual lead is reused instead of creating another');
select tests.ok((select not l.auto_created and l.conversation_id is not null and l.created_by = tests.uid('admin_a')
                  from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455585002'),
  'the manual lead keeps its creator and is linked to the conversation');

-- ----------------------------------------- 22-23. creator rules, manual path
select tests.service();
select tests.throws($q$insert into public.leads (company_id, contact_id, title, source) select tests.ref('alpha'), id, 'No creator', 'phone' from public.contacts limit 1$q$,
  'lead.created_by_required', 'manual leads still require an authenticated creator (even for the service role)');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, source, auto_created)
  select tests.ref('alpha'), id, 'Auto but not WhatsApp', 'phone', true from public.contacts limit 1$q$, 'leads_auto_needs_conversation_chk', 'automatic leads must come from WhatsApp');
select tests.logout();
select tests.throws($q$insert into public.leads (company_id, contact_id, title, source, created_by) select tests.ref('alpha'), id, 'x', 'phone', null from public.contacts limit 1$q$,
  'created_by_required|leads_auto_creator_chk', 'the database refuses a null creator on a non-automatic lead');
select tests.login('agent_a1');
select tests.ok((select count(*) = 0 from public.leads where created_by is null and not auto_created), 'no manual lead without a creator exists');
insert into public.leads (company_id, contact_id, title, source, auto_created, created_by, conversation_id)
select tests.ref('alpha'), id, 'Forged automatic', 'whatsapp', true, null, null from public.contacts
where phone_e164 = '+97455580001';
select tests.ok((select not auto_created and created_by = tests.uid('agent_a1') from public.leads where title = 'Forged automatic'),
  'a user cannot create an automatic lead or a lead without a creator, whatever the request says');
select tests.throws($q$update public.leads set auto_created = true where title = 'Forged automatic'$q$, 'lead.immutable_field', 'auto_created cannot be changed afterwards');
select tests.throws($q$update public.leads set conversation_id = tests.ref('conv1') where title = 'Forged automatic'$q$, 'lead.immutable_field', 'the conversation link cannot be set by a user');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, source, conversation_id)
  select tests.ref('alpha'), id, 'Foreign link', 'whatsapp', tests.ref('beta_conv') from public.contacts where phone_e164 = '+97455580001'$q$,
  '(conversation_not_accessible|leads_conversation_fk|mismatch)', 'a lead cannot link to another company''s conversation');

-- Manual "lead from chat": atomic and idempotent, and it respects the automatic lead.
select tests.logout();
insert into public.contacts (full_name, phone_e164) values ('Manual Chat', '+97455585003') on conflict do nothing;
insert into public.contact_companies (contact_id, company_id) select id, tests.ref('alpha') from public.contacts where phone_e164 = '+97455585003' on conflict do nothing;
insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id)
select tests.ref('wa_alpha'), tests.ref('alpha'), id, '97455585003' from public.contacts where phone_e164 = '+97455585003' on conflict do nothing;
insert into tests.refs select 'conv_manual', id from public.conversations where customer_wa_id = '97455585003';
select tests.login('admin_a');
create temp table m1 as select * from public.lead_from_conversation(tests.ref('conv_manual'));
create temp table m2 as select * from public.lead_from_conversation(tests.ref('conv_manual'));
select tests.ok((select created from m1) and not (select created from m2) and (select lead_id from m1) = (select lead_id from m2), 'repeated "create lead" returns the same lead');
select tests.ok((select not auto_created and created_by = tests.uid('admin_a') and conversation_id = tests.ref('conv_manual') and source = 'whatsapp'
                  from public.leads where id = (select lead_id from m1)), 'the manual lead has its creator, source and conversation link');
create temp table m3 as select * from public.lead_from_conversation(tests.ref('conv1'));
select tests.eq((select created from m3), false, 'a conversation that already has a lead is not given a second one');
select tests.eq((select lead_id from m3), (select id from public.leads where conversation_id = tests.ref('conv1') and auto_created), 'and the existing lead is returned');
select tests.login('agent_b');
select tests.throws($q$select * from public.lead_from_conversation(tests.ref('conv_manual'))$q$, 'conversation.not_found', 'other companies cannot create leads from this conversation');
-- An agent who cannot see the (unassigned) automatic lead must not create a duplicate by clicking "create lead".
select tests.logout();
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.HID1', '97455587001', 'Hidden Lead', 'text', 'hello', null, now());
select tests.logout();
select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455587001'$q$), 0::bigint, 'the agent cannot see the unassigned lead');
select tests.throws($q$select * from public.lead_from_conversation((select id from public.conversations where customer_wa_id = '97455587001'))$q$,
  'lead.already_exists', 'but cannot create a duplicate of it either');
select tests.logout();
select tests.eq(tests.count($q$select * from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455587001'$q$), 1::bigint, 'still exactly one lead');
select tests.logout();

-- --------------------------------------------- unlinking when a chat moves company
select tests.login('super');
select tests.lives($q$select public.move_conversation_company(tests.ref('conv_c4'), tests.ref('beta'), 'customer belongs to Beta')$q$, 'a conversation can still be moved to another company');
select tests.ok((select l.conversation_id is null and l.company_id = tests.ref('alpha') from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455582004'),
  'its lead stays in the old company and is unlinked');
select tests.logout();

-- -------------------------------------------- 12-13. employee attribution kept
select tests.login('agent_a1');
create temp table o1 as select * from public.queue_outbound(tests.ref('conv1'), gen_random_uuid(), 'text', 'Thanks for contacting us');
grant select on o1 to public;
select tests.logout();
select tests.eq((select sent_by from public.messages where id = (select message_id from o1)), tests.uid('agent_a1'), 'an outgoing CRM message records the authenticated employee');
select tests.eq((select body from public.messages where id = (select message_id from o1)), 'Thanks for contacting us',
  'the stored (customer-visible) text is exactly what was typed: no employee name is added');
select tests.service();
select public.record_outbound_result((select message_id from o1), 'wamid.OUT1');
select public.apply_whatsapp_status('wamid.OUT1', 'delivered', null, null);
select public.apply_whatsapp_status('wamid.OUT1', 'read', null, null);
select tests.logout();
select tests.ok((select status = 'read' and sent_by = tests.uid('agent_a1') from public.messages where id = (select message_id from o1)),
  'delivery/read statuses still work and keep the sender attribution');

-- ----------------------------------------------- 18. retries recover cleanly
create function tests.fail_lead_insert() returns trigger language plpgsql as $$
begin raise exception 'lead.transient_failure'; end $$;
create trigger zz_transient_failure before insert on public.leads for each row execute function tests.fail_lead_insert();
select tests.service();
do $$
begin
  perform public.claim_webhook_event('msg:wamid.RETRY1', 'message', 'PNID_ALPHA', jsonb_build_object(
    'kind', 'message', 'eventKey', 'msg:wamid.RETRY1', 'phoneNumberId', 'PNID_ALPHA', 'waMessageId', 'wamid.RETRY1',
    'fromWaId', '97455586001', 'profileName', 'Retry Customer', 'messageType', 'text', 'body', 'hello', 'media', null, 'sentAt', now()));
  begin
    perform public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RETRY1', '97455586001', 'Retry Customer', 'text', 'hello', null, now());
  exception when others then
    perform public.finish_webhook_event('msg:wamid.RETRY1', 'failed', 'lead.transient_failure');
  end;
end $$;
select tests.logout();
select tests.ok(not exists (select 1 from public.contacts where phone_e164 = '+97455586001')
            and not exists (select 1 from public.conversations where customer_wa_id = '97455586001')
            and not exists (select 1 from public.messages where wa_message_id = 'wamid.RETRY1'),
  'a failure while creating the lead rolls the whole intake back: no contact, conversation or message is left half-written');
select tests.eq((select status from public.whatsapp_webhook_events where event_key = 'msg:wamid.RETRY1'), 'failed', 'the event is kept as failed for the retry job');
drop trigger zz_transient_failure on public.leads;
select tests.service();
select tests.eq(public.process_webhook_retries() ->> 'processed', '1', 'the retry job processes it once the database recovers');
select public.process_webhook_retries();
select tests.logout();
select tests.ok((select count(*) = 1 from public.contacts where phone_e164 = '+97455586001')
            and (select count(*) = 1 from public.conversations where customer_wa_id = '97455586001')
            and (select count(*) = 1 from public.messages where wa_message_id = 'wamid.RETRY1')
            and (select count(*) = 1 from public.leads l join public.contacts c on c.id = l.contact_id where c.phone_e164 = '+97455586001' and l.auto_created),
  'after the retry there is exactly one contact, conversation, message and automatic lead');

-- -------------------------------- reports never credit an employee for automatic leads
select tests.login('admin_a');
select tests.eq((select coalesce(sum(leads_created), 0)::bigint from public.report_employee_performance(tests.ref('alpha'), (now() at time zone 'Asia/Qatar')::date - 1, (now() at time zone 'Asia/Qatar')::date + 1)),
  (select count(*) from public.leads where company_id = tests.ref('alpha') and created_by is not null
     and created_at >= now() - interval '2 days'), 'employee performance counts only leads created by employees');
select tests.logout();

rollback;
