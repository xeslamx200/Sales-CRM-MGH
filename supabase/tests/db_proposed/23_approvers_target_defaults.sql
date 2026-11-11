-- Payment approvers, default targets and exact-tier commission (proposed migration 983). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..983 + _helpers.sql + _fixtures.sql> -f supabase/tests/db_proposed/23_approvers_target_defaults.sql
begin;
select tests.logout();

-- fixtures: two more company admins in Alpha (adm2 will be an approver, adm3 will not), one payment per customer ------------------------------
do $$
declare o uuid; ob uuid; c uuid; i int;
begin
  perform tests.create_user('adm2', 'Approver Two');
  perform tests.create_user('adm3', 'Admin Not Listed');
  insert into public.company_memberships (company_id, user_id, role) values
    (tests.ref('alpha'), tests.uid('adm2'), 'company_admin'), (tests.ref('alpha'), tests.uid('adm3'), 'company_admin');
  insert into public.company_offerings (company_id, name, kind, price_egp) values (tests.ref('alpha'), 'Workshop A', 'course', 50000) returning id into o;
  insert into tests.refs values ('off_a', o);
  insert into public.company_offerings (company_id, name, kind, price_egp) values (tests.ref('beta'), 'Workshop B', 'course', 50000) returning id into ob;
  insert into tests.refs values ('off_b', ob);
  for i in 1..30 loop
    insert into public.contacts (full_name, phone_e164) values ('Payer ' || i, '+2010777' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('pc' || i, c);
  end loop;
  insert into public.contacts (full_name, phone_e164) values ('Beta Payer', '+2010888000001') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('beta'), tests.uid('agent_b'));
  insert into tests.refs values ('pcb', c);
end $$;

-- 1. unrestricted company: the migration-980 rule is untouched ----------------------------------------------------------------------------
select tests.login('agent_a1');
select public.record_payment(tests.ref('pc1'), tests.ref('off_a'), 100, 'EGP', 'partial', date '2026-02-01');
select tests.login('mgr_a');
select tests.eq(public.can_review_payments(tests.ref('alpha')), true, 'before any policy a sales manager may review (as before)');
select tests.lives($q$select public.review_payment((select id from public.payments where amount = 100), 'confirmed')$q$, 'legacy rule: a manager confirms');
select tests.eq((select count(*) from public.payment_approval_policy), 0::bigint, 'no company is restricted by the migration itself');

-- 2. setting approvers --------------------------------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a')])$q$, 'auth.forbidden', 'a sales manager cannot set approvers');
select tests.login('agent_a1');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a')])$q$, 'auth.forbidden', 'an agent cannot');
select tests.login('admin_b');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a')])$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[]::uuid[])$q$, 'approver.invalid_list', 'an empty list is refused (no accidental lock-out)');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('agent_a1')])$q$, 'approver.invalid_user', 'an agent cannot be an approver');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_b')])$q$, 'approver.invalid_user', 'a member of another company cannot');
select tests.throws($q$select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a'), tests.uid('inactive')])$q$, 'approver.invalid_user', 'an inactive user cannot');
select tests.eq((select count(*) from public.payment_approval_policy), 0::bigint, 'failed attempts changed nothing');
select tests.eq(public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a'), tests.uid('adm2'), tests.uid('admin_a')]), 2, 'two approvers (duplicates collapse)');
select tests.eq((select count(*) from public.payment_approvers where company_id = tests.ref('alpha')), 2::bigint, 'two rows stored');
select tests.throws($q$insert into public.payment_approvers (company_id, user_id) values (tests.ref('alpha'), tests.uid('adm3'))$q$, 'permission denied', 'no direct write to the approver list');
select tests.throws($q$insert into public.payment_approval_policy (company_id) values (tests.ref('beta'))$q$, 'permission denied', 'no direct write to the policy');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'payment.approvers_set'), 1::bigint, 'setting approvers is audited');

-- 3. enforcement in review_payment --------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select public.record_payment(tests.ref('pc2'), tests.ref('off_a'), 200, 'EGP', 'partial', date '2026-02-02');
select public.record_payment(tests.ref('pc3'), tests.ref('off_a'), 300, 'EGP', 'partial', date '2026-02-03');
select public.record_payment(tests.ref('pc4'), tests.ref('off_a'), 400, 'EGP', 'partial', date '2026-02-04');
select tests.login('mgr_a');
select tests.eq(public.can_review_payments(tests.ref('alpha')), false, 'the sales manager (team leader) can no longer review');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 200), 'confirmed')$q$, 'auth.forbidden', 'team leader: confirm refused by the database');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 200), 'rejected', 'no')$q$, 'auth.forbidden', 'team leader: reject refused too');
select tests.login('adm3');
select tests.eq(public.can_review_payments(tests.ref('alpha')), false, 'a company admin who is not listed cannot review');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 200), 'confirmed')$q$, 'auth.forbidden', 'unlisted company admin refused');
select tests.login('super');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 200), 'confirmed')$q$, 'auth.forbidden', 'even a super admin must be listed');
select tests.login('agent_a1');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 200), 'confirmed')$q$, 'auth.forbidden', 'the recorder cannot');
select tests.login('admin_a');
select tests.eq(public.can_review_payments(tests.ref('alpha')), true, 'listed approver 1');
select tests.lives($q$select public.review_payment((select id from public.payments where amount = 200), 'confirmed', 'ok')$q$, 'approver 1 confirms');
select tests.login('adm2');
select tests.eq(public.can_review_payments(tests.ref('alpha')), true, 'listed approver 2');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 300), 'rejected')$q$, 'payment.reason_required', 'a rejection still needs a reason');
select tests.lives($q$select public.review_payment((select id from public.payments where amount = 300), 'rejected', 'bad transfer')$q$, 'approver 2 rejects');
select tests.lives($q$select public.review_payment((select id from public.payments where amount = 200), 'rejected', 'reversed by the bank')$q$, 'a listed approver can reverse a confirmed payment (reason required)');
select tests.throws($q$select public.review_payment((select id from public.payments where amount = 300), 'confirmed')$q$, 'payment.invalid_transition', 'a rejected payment stays final');
select tests.login('mgr_a');
select tests.eq(public.can_review_payments(tests.ref('beta')), false, 'no access to another company: false');
select tests.login('admin_b');
select tests.eq(public.can_review_payments(tests.ref('alpha')), false, 'another company''s admin: false for Alpha');
select tests.eq(public.can_review_payments(tests.ref('beta')), true, 'other company unaffected: its admin still may review');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action in ('payment.confirmed', 'payment.rejected') and (metadata ->> 'restricted_policy')::boolean), 3::bigint,
  'confirmations and rejections under the policy are audited with the policy flag');
select tests.eq((select count(distinct actor_id) from public.audit_logs where action in ('payment.confirmed', 'payment.rejected') and (metadata ->> 'restricted_policy')::boolean), 2::bigint,
  'the audit shows who decided (two different approvers)');

-- other tenant: legacy flow still works for Beta -------------------------------------------------------------------------------------------
select tests.login('agent_b');
select public.record_payment(tests.ref('pcb'), tests.ref('off_b'), 500, 'EGP', 'partial', date '2026-02-05');
select tests.login('admin_b');
select tests.lives($q$select public.review_payment((select id from public.payments where amount = 500), 'confirmed')$q$, 'Beta (no policy): its admin confirms as before');

-- membership change: a deactivated approver loses the right immediately ---------------------------------------------------------------------
select tests.logout();
update public.company_memberships set is_active = false where company_id = tests.ref('alpha') and user_id = tests.uid('adm2');
select tests.login('adm2');
select tests.eq(public.can_review_payments(tests.ref('alpha')), false, 'a deactivated approver can no longer review');
select tests.logout();
update public.company_memberships set is_active = true where company_id = tests.ref('alpha') and user_id = tests.uid('adm2');

-- clearing the policy returns to the legacy rule -------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select tests.throws($q$select public.clear_payment_approval_policy(tests.ref('alpha'))$q$, 'auth.forbidden', 'a sales manager cannot clear the policy');
select tests.login('admin_a');
select public.clear_payment_approval_policy(tests.ref('alpha'));
select tests.login('mgr_a');
select tests.eq(public.can_review_payments(tests.ref('alpha')), true, 'cleared: managers review again');
select tests.login('admin_a');
select public.set_payment_approvers(tests.ref('alpha'), array[tests.uid('admin_a'), tests.uid('adm2')]);
select tests.login('mgr_a');
select tests.eq(public.can_review_payments(tests.ref('alpha')), false, 're-enabled');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'payment.approval_policy_cleared'), 1::bigint, 'clearing is audited');

-- 4. targets: defaults ---------------------------------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select tests.throws($q$select public.set_target_default(tests.ref('alpha'), null, 10000)$q$, 'auth.forbidden', 'a sales manager cannot set defaults');
select tests.login('admin_a');
select tests.throws($q$select public.set_target_default(tests.ref('alpha'), tests.uid('agent_b'), 10000)$q$, 'target.invalid_user', 'a non-member is refused');
select tests.throws($q$select public.set_target_default(tests.ref('alpha'), null, -5)$q$, 'target.invalid_value', 'negative refused');
select tests.throws($q$select public.set_target_default(tests.ref('alpha'), null, 10.123)$q$, 'target.invalid_value', 'more than 2 decimals refused');
select public.set_target_default(tests.ref('alpha'), null, 10000);
select public.set_target_default(tests.ref('alpha'), tests.uid('mgr_a'), 23000);
select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03},{"min":0.9,"rate":0.04},{"min":1,"rate":0.05}]');
select tests.eq((select count(*) from public.monthly_target_defaults where company_id = tests.ref('alpha')), 2::bigint, 'company default + one person');

-- one payment per month for the agent (target 10 000) and for the team leader (23 000); all confirmed by the approvers -------------------------
create or replace function pg_temp.pay(p_user text, p_contact text, p_amount numeric, p_day date, p_confirm boolean default true) returns void language plpgsql as $$
begin
  perform tests.login(p_user);
  perform public.record_payment(tests.ref(p_contact), tests.ref('off_a'), p_amount, 'EGP', 'partial', p_day);
  if p_confirm then
    perform tests.login('admin_a');
    perform public.review_payment((select id from public.payments where contact_id = tests.ref(p_contact) and amount = p_amount and paid_on = p_day and created_by = tests.uid(p_user)), 'confirmed');
  end if;
end $$;
create or replace function pg_temp.perf(p_user text, p_month date) returns table (t numeric, a numeric, att numeric, rate numeric, comm numeric, src text) language sql as $$
  select target_amount, achieved_amount, amount_attainment, r.rate, commission_egp, target_source
  from public.report_monthly_commission(tests.ref('alpha'), p_month) r where r.user_id = tests.uid(p_user) $$;

select pg_temp.pay('agent_a1', 'pc5',  7900,   date '2025-04-10');   -- 79 %
select pg_temp.pay('agent_a1', 'pc6',  8000,   date '2025-05-10');   -- 80 %
select pg_temp.pay('agent_a1', 'pc7',  8999,   date '2025-06-10');   -- 89.99 %
select pg_temp.pay('agent_a1', 'pc8',  8999.5, date '2025-07-10');   -- 89.995 % (must not round up to 90 %)
select pg_temp.pay('agent_a1', 'pc9',  9000,   date '2025-08-10');   -- 90 %
select pg_temp.pay('agent_a1', 'pc10', 9999,   date '2025-09-10');   -- 99.99 %
select pg_temp.pay('agent_a1', 'pc11', 10000,  date '2025-10-10');   -- 100 %
select pg_temp.pay('agent_a1', 'pc12', 12000,  date '2025-11-10');   -- 120 %
select tests.login('admin_a');
select tests.eq((select a from pg_temp.perf('agent_a1', date '2025-04-01')), 7900::numeric, 'April collected');
select tests.eq((select t || '/' || src from pg_temp.perf('agent_a1', date '2025-04-01')), '10000.00/company_default', 'the agent gets the company default target');
select tests.eq((select att from pg_temp.perf('agent_a1', date '2025-04-01')), 0.79::numeric, '79 %');
select tests.eq((select rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-04-01')), '0/0.00', '79 % -> 0 %, no commission');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-05-01')), '0.8000/0.0300/240.00', '80 % -> 3 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-06-01')), '0.8999/0.0300/269.97', '89.99 % -> 3 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-07-01')), '0.8999/0.0300/269.99', '89.995 % shows 89.99 % and still pays 3 % (no rounding up)');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-08-01')), '0.9000/0.0400/360.00', '90 % -> 4 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-09-01')), '0.9999/0.0400/399.96', '99.99 % -> 4 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-10-01')), '1.0000/0.0500/500.00', '100 % -> 5 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2025-11-01')), '1.2000/0.0500/600.00', '120 % -> 5 % of the whole amount');

-- the team leader: personal default 23 000 -----------------------------------------------------------------------------------------------------
select pg_temp.pay('mgr_a', 'pc13', 18400, date '2025-04-11');   -- 80 %
select pg_temp.pay('mgr_a', 'pc14', 22999, date '2025-05-11');   -- 99.9957 %
select pg_temp.pay('mgr_a', 'pc15', 23000, date '2025-06-11');   -- 100 %
select tests.login('admin_a');
select tests.eq((select t || '/' || src from pg_temp.perf('mgr_a', date '2025-04-01')), '23000.00/user_default', 'the team leader gets the personal default');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('mgr_a', date '2025-04-01')), '0.8000/0.0300/552.00', 'leader 80 % -> 3 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('mgr_a', date '2025-05-01')), '0.9999/0.0400/919.96', 'leader 99.99 % -> 4 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf('mgr_a', date '2025-06-01')), '1.0000/0.0500/1150.00', 'leader 100 % -> 5 %');

-- only confirmed money counts ---------------------------------------------------------------------------------------------------------------
select pg_temp.pay('agent_a1', 'pc16', 8000, date '2024-12-05');           -- confirmed
select pg_temp.pay('agent_a1', 'pc17', 10000, date '2024-12-06', false);   -- pending
select pg_temp.pay('agent_a1', 'pc18', 5000, date '2024-12-07', false);    -- will be rejected
select tests.login('adm2');
select public.review_payment((select id from public.payments where contact_id = tests.ref('pc18')), 'rejected', 'not received');
select tests.login('admin_a');
select tests.eq((select a || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2024-12-01')), '8000.00/0.0300/240.00', 'pending and rejected payments are not in the commission');
select tests.eq((select pending_amount from public.report_monthly_commission(tests.ref('alpha'), date '2024-12-01') where user_id = tests.uid('agent_a1')), 10000::numeric, 'pending is shown separately, never counted');

-- an explicit target for a month wins over the defaults; removing it falls back -----------------------------------------------------------------
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2024-11-15', 5000, null);
select pg_temp.pay('agent_a1', 'pc19', 5000, date '2024-11-20');
select tests.login('admin_a');
select tests.eq((select t || '/' || src || '/' || rate || '/' || comm from pg_temp.perf('agent_a1', date '2024-11-01')), '5000.00/month/0.0500/250.00', 'explicit monthly target overrides the default');
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2024-11-15', null, null);
select tests.eq((select t || '/' || src from pg_temp.perf('agent_a1', date '2024-11-01')), '10000.00/company_default', 'cleared: the default applies again');

-- performance exclusions (test accounts): left out of performance, nothing deleted ---------------------------------------------------------------
select tests.logout();
do $$ declare c uuid; begin
  insert into public.contacts (full_name, phone_e164) values ('Payer A2', '+201077799999') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a2'));
  insert into tests.refs values ('pca2', c);
end $$;
select pg_temp.pay('agent_a2', 'pca2', 3000, date '2025-04-12');
select tests.login('admin_a');
select tests.eq((select a || '/' || t from pg_temp.perf('agent_a2', date '2025-04-01')), '3000.00/10000.00', 'before: the second agent is in the performance report');
select tests.eq((select count(*) from public.report_employee_performance(tests.ref('alpha'), '2025-04-01', '2025-04-30') where user_id = tests.uid('agent_a2')), 1::bigint, 'and in the employees report');
select tests.login('mgr_a');
select tests.throws($q$select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), true, 'test')$q$, 'auth.forbidden', 'a sales manager cannot exclude');
select tests.login('admin_b');
select tests.throws($q$select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), true, 'test')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_b'), true, 'test')$q$, 'target.invalid_user', 'a non-member is refused');
select tests.throws($q$insert into public.performance_exclusions (company_id, user_id) values (tests.ref('alpha'), tests.uid('agent_a2'))$q$, 'permission denied', 'no direct write');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), true, 'test account');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2025-04-01') where user_id = tests.uid('agent_a2')), 0::bigint, 'excluded: no target, achievement, ranking or commission row');
select tests.eq((select count(*) from public.report_employee_performance(tests.ref('alpha'), '2025-04-01', '2025-04-30') where user_id = tests.uid('agent_a2')), 0::bigint, 'excluded from the employees report too');
select tests.eq((select count(*) from public.payments where created_by = tests.uid('agent_a2') and amount = 3000), 1::bigint, 'their payment is untouched and still visible to an admin');
select tests.eq((select status from public.payments where created_by = tests.uid('agent_a2') and amount = 3000), 'confirmed', 'its status is unchanged');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2025-04-01') where user_id = tests.uid('agent_a1')), 1::bigint, 'other employees are unaffected');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), false);
select tests.eq((select a || '/' || t from pg_temp.perf('agent_a2', date '2025-04-01')), '3000.00/10000.00', 'un-excluded: back with the same numbers (history intact)');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), true, 'test account');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'performance.exclusion_set'), 3::bigint, 'every change is audited');
select tests.login('admin_a');
select public.set_performance_exclusion(tests.ref('alpha'), tests.uid('agent_a2'), false);

-- who gets a default: sales agents only (not admins), everyone else needs a personal default ---------------------------------------------------
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2024-10-01') where user_id in (tests.uid('admin_a'), tests.uid('adm2'), tests.uid('adm3'))), 0::bigint, 'company admins are not listed with a target');
select public.set_target_default(tests.ref('alpha'), tests.uid('mgr_a'), null);
select tests.eq((select t is null from pg_temp.perf('mgr_a', date '2024-10-01')), true, 'a sales manager has no target without a personal default');
select public.set_target_default(tests.ref('alpha'), null, null);
select tests.eq((select t is null from pg_temp.perf('agent_a1', date '2024-10-01')), true, 'removing the company default leaves no target');

-- tenants and visibility ----------------------------------------------------------------------------------------------------------------------
select tests.login('admin_b');
select tests.throws($q$select * from public.report_monthly_commission(tests.ref('alpha'), date '2025-04-01')$q$, 'auth.forbidden', 'another company''s admin cannot read Alpha');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('beta'), date '2026-02-01') where target_amount is not null), 0::bigint, 'Beta has no targets: nothing was defaulted for it');
select tests.eq((select count(*) from public.monthly_target_defaults), 0::bigint, 'Beta cannot see Alpha''s defaults (and none exist for it)');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2025-04-01')), 1::bigint, 'an agent sees only their own row');
select tests.login_anon();
select tests.throws($q$select * from public.report_monthly_commission(tests.ref('alpha'), date '2025-04-01')$q$, 'permission denied', 'anonymous refused');

select tests.logout();
rollback;
