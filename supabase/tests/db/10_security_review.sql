-- Regression tests for the Session 3 security review (migration 0840).
begin;

-- ------------------------------------------------ 1. merge_contacts authorization
-- Contacts created directly through the Data API have no company link.
select tests.login('agent_a1');
insert into public.contacts (full_name, created_by) values ('Mine One', auth.uid()), ('Mine Two', auth.uid());
insert into tests.refs select 'mine1', id from public.contacts where full_name = 'Mine One';
insert into tests.refs select 'mine2', id from public.contacts where full_name = 'Mine Two';

select tests.login('agent_a2');
insert into public.contacts (full_name, created_by) values ('Theirs', auth.uid());
insert into tests.refs select 'theirs', id from public.contacts where full_name = 'Theirs';

-- A contact used by a lead in Alpha whose company link was removed.
select tests.logout();
insert into public.contacts (full_name) values ('Orphan With Lead') ;
insert into tests.refs select 'orphan', id from public.contacts where full_name = 'Orphan With Lead';
insert into public.leads (company_id, contact_id, title, owner_id, created_by)
values (tests.ref('alpha'), tests.ref('orphan'), 'Lead on orphan', tests.uid('agent_a1'), tests.uid('agent_a1'));

select tests.login('agent_a1');
select tests.throws($q$select public.merge_contacts(tests.ref('mine1'), tests.ref('theirs'))$q$, 'contact.not_found',
  'cannot merge a contact you cannot see (previously allowed: no links → vacuous check)');
select tests.throws($q$select public.merge_contacts(tests.ref('mine1'), tests.ref('orphan'))$q$, 'contact.merge_forbidden',
  'an agent cannot merge a contact used by company data they do not administer, even without links');
select tests.lives($q$select public.merge_contacts(tests.ref('mine1'), tests.ref('mine2'))$q$,
  'the creator may merge their own contacts that no company uses');

select tests.logout();
insert into public.contacts (full_name) values ('Alpha Linked');
insert into tests.refs select 'alpha_linked', id from public.contacts where full_name = 'Alpha Linked';
insert into public.contact_companies (contact_id, company_id) values (tests.ref('alpha_linked'), tests.ref('alpha'));
select tests.login('admin_a');
select tests.throws($q$select public.merge_contacts(tests.ref('orphan'), tests.ref('theirs'))$q$, 'contact.not_found',
  'admin cannot merge a contact invisible to them (another user''s unlinked contact)');
select tests.lives($q$select public.merge_contacts(tests.ref('orphan'), tests.ref('alpha_linked'))$q$,
  'company admin of every company touching both contacts may merge');
select tests.eq((select contact_id from public.leads where title = 'Lead on orphan'), tests.ref('orphan'), 'lead keeps the survivor');

select tests.login('admin_b');
select tests.throws($q$select public.merge_contacts(tests.ref('contact_shared'), tests.ref('mine1'))$q$, 'contact\.(merge_forbidden|not_found)',
  'admin of only one linked company cannot merge a shared contact');

-- ------------------------------------------------------------- 2. auth events
select tests.login('agent_a1');
select tests.throws($q$insert into public.auth_events (user_id, event) values (auth.uid(), 'sign_in')$q$, 'row-level security',
  'users cannot forge sign-in events through the API');
select tests.throws($q$insert into public.auth_events (user_id, event) values (auth.uid(), 'password_changed')$q$, 'row-level security',
  'users cannot forge password-change events');
select tests.throws($q$insert into public.auth_events (user_id, event) values (tests.uid('agent_a2'), 'sign_out')$q$, 'row-level security',
  'users cannot record events for someone else');
select tests.lives($q$insert into public.auth_events (user_id, event) values (auth.uid(), 'sign_out')$q$,
  'users can record their own sign-out');

select tests.logout();
insert into auth.sessions (user_id) values (tests.uid('agent_a1'));
select tests.eq((select count(*) from public.auth_events where user_id = tests.uid('agent_a1') and event = 'sign_in'), 1::bigint,
  'a new auth session records exactly one sign-in');
update auth.users set encrypted_password = 'hash-1' where id = tests.uid('agent_a1');
update auth.users set encrypted_password = 'hash-1' where id = tests.uid('agent_a1');
select tests.eq((select count(*) from public.auth_events where user_id = tests.uid('agent_a1') and event = 'password_changed'), 1::bigint,
  'a password change is recorded once (unchanged hash is not a change)');

-- ------------------------------------------------------ 3. target progress scope
select tests.logout();
insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, currency, amount, owner_id, created_by)
select tests.ref('alpha'), tests.ref('contact_shared'), p.id, s.id, 'Won by agent 2', 'QAR', 7000, tests.uid('agent_a2'), tests.uid('agent_a2')
from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
where p.company_id = tests.ref('alpha') and p.kind = 'deal' and p.is_default and s.stage_type = 'won' limit 1;
insert into public.sales_targets (company_id, metric, period_start, period_end, target_value, user_id, team_id) values
  (tests.ref('alpha'), 'won_revenue', current_date - 1, current_date + 30, 100000, null, null),
  (tests.ref('alpha'), 'won_revenue', current_date - 1, current_date + 30, 5000, tests.uid('agent_a1'), null),
  (tests.ref('alpha'), 'won_revenue', current_date - 1, current_date + 30, 20000, null, tests.ref('team_a1'));

select tests.login('agent_a1');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha')) where user_id is null and team_id is null),
  null::numeric, 'agent sees the company target but not the company''s revenue');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha')) where team_id = tests.ref('team_a1')),
  null::numeric, 'agent sees their team target but not teammates'' aggregate');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha')) where user_id = auth.uid()),
  0::numeric, 'agent sees the actual of their own target');

select tests.login('mgr_a');
select tests.ok((select actual_value is not null from public.report_target_progress(tests.ref('alpha')) where team_id = tests.ref('team_a1')),
  'the team''s manager sees the team actual');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha')) where user_id is null and team_id is null),
  null::numeric, 'a sales manager does not see company-wide actuals');

select tests.login('admin_a');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha')) where user_id is null and team_id is null),
  7000::numeric, 'company admin sees the company actual');

-- ----------------------------------------- 5. records of former employees (0850)
select tests.login('agent_a2');
insert into public.leads (company_id, contact_id, title, owner_id)
select tests.ref('alpha'), contact_id, 'Leaver lead', auth.uid()
from public.find_or_create_contact(tests.ref('alpha'), 'Leaver Customer', '+97455558888');
insert into public.tasks (company_id, title, lead_id)
select tests.ref('alpha'), 'Leaver task', id from public.leads where title = 'Leaver lead';
select tests.logout();
update public.profiles set is_active = false where id = tests.uid('agent_a2');   -- employee leaves

select tests.login('admin_a');
select tests.lives($q$update public.leads set status = 'contacted', notes = 'handover' where title = 'Leaver lead'$q$,
  'admin can still edit a lead owned by a deactivated employee');
select tests.lives($q$insert into public.activities (company_id, type, lead_id, actor_id)
  select company_id, 'call', id, auth.uid() from public.leads where title = 'Leaver lead'$q$,
  'logging an activity on that lead works (system update of last_activity_at)');
select tests.lives($q$update public.tasks set due_at = now() + interval '1 day' where title = 'Leaver task'$q$,
  'admin can still edit a task assigned to a deactivated employee');
select tests.throws($q$update public.leads set owner_id = tests.uid('inactive') where title = 'Leaver lead'$q$,
  'lead.owner_must_be_member', 'assigning to a deactivated user is still refused');
select tests.lives($q$select public.assign_lead((select id from public.leads where title = 'Leaver lead'), tests.uid('agent_a1'), null, 'handover')$q$,
  'reassigning to an active colleague works');

-- --------------------------------------- 6. read-only grant cannot claim (0860)
select tests.logout();
update public.profiles set is_active = true where id = tests.uid('agent_a2');   -- back from section 5
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RO1', '97455551212', 'Queue Customer', 'text', 'hello', null, now());
select tests.login('agent_a2');   -- grant on the Alpha number with can_reply = false
select tests.throws($q$select public.assign_conversation((select id from public.conversations where customer_wa_id = '97455551212'), auth.uid())$q$,
  'conversation.assign_forbidden', 'a read-only user cannot take a conversation out of the shared queue');
select tests.login('agent_a1');   -- can_reply = true
select tests.lives($q$select public.assign_conversation((select id from public.conversations where customer_wa_id = '97455551212'), auth.uid())$q$,
  'a user who can reply can claim it');

-- ------------------------------------------------------- 4. intake retention
select tests.service();
select public.claim_webhook_event('dead:1', 'message', 'PNID_ALPHA', '{"body":"customer text"}');
select public.finish_webhook_event('dead:1', 'failed', 'processing_error');
select tests.logout();
update public.whatsapp_webhook_events set received_at = now() - interval '40 days' where event_key = 'dead:1';
select tests.service();
select public.purge_old_webhook_events(30);
select tests.eq((select count(*) from public.whatsapp_webhook_events where event_key = 'dead:1'), 0::bigint,
  'failed intake rows (with customer content) are purged after the retention period');

rollback;
