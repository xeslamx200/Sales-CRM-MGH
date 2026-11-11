-- Privilege escalation, administrative guards, audit immutability,
-- notification isolation.
begin;

-- ------------------------------------------------------- profile guards
select tests.login('agent_a1');
select tests.lives($q$update public.profiles set full_name = 'Renamed', locale = 'en' where id = auth.uid()$q$,
  'user can edit own name and locale');
select tests.throws($q$update public.profiles set is_super_admin = true where id = auth.uid()$q$,
  'profile.privileged_field', 'user cannot make themselves super admin');
select tests.throws($q$update public.profiles set is_active = false where id = auth.uid()$q$,
  'profile.privileged_field', 'user cannot change own active flag');
select tests.throws($q$update public.profiles set email = 'x@evil.test' where id = auth.uid()$q$,
  'profile.email_managed_by_auth', 'email is managed by Supabase Auth');
select tests.lives($q$update public.profiles set full_name = 'x' where id = tests.uid('agent_a2')$q$,
  'editing a colleague profile is silently filtered');
select tests.logout();
select tests.eq((select full_name from public.profiles where id = tests.uid('agent_a2')), 'Agent Alpha Two',
  'colleague profile unchanged');

select tests.login('super');
select tests.throws($q$update public.profiles set is_super_admin = false where id = auth.uid()$q$,
  'profile.cannot_change_own_access', 'super admin cannot demote themselves (lock-out protection)');
select tests.lives($q$update public.profiles set is_active = false where id = tests.uid('agent_a2')$q$,
  'super admin can deactivate a user');
select tests.ok((select deactivated_by = auth.uid() and deactivated_at is not null from public.profiles
  where id = tests.uid('agent_a2')), 'deactivation records who and when');
select tests.eq(tests.count($q$select * from public.audit_logs where action = 'user.deactivated'
  and entity_id = tests.uid('agent_a2')$q$), 1::bigint, 'deactivation is audited');

-- ------------------------------------------------- membership escalation
select tests.login('admin_a');
select tests.throws($q$insert into public.company_memberships (company_id, user_id, role)
  values (tests.ref('alpha'), tests.uid('outsider'), 'company_admin')$q$,
  'membership.cannot_manage_company_admin', 'company admin cannot create another company admin');
select tests.throws($q$update public.company_memberships set role = 'company_admin'
  where user_id = tests.uid('mgr_a') and company_id = tests.ref('alpha')$q$,
  'membership.cannot_manage_company_admin', 'company admin cannot promote to company admin');
select tests.throws($q$update public.company_memberships set role = 'sales_agent'
  where user_id = auth.uid() and company_id = tests.ref('alpha')$q$,
  'membership.cannot_edit_own', 'company admin cannot edit own membership');
select tests.throws($q$insert into public.company_memberships (company_id, user_id, role)
  values (tests.ref('beta'), tests.uid('outsider'), 'sales_agent')$q$,
  'row-level security', 'company admin cannot add members to another company');
select tests.lives($q$insert into public.company_memberships (company_id, user_id, role)
  values (tests.ref('alpha'), tests.uid('outsider'), 'sales_agent')$q$,
  'company admin can add a sales agent to own company');
select tests.lives($q$update public.company_memberships set role = 'cs_agent'
  where user_id = tests.uid('outsider') and company_id = tests.ref('alpha')$q$,
  'company admin can change a non-admin role');
select tests.eq(tests.count($q$select * from public.audit_logs where action in ('membership.created', 'membership.updated')
  and metadata ->> 'user_id' = tests.uid('outsider')::text$q$), 2::bigint, 'membership changes are audited');
select tests.throws($q$update public.companies set slug = 'renamed' where id = tests.ref('alpha')$q$,
  'company.super_admin_only_field', 'company admin cannot change slug');
select tests.lives($q$update public.companies set timezone = 'Asia/Riyadh' where id = tests.ref('alpha')$q$,
  'company admin can change company settings');
select tests.throws($q$insert into public.companies (name, slug) values ('New', 'new-co')$q$,
  'row-level security', 'company admin cannot create companies');

select tests.login('mgr_a');
select tests.throws($q$insert into public.company_memberships (company_id, user_id, role)
  values (tests.ref('alpha'), tests.uid('agent_b'), 'sales_agent')$q$,
  'row-level security', 'sales manager cannot manage memberships');
select tests.throws($q$insert into public.team_memberships (team_id, company_id, user_id)
  values (tests.ref('team_a1'), tests.ref('alpha'), tests.uid('outsider'))$q$,
  'row-level security', 'sales manager cannot pull colleagues into their own team');
select tests.lives($q$delete from public.team_memberships where team_id = tests.ref('team_a1') and user_id = tests.uid('agent_a1')$q$,
  'manager delete on team membership runs');
select tests.logout();
select tests.ok(exists (select 1 from public.team_memberships where team_id = tests.ref('team_a1') and user_id = tests.uid('agent_a1')),
  'sales manager cannot remove team members (filtered by RLS)');
select tests.login('admin_a');
select tests.lives($q$insert into public.team_memberships (team_id, company_id, user_id)
  values (tests.ref('team_a1'), tests.ref('alpha'), tests.uid('outsider'))$q$,
  'company admin manages team membership');
select tests.throws($q$insert into public.team_memberships (team_id, company_id, user_id)
  values (tests.ref('team_a1'), tests.ref('alpha'), tests.uid('agent_b'))$q$,
  'team.member_must_belong_to_company', 'team members must belong to the company');
select tests.eq(tests.count($q$select * from public.audit_logs where action = 'team.member_added'
  and metadata ->> 'user_id' = tests.uid('outsider')::text$q$), 1::bigint, 'team membership changes are audited');

-- Even if an admin is placed in a manager's team, the manager does not manage them.
select tests.logout();
insert into public.team_memberships (team_id, company_id, user_id) values (tests.ref('team_a1'), tests.ref('alpha'), tests.uid('admin_a'));
select tests.login('mgr_a');
select tests.ok(not app.manages_user(tests.ref('alpha'), tests.uid('admin_a')), 'a sales manager never manages a company admin');

-- ----------------------------------------------------- audit immutability
select tests.login('super');
select tests.lives('update public.audit_logs set action = $$tampered$$', 'super admin UPDATE on audit_logs is filtered by RLS');
select tests.logout();
select tests.ok(not exists (select 1 from public.audit_logs where action = 'tampered'), 'no audit row was changed');
-- Even the maintenance role (bypasses RLS) cannot change history.
select tests.throws('update public.audit_logs set action = $$tampered$$', 'audit.immutable',
  'audit rows cannot be updated even by the table owner');
select tests.throws('delete from public.audit_logs', 'audit.immutable', 'audit rows cannot be deleted');
select tests.throws('truncate public.audit_logs', 'audit.immutable', 'audit log cannot be truncated');
select tests.login('agent_a1');
select tests.eq(tests.count('select * from public.audit_logs'), 0::bigint, 'agents cannot read audit logs');
select tests.throws($q$insert into public.audit_logs (action, entity_type) values ('fake', 'x')$q$,
  'row-level security', 'users cannot forge audit rows');

-- ------------------------------------------------- notification isolation
select tests.logout();
insert into public.notifications (user_id, company_id, type, title)
values (tests.uid('agent_a1'), tests.ref('alpha'), 'test', 'for a1'),
       (tests.uid('agent_a2'), tests.ref('alpha'), 'test', 'for a2');
select tests.login('agent_a1');
select tests.eq((select array_agg(title) from public.notifications where type = 'test'), array['for a1'],
  'users see only their own notifications');
select tests.eq(public.mark_notifications_read(), 1, 'mark-all-read only touches own notifications');
select tests.throws($q$update public.notifications set title = 'x' where user_id = auth.uid()$q$,
  'notification.only_read_state_editable', 'notification content is not editable');
select tests.logout();
select tests.ok((select read_at is null from public.notifications where title = 'for a2'),
  'other user notification still unread');

-- ------------------------------------------- service-only functions are closed
select tests.login('admin_a');
select tests.throws($q$select * from public.ingest_whatsapp_message('PNID_ALPHA','w','97400000000','x','text','x',null,now())$q$,
  'permission denied', 'users cannot call the webhook ingestion function');
select tests.throws($q$select public.generate_task_reminders()$q$, 'permission denied', 'users cannot call the scheduler function');
select tests.throws($q$select app.write_audit(null, 'x', 'y', null, '{}')$q$, 'permission denied',
  'users cannot call the audit writer directly');
select tests.throws($q$select app.begin_system_op()$q$, 'permission denied', 'users cannot raise the system-op flag');
select tests.logout();
insert into public.whatsapp_webhook_events (event_key, event_kind, payload) values ('k1', 'message', '{}');
select tests.login('super');
select tests.eq(tests.count('select * from public.whatsapp_webhook_events'), 0::bigint,
  'raw webhook events are not readable even by super admin');

rollback;
