-- Cross-company isolation and role scopes.
-- Brief §19 scenarios 1, 2, 3, 4 and 10.
begin;

-- ---------------------------------------------------------------- data setup
do $$
declare
  a uuid := tests.ref('alpha'); b uuid := tests.ref('beta'); c uuid := tests.ref('gamma');
  v uuid;
begin
  insert into public.leads (company_id, contact_id, title, owner_id, team_id, created_by)
  values (a, tests.ref('contact_shared'), 'A1 lead', tests.uid('agent_a1'), tests.ref('team_a1'), tests.uid('agent_a1'))
  returning id into v; insert into tests.refs values ('lead_a1', v);
  insert into public.leads (company_id, contact_id, title, owner_id, team_id, created_by)
  values (a, tests.ref('contact_shared'), 'A2 lead', tests.uid('agent_a2'), tests.ref('team_a2'), tests.uid('agent_a2'))
  returning id into v; insert into tests.refs values ('lead_a2', v);
  insert into public.leads (company_id, contact_id, title, owner_id, created_by)
  values (a, tests.ref('contact_shared'), 'A unassigned', null, tests.uid('admin_a'))
  returning id into v; insert into tests.refs values ('lead_a_unassigned', v);
  insert into public.leads (company_id, contact_id, title, owner_id, created_by)
  values (b, tests.ref('contact_shared'), 'B lead', tests.uid('agent_b'), tests.uid('agent_b'))
  returning id into v; insert into tests.refs values ('lead_b', v);
  insert into public.leads (company_id, contact_id, title, owner_id, created_by)
  values (c, tests.ref('contact_gamma'), 'C lead', null, tests.uid('super'))
  returning id into v; insert into tests.refs values ('lead_c', v);

  perform * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.A1', '97455550001', 'Shared Customer',
    'text', 'hello alpha', null, now() - interval '5 minutes');
  perform * from public.ingest_whatsapp_message('PNID_BETA', 'wamid.B1', '97455550001', 'Shared Customer',
    'text', 'hello beta', null, now() - interval '5 minutes');
end $$;

-- ------------------------------------------------- 10. unauthenticated users
select tests.login_anon();
select tests.throws('select * from public.leads', 'permission denied', 'anon cannot read leads');
select tests.throws('select * from public.contacts', 'permission denied', 'anon cannot read contacts');
select tests.throws('select * from public.messages', 'permission denied', 'anon cannot read messages');
select tests.throws('select * from public.companies', 'permission denied', 'anon cannot read companies');
select tests.throws($q$select public.find_or_create_contact('00000000-0000-0000-0000-000000000000', 'x')$q$,
  'permission denied', 'anon cannot call RPCs');

-- An authenticated account with no memberships sees nothing.
select tests.login('outsider');
select tests.eq(tests.count('select * from public.companies'), 0::bigint, 'outsider sees no companies');
select tests.eq(tests.count('select * from public.leads'), 0::bigint, 'outsider sees no leads');
select tests.eq(tests.count('select * from public.contacts'), 0::bigint, 'outsider sees no contacts');
select tests.eq(tests.count('select * from public.conversations'), 0::bigint, 'outsider sees no conversations');

-- A deactivated user loses all access even though the membership remains.
select tests.login('inactive');
select tests.eq(tests.count('select * from public.companies'), 0::bigint, 'deactivated user sees no companies');
select tests.eq(tests.count('select * from public.leads'), 0::bigint, 'deactivated user sees no leads');

-- ---------------------------------------------- 1. super admin sees all three
select tests.login('super');
select tests.eq(tests.count('select * from public.companies'), 3::bigint, 'super admin sees all 3 companies');
select tests.eq(tests.count('select * from public.leads'), 5::bigint, 'super admin sees leads in every company');
select tests.eq(tests.count('select * from public.conversations'), 2::bigint, 'super admin sees every conversation');
select tests.ok(tests.count('select * from public.audit_logs') > 0, 'super admin can read audit logs');

-- ------------------------------- 2. company admin limited to their company
select tests.login('admin_a');
select tests.eq((select array_agg(slug order by slug collate "C") from public.companies), array['alpha'], 'admin_a sees only Alpha');
select tests.eq(tests.count('select * from public.leads'), 3::bigint, 'admin_a sees all 3 Alpha leads');
select tests.eq(tests.count($q$select * from public.leads where company_id <> tests.ref('alpha')$q$), 0::bigint,
  'admin_a sees no Beta/Gamma leads');
select tests.eq(tests.count($q$select * from public.audit_logs where company_id <> tests.ref('alpha')$q$), 0::bigint,
  'admin_a sees no other company audit rows');
select tests.eq(tests.count('select * from public.conversations'), 1::bigint, 'admin_a sees only the Alpha conversation');
select tests.eq(tests.count($q$select * from public.contacts where id = tests.ref('contact_gamma')$q$), 0::bigint,
  'admin_a cannot see a Gamma-only contact');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, created_by)
  values (tests.ref('beta'), tests.ref('contact_shared'), 'sneaky', auth.uid())$q$,
  'row-level security', 'admin_a cannot create a lead in Beta');
select tests.lives($q$update public.leads set title = 'hacked' where id = tests.ref('lead_b')$q$,
  'update of Beta lead is silently filtered');
select tests.logout();
select tests.eq((select title from public.leads where id = tests.ref('lead_b')), 'B lead', 'Beta lead unchanged after admin_a update attempt');

-- ----------------------------------- 3. agents cannot see each other's leads
select tests.login('agent_a1');
select tests.eq((select array_agg(title order by title collate "C") from public.leads), array['A1 lead'], 'agent_a1 sees only own lead');
select tests.eq(tests.count($q$select * from public.leads where id = tests.ref('lead_a2')$q$), 0::bigint,
  'agent_a1 cannot read agent_a2 lead by id');
select tests.eq(tests.count($q$select * from public.lead_status_history where lead_id = tests.ref('lead_a2')$q$), 0::bigint,
  'agent_a1 cannot read history of agent_a2 lead');
select tests.throws($q$insert into public.activities (company_id, type, actor_id, lead_id, body)
  values (tests.ref('alpha'), 'note', auth.uid(), tests.ref('lead_a2'), 'peek')$q$,
  'activity.lead_not_accessible', 'agent_a1 cannot log activity on agent_a2 lead');
select tests.throws($q$insert into public.tasks (company_id, title, lead_id, created_by)
  values (tests.ref('alpha'), 'peek', tests.ref('lead_a2'), auth.uid())$q$,
  'task.lead_not_accessible', 'agent_a1 cannot attach a task to agent_a2 lead');

-- Sales manager: own team + unassigned, not the unmanaged team.
select tests.login('mgr_a');
select tests.eq((select array_agg(title order by title collate "C") from public.leads), array['A unassigned', 'A1 lead'],
  'mgr_a sees managed team lead + unassigned, not Team 2');

-- ------------------------- 4. shared contacts do not leak other companies' data
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.contacts where id = tests.ref('contact_shared')$q$), 1::bigint,
  'admin_b sees the shared contact identity');
select tests.eq((select array_agg(notes) from public.contact_companies where contact_id = tests.ref('contact_shared')),
  array['BETA-ONLY NOTE'], 'admin_b sees only Beta''s company-specific notes');
select tests.eq(tests.count($q$select * from public.leads where contact_id = tests.ref('contact_shared')$q$), 1::bigint,
  'admin_b sees only the Beta lead for the shared contact');
select tests.eq(tests.count($q$select m.* from public.messages m join public.conversations c on c.id = m.conversation_id
  where c.contact_id = tests.ref('contact_shared')$q$), 1::bigint,
  'admin_b sees only Beta WhatsApp messages for the shared contact');
select tests.eq((select body from public.messages), 'hello beta', 'the visible message is the Beta one');

-- Shared employee: role differs per company, data stays separated.
select tests.login('shared');
select tests.eq((select array_agg(slug order by slug collate "C") from public.companies), array['alpha', 'beta'], 'shared employee sees Alpha and Beta');
select tests.eq(app.company_role(tests.ref('alpha'))::text, 'sales_agent', 'shared employee is sales_agent in Alpha');
select tests.eq(app.company_role(tests.ref('beta'))::text, 'cs_agent', 'shared employee is cs_agent in Beta');
select tests.eq(tests.count('select * from public.leads'), 0::bigint, 'shared employee owns no leads, sees none');
select tests.eq(tests.count('select * from public.conversations'), 1::bigint,
  'shared employee sees the unassigned Beta conversation (has Beta number grant) but not Alpha''s');

rollback;
