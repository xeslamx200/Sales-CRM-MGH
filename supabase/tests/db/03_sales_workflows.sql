-- Lead, deal, task and contact workflows. Brief §19 scenario 5 (+ business rules).
begin;

-- ------------------------------------------- contacts: find-or-create & dups
select tests.login('agent_a1');
create temp table r as select * from public.find_or_create_contact(tests.ref('alpha'), 'Omar Haddad', '+97455551234', 'Omar@Example.com');
select tests.ok((select not matched_existing from r), 'new phone creates a new contact');
select tests.eq((select email from public.contacts where id = (select contact_id from r)), 'omar@example.com',
  'email is normalized to lower case');
select tests.eq((select owner_id from public.contact_companies where contact_id = (select contact_id from r)), auth.uid(),
  'agent becomes company-level owner of a contact they bring in');
insert into tests.refs select 'omar', contact_id from r;
drop table r;

select tests.login('agent_b');
create temp table r as select * from public.find_or_create_contact(tests.ref('beta'), 'O. Haddad (typo)', '+97455551234');
select tests.ok((select matched_existing from r), 'same E.164 phone links to the existing contact');
select tests.eq((select contact_id from r), tests.ref('omar'), 'no duplicate contact is created for the same phone');
select tests.eq((select full_name from public.contacts where id = tests.ref('omar')), 'Omar Haddad',
  'existing identity is not overwritten by another company');
drop table r;

select tests.login('agent_a1');
create temp table r as select * from public.find_or_create_contact(tests.ref('alpha'), 'omar haddad', null, null);
select tests.ok((select not matched_existing and possible_duplicates = 1 from r),
  'same name without phone is NOT merged automatically; it is queued for review');
select tests.eq(tests.count('select * from public.contact_duplicate_reviews where status = $$pending$$'), 1::bigint,
  'a pending duplicate review exists');
insert into tests.refs select 'omar_dup', contact_id from r;
drop table r;

-- The phone number is the cross-company identity key.
select tests.lives($q$update public.contacts set full_name = 'Omar K. Haddad' where id = tests.ref('omar')$q$,
  'agent can correct a contact name');
select tests.throws($q$update public.contacts set phone_e164 = '+97455550000' where id = tests.ref('omar')$q$,
  'contact.phone_change_requires_manager', 'agent cannot change a shared contact''s phone number');
select tests.login('admin_a');
select tests.throws($q$update public.contacts set phone_e164 = '+97455550000' where id = tests.ref('omar')$q$,
  'contact.phone_change_requires_manager', 'admin of only one linked company cannot change it either');
select tests.login('super');
select tests.lives($q$update public.contacts set phone_e164 = '+97455551235' where id = tests.ref('omar')$q$,
  'super admin can change it');
select tests.lives($q$update public.contacts set phone_e164 = '+97455551234' where id = tests.ref('omar')$q$, 'and change it back');
select tests.login('agent_a1');

-- ------------------------------------------------------------ lead creation
select tests.lives($q$insert into public.leads (company_id, contact_id, title, source, created_by, owner_id)
  values (tests.ref('alpha'), tests.ref('omar'), 'Office fit-out', 'whatsapp', auth.uid(), auth.uid())$q$,
  'agent creates a lead for a contact they can see');
select tests.logout();
insert into tests.refs select 'lead_omar', id from public.leads where title = 'Office fit-out';
select tests.login('agent_a1');
select tests.eq((select created_by from public.leads where id = tests.ref('lead_omar')), tests.uid('agent_a1'), 'creator recorded');
select tests.eq(tests.count($q$select * from public.lead_status_history where lead_id = tests.ref('lead_omar')$q$), 1::bigint,
  'initial status history row written');
select tests.eq(tests.count($q$select * from public.lead_assignments where lead_id = tests.ref('lead_omar')$q$), 1::bigint,
  'initial assignment history row written');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, created_by)
  values (tests.ref('alpha'), tests.ref('contact_gamma'), 'x', auth.uid())$q$,
  'lead.contact_not_accessible', 'cannot create a lead for a contact you cannot see (IDOR)');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, created_by, owner_id)
  values (tests.ref('alpha'), tests.ref('omar'), 'x', auth.uid(), tests.uid('agent_a2'))$q$,
  'lead.owner_change_forbidden', 'agent cannot assign a new lead to someone else');
select tests.lives($q$insert into public.leads (company_id, contact_id, title, created_by, owner_id)
  values (tests.ref('alpha'), tests.ref('omar'), 'forged-creator', tests.uid('agent_a2'), auth.uid())$q$,
  'insert with a forged created_by runs');
select tests.eq((select created_by from public.leads where title = 'forged-creator'), auth.uid(),
  'created_by cannot be forged: it is always the session user');
select tests.throws($q$insert into public.leads (company_id, contact_id, title, created_by, status)
  values (tests.ref('alpha'), tests.ref('omar'), 'x', auth.uid(), 'converted')$q$,
  'lead.convert_via_rpc_only', 'leads cannot be created as converted');

-- Status changes produce history; first contact time is system-maintained.
select tests.lives($q$update public.leads set status = 'contacted' where id = tests.ref('lead_omar')$q$, 'agent updates status');
select tests.ok((select first_contacted_at is not null from public.leads where id = tests.ref('lead_omar')),
  'first_contacted_at set on first move out of new');
select tests.eq(tests.count($q$select * from public.lead_status_history where lead_id = tests.ref('lead_omar')$q$), 2::bigint,
  'status change recorded in history');
select tests.throws($q$update public.leads set created_by = tests.uid('agent_a2') where id = tests.ref('lead_omar')$q$,
  'lead.immutable_field', 'creator cannot be changed');
select tests.throws($q$update public.leads set company_id = tests.ref('beta') where id = tests.ref('lead_omar')$q$,
  'lead.immutable_field|row-level security', 'lead cannot move to another company');
select tests.throws($q$update public.leads set owner_id = tests.uid('agent_a2') where id = tests.ref('lead_omar')$q$,
  'lead.owner_change_forbidden', 'agent cannot hand a lead to another agent');

-- --------------------------------------- 5. reassignment preserves creator
select tests.login('mgr_a');
select tests.lives($q$select public.assign_lead(tests.ref('lead_omar'), tests.uid('shared'), null, 'workload balance')$q$,
  'manager reassigns lead within their team');
select tests.logout();
select tests.eq((select created_by from public.leads where id = tests.ref('lead_omar')), tests.uid('agent_a1'),
  'creator is preserved after reassignment');
select tests.eq((select owner_id from public.leads where id = tests.ref('lead_omar')), tests.uid('shared'), 'owner changed');
select tests.ok(exists (select 1 from public.lead_assignments where lead_id = tests.ref('lead_omar')
  and from_user_id = tests.uid('agent_a1') and to_user_id = tests.uid('shared')
  and assigned_by = tests.uid('mgr_a') and reason = 'workload balance'), 'assignment history has from/to/by/reason');
select tests.eq(tests.count($q$select * from public.audit_logs where action = 'lead.reassigned' and entity_id = tests.ref('lead_omar')$q$),
  1::bigint, 'reassignment audited');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('shared') and type = 'lead_assigned'
  and entity_id = tests.ref('lead_omar')), 'new owner notified');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('agent_a1') and type = 'lead_reassigned'),
  'previous owner notified');

select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.leads where id = tests.ref('lead_omar')$q$), 0::bigint,
  'previous owner no longer sees the reassigned lead');

select tests.login('mgr_a');
select tests.throws($q$select public.assign_lead(tests.ref('lead_omar'), tests.uid('agent_a2'))$q$,
  'lead.owner_change_forbidden', 'manager cannot assign to someone outside their teams');
select tests.throws($q$select public.assign_lead(tests.ref('lead_omar'), tests.uid('agent_b'))$q$,
  'lead.owner_change_forbidden|owner_must_be_member', 'cannot assign to a member of another company');

-- ------------------------------------------------------- deals & pipeline
select tests.login('shared');
create temp table d as select public.convert_lead_to_deal(tests.ref('lead_omar'), null, 50000) as id;
insert into tests.refs select 'deal_omar', id from d;
select tests.eq((select status::text from public.leads where id = tests.ref('lead_omar')), 'converted', 'lead marked converted');
select tests.eq((select status::text from public.deals where id = tests.ref('deal_omar')), 'open', 'new deal is open');
select tests.eq((select currency from public.deals where id = tests.ref('deal_omar')), 'QAR', 'deal currency defaults to company currency');
select tests.throws($q$select public.convert_lead_to_deal(tests.ref('lead_omar'))$q$, 'lead.already_converted',
  'a lead cannot be converted twice');
select tests.lives($q$insert into public.leads (company_id, contact_id, title, created_by, owner_id)
  values (tests.ref('alpha'), tests.ref('omar'), 'L2', auth.uid(), auth.uid())$q$, 'create a second lead');
select tests.throws($q$update public.leads set status = 'converted' where title = 'L2'$q$,
  'lead.convert_via_rpc_only', 'status cannot be set to converted without a deal');

create temp table st as
  select s.id, s.name, s.stage_type from public.pipeline_stages s
  join public.deals dl on dl.pipeline_id = s.pipeline_id where dl.id = tests.ref('deal_omar');
-- Writing status directly is ignored: status is always derived from the stage.
update public.deals set status = 'won' where id = tests.ref('deal_omar');
select tests.eq((select status::text from public.deals where id = tests.ref('deal_omar')), 'open',
  'status cannot be set directly; it follows the stage');
select tests.throws($q$update public.deals set stage_id = (select id from st where stage_type = 'lost') where id = tests.ref('deal_omar')$q$,
  'deal.loss_reason_required', 'moving to a lost stage requires a loss reason');
select tests.lives($q$update public.deals set stage_id = (select id from st where name = 'تفاوض') where id = tests.ref('deal_omar')$q$,
  'move to negotiation');
select tests.eq((select probability from public.deals where id = tests.ref('deal_omar')), 70, 'probability follows the stage');
select tests.lives($q$update public.deals set stage_id = (select id from st where stage_type = 'won') where id = tests.ref('deal_omar')$q$,
  'mark deal won');
select tests.ok((select status = 'won' and won_at is not null and closed_by = auth.uid() from public.deals
  where id = tests.ref('deal_omar')), 'won deal has won_at and closed_by from the session');
select tests.throws($q$update public.deals set amount = 1 where id = tests.ref('deal_omar')$q$,
  'deal.won_amount_requires_manager', 'agent cannot change the amount of a won deal');
select tests.throws($q$update public.deals set stage_id = (select id from st where name = 'اكتشاف') where id = tests.ref('deal_omar')$q$,
  'deal.reopen_requires_manager', 'agent cannot reopen a won deal');
select tests.lives($q$update public.deals set won_at = now() - interval '300 days' where id = tests.ref('deal_omar')$q$,
  'backdating attempt runs');
select tests.ok((select won_at > now() - interval '1 minute' from public.deals where id = tests.ref('deal_omar')),
  'won_at cannot be backdated by a user');
select tests.logout();
select tests.eq((select array_agg(to_status::text order by created_at, to_status::text) from public.deal_stage_history
  where deal_id = tests.ref('deal_omar')), array['open', 'open', 'won'], 'stage history recorded each transition');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('mgr_a') and type = 'deal_won'),
  'team manager notified when a deal is won');

select tests.login('mgr_a');
select tests.lives($q$update public.deals set stage_id = (select id from st where name = 'تفاوض') where id = tests.ref('deal_omar')$q$,
  'manager can reopen a won deal');
select tests.ok((select status = 'open' and won_at is null and closed_by is null from public.deals where id = tests.ref('deal_omar')),
  'reopening clears outcome fields');

-- ------------------------------------------------------------------- tasks
select tests.login('agent_a1');
select tests.lives($q$insert into public.tasks (company_id, title, due_at, created_by)
  values (tests.ref('alpha'), 'Call back', now() + interval '1 day', auth.uid())$q$, 'agent creates own task');
select tests.logout();
insert into tests.refs select 'task1', id from public.tasks where title = 'Call back';
select tests.login('agent_a1');
select tests.eq((select assigned_to from public.tasks where id = tests.ref('task1')), auth.uid(), 'task defaults to creator');
select tests.throws($q$insert into public.tasks (company_id, title, created_by, status)
  values (tests.ref('alpha'), 'x', auth.uid(), 'completed')$q$, 'task.must_start_open', 'tasks cannot be created already completed');
select tests.throws($q$insert into public.tasks (company_id, title, created_by, assigned_to)
  values (tests.ref('alpha'), 'x', auth.uid(), tests.uid('agent_a2'))$q$, 'task.assign_forbidden',
  'agent cannot assign tasks to others');
select tests.lives($q$update public.tasks set status = 'completed', outcome = 'Reached customer',
  completed_at = now() - interval '9 days', completed_by = tests.uid('mgr_a') where id = tests.ref('task1')$q$, 'agent completes task');
select tests.ok((select completed_by = auth.uid() and completed_at > now() - interval '1 minute' from public.tasks
  where id = tests.ref('task1')), 'completion actor and time come from the session, not the client');
select tests.throws($q$update public.tasks set status = 'open' where id = tests.ref('task1')$q$,
  'task.completed_is_final', 'completed task cannot be reopened');
select tests.lives($q$update public.tasks set outcome = 'Reached customer; sent quote' where id = tests.ref('task1')$q$,
  'outcome notes can still be refined');
select tests.logout();
select tests.eq(tests.count($q$select * from public.audit_logs where action = 'task.completed' and entity_id = tests.ref('task1')$q$),
  1::bigint, 'task completion audited');

select tests.login('mgr_a');
select tests.lives($q$insert into public.tasks (company_id, title, created_by, assigned_to, due_at)
  values (tests.ref('alpha'), 'Team follow-up', auth.uid(), tests.uid('agent_a1'), now() - interval '2 hours')$q$,
  'manager assigns a task to a team member');
select tests.logout();
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('agent_a1') and type = 'task_assigned'),
  'assignee notified of new task');
select tests.service();
select tests.ok(public.generate_task_reminders() >= 1, 'scheduler finds overdue tasks');
select tests.lives('select public.generate_task_reminders()', 'scheduler can run again');
select tests.logout();
select tests.eq(tests.count($q$select * from public.notifications where user_id = tests.uid('agent_a1') and type = 'task_overdue'$q$),
  1::bigint, 'repeated scheduler runs do not duplicate reminders');

-- ------------------------------------------------------------- activities
select tests.login('agent_a1');
select tests.lives($q$insert into public.leads (company_id, contact_id, title, created_by, owner_id)
  values (tests.ref('alpha'), tests.ref('omar'), 'Second enquiry', auth.uid(), auth.uid())$q$, 'second lead');
select tests.lives($q$insert into public.activities (company_id, type, actor_id, lead_id, duration_seconds, outcome)
  select tests.ref('alpha'), 'call', tests.uid('mgr_a'), id, 120, 'interested' from public.leads where title = 'Second enquiry'$q$,
  'agent logs a call');
select tests.ok((select actor_id = auth.uid() from public.activities where outcome = 'interested'),
  'activity actor is forced to the session user');
select tests.ok((select last_activity_at is not null and first_contacted_at is not null from public.leads where title = 'Second enquiry'),
  'logging a call updates last activity and first contact time');
select tests.throws($q$insert into public.activities (company_id, type, actor_id, body, occurred_at)
  values (tests.ref('alpha'), 'note', auth.uid(), 'x', now() + interval '1 day')$q$, 'activity.occurred_in_future',
  'activities cannot be logged in the future');

-- --------------------------------------------------------- contact merge
select tests.login('agent_a1');
select tests.throws($q$select public.merge_contacts(tests.ref('omar'), tests.ref('omar_dup'))$q$, 'contact.merge_forbidden',
  'agents cannot merge contacts');
select tests.login('admin_a');
select tests.throws($q$select public.merge_contacts(tests.ref('omar'), tests.ref('omar_dup'))$q$, 'contact.merge_forbidden',
  'company admin cannot merge a contact that is also linked to another company');
select tests.login('super');
select tests.lives($q$select public.merge_contacts(tests.ref('omar'), tests.ref('omar_dup'))$q$, 'super admin merges after review');
select tests.logout();
select tests.eq((select merged_into_id from public.contacts where id = tests.ref('omar_dup')), tests.ref('omar'), 'duplicate points at survivor');
select tests.eq(tests.count('select * from public.contact_duplicate_reviews where status = $$merged$$'), 1::bigint, 'review resolved');

rollback;
