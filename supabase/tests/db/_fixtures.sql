-- Shared fixture: three companies, users with different roles, teams, and a
-- contact shared between Alpha and Beta. Runs in maintenance context.
create table if not exists tests.refs (key text primary key, id uuid not null);
grant select, insert on tests.refs to anon, authenticated, service_role;
create or replace function tests.ref(p_key text) returns uuid
language sql stable as $$ select id from tests.refs where key = p_key $$;
grant execute on function tests.ref(text) to anon, authenticated, service_role;

do $$
declare
  a uuid; b uuid; c uuid;
  t1 uuid; t2 uuid; tb uuid;
  v uuid;
begin
  perform tests.create_user('super', 'Super Admin');
  perform tests.create_user('admin_a', 'Admin Alpha');
  perform tests.create_user('admin_b', 'Admin Beta');
  perform tests.create_user('mgr_a', 'Manager Alpha');
  perform tests.create_user('agent_a1', 'Agent Alpha One');
  perform tests.create_user('agent_a2', 'Agent Alpha Two');
  perform tests.create_user('shared', 'Shared Employee');
  perform tests.create_user('cs_b', 'CS Beta');
  perform tests.create_user('agent_b', 'Agent Beta');
  perform tests.create_user('outsider', 'No Memberships');
  perform tests.create_user('inactive', 'Deactivated User');

  update public.profiles set is_super_admin = true where id = tests.uid('super');

  insert into public.companies (name, slug, timezone, currency) values ('Alpha', 'alpha', 'Asia/Qatar', 'QAR') returning id into a;
  insert into public.companies (name, slug, timezone, currency) values ('Beta', 'beta', 'Asia/Qatar', 'QAR') returning id into b;
  insert into public.companies (name, slug, timezone, currency) values ('Gamma', 'gamma', 'Africa/Cairo', 'EGP') returning id into c;
  insert into tests.refs values ('alpha', a), ('beta', b), ('gamma', c);

  insert into public.company_memberships (company_id, user_id, role) values
    (a, tests.uid('admin_a'), 'company_admin'),
    (b, tests.uid('admin_b'), 'company_admin'),
    (a, tests.uid('mgr_a'), 'sales_manager'),
    (a, tests.uid('agent_a1'), 'sales_agent'),
    (a, tests.uid('agent_a2'), 'sales_agent'),
    (a, tests.uid('shared'), 'sales_agent'),
    (b, tests.uid('shared'), 'cs_agent'),
    (b, tests.uid('cs_b'), 'cs_agent'),
    (b, tests.uid('agent_b'), 'sales_agent'),
    (a, tests.uid('inactive'), 'sales_agent');
  update public.profiles set is_active = false where id = tests.uid('inactive');

  insert into public.teams (company_id, name, manager_id) values (a, 'Alpha Team 1', tests.uid('mgr_a')) returning id into t1;
  insert into public.teams (company_id, name) values (a, 'Alpha Team 2') returning id into t2;
  insert into public.teams (company_id, name, manager_id) values (b, 'Beta Team', tests.uid('admin_b')) returning id into tb;
  insert into tests.refs values ('team_a1', t1), ('team_a2', t2), ('team_b', tb);
  insert into public.team_memberships (team_id, company_id, user_id) values
    (t1, a, tests.uid('agent_a1')), (t1, a, tests.uid('shared')),
    (t2, a, tests.uid('agent_a2')), (tb, b, tests.uid('agent_b'));

  -- A contact shared by Alpha and Beta, and one only in Gamma.
  insert into public.contacts (full_name, phone_e164) values ('Shared Customer', '+97455550001') returning id into v;
  insert into tests.refs values ('contact_shared', v);
  insert into public.contact_companies (contact_id, company_id, notes) values
    (v, a, 'ALPHA-ONLY NOTE'), (v, b, 'BETA-ONLY NOTE');
  insert into public.contacts (full_name, phone_e164) values ('Gamma Customer', '+201000000001') returning id into v;
  insert into tests.refs values ('contact_gamma', v);
  insert into public.contact_companies (contact_id, company_id) values (v, c);

  -- WhatsApp numbers: one for Alpha (test), one shared number defaulting to Beta.
  insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status)
  values (a, 'Alpha Sales', '+97440000001', 'PNID_ALPHA', 'test') returning id into v;
  insert into tests.refs values ('wa_alpha', v);
  insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply) values
    (v, tests.uid('agent_a1'), true), (v, tests.uid('mgr_a'), true), (v, tests.uid('agent_a2'), false);
  insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status)
  values (b, 'Beta Support', '+97440000002', 'PNID_BETA', 'test') returning id into v;
  insert into tests.refs values ('wa_beta', v);
  insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply) values
    (v, tests.uid('cs_b'), true), (v, tests.uid('shared'), true);
end $$;
