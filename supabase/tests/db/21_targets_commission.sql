-- Monthly targets and tiered commission (proposed migrations 980 + 981). Lives outside supabase/tests/db: run only on databases that have both.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..981 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/21_targets_commission.sql
begin;
select tests.logout();

-- fixtures ----------------------------------------------------------------------------------------------------------------------------
do $$
declare o uuid; c1 uuid; c2 uuid; c3 uuid;
begin
  insert into public.company_offerings (company_id, name, kind, price_egp) values (tests.ref('alpha'), 'Workshop T', 'course', 10000) returning id into o;
  insert into tests.refs values ('off_t', o);
  insert into public.contacts (full_name, phone_e164) values ('Payer One', '+201066600001') returning id into c1;
  insert into public.contacts (full_name, phone_e164) values ('Payer Two', '+201066600002') returning id into c2;
  insert into public.contacts (full_name, phone_e164) values ('Payer Three', '+201066600003') returning id into c3;
  insert into public.contact_companies (contact_id, company_id, owner_id) values
    (c1, tests.ref('alpha'), tests.uid('agent_a1')), (c2, tests.ref('alpha'), tests.uid('agent_a1')), (c3, tests.ref('alpha'), tests.uid('agent_a1'));
  insert into tests.refs values ('c1', c1), ('c2', c2), ('c3', c3);
end $$;

-- commission tiers --------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03}]')$q$, 'auth.forbidden', 'an agent cannot set tiers');
select tests.login('mgr_a');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03}]')$q$, 'auth.forbidden', 'a sales manager cannot set tiers (admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03}]')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.06},{"min":1,"rate":0.03}]')$q$, 'commission.invalid_tiers', 'a higher achievement can never pay a lower rate');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03},{"min":0.8,"rate":0.04}]')$q$, 'commission.invalid_tiers', 'duplicate thresholds refused');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":1,"rate":1.5}]')$q$, 'commission.invalid_tiers', 'a rate above 100% is refused');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":-1,"rate":0.1}]')$q$, 'commission.invalid_tiers', 'negative threshold refused');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '{"min":1}')$q$, 'commission.invalid_tiers', 'must be an array');
select tests.throws($q$select public.set_commission_tiers(tests.ref('alpha'), '[{"min":1}]')$q$, 'commission.invalid_tiers', 'a tier needs a rate');
select tests.eq((select public.set_commission_tiers(tests.ref('alpha'), '[{"min":1,"rate":0.06},{"min":0.8,"rate":0.03}]')), 2, 'an admin sets two tiers (order of input does not matter)');
select tests.eq((select count(*) from public.commission_tiers where company_id = tests.ref('alpha')), 2::bigint, 'two tiers stored');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.commission_tiers), 2::bigint, 'an employee can read the tiers of their company');
select tests.login('agent_b');
select tests.eq((select count(*) from public.commission_tiers), 0::bigint, 'another company cannot');
select tests.throws($q$insert into public.commission_tiers (company_id, min_attainment, rate) values (tests.ref('alpha'), 2, 0.5)$q$, 'permission denied', 'no direct write');

-- monthly targets ---------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-15', 10000, 2)$q$, 'auth.forbidden', 'an agent cannot set targets, not even their own');
select tests.login('mgr_a');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_b'), date '2026-03-15', 10000, 2)$q$, 'auth.forbidden', 'a manager cannot set targets for someone outside the company');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a2'), date '2026-03-15', 10000, 2)$q$, 'auth.forbidden', 'a team manager cannot set targets for an employee of another team');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-15', -1, 2)$q$, 'target.invalid_value', 'negative amount refused');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-15', 100.123, 2)$q$, 'target.invalid_value', 'more than 2 decimals refused');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-15', 100, 1.5)$q$, 'target.invalid_value', 'a customer count is a whole number');
select tests.login('admin_a');
select tests.throws($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_b'), date '2026-03-15', 10000, 2)$q$, 'target.invalid_user', 'an admin still needs the employee to be a member');
select tests.lives($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a2'), date '2026-03-15', 500, 1)$q$, 'a company admin sets targets for any employee');
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a2'), date '2026-03-15', null, null);
select tests.login('mgr_a');
select tests.lives($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-15', 10000, 2)$q$, 'a team manager sets their employee''s targets (any day of the month)');
select tests.eq((select string_agg(metric::text || ':' || target_value::text || ':' || period_start::text || ':' || period_end::text, ',' order by metric::text)
  from public.sales_targets where user_id = tests.uid('agent_a1') and metric::text in ('collected_egp', 'paid_customers')),
  'collected_egp:10000.00:2026-03-01:2026-03-31,paid_customers:2.00:2026-03-01:2026-03-31', 'two targets covering the whole calendar month');
select tests.lives($q$select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-02', 12000, 2)$q$, 'setting again replaces (no duplicate)');
select tests.eq((select count(*) from public.sales_targets where user_id = tests.uid('agent_a1') and metric::text in ('collected_egp', 'paid_customers')), 2::bigint, 'still two rows');
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-02', 10000, 2);

-- payments of agent_a1 in March 2026 ----------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select public.record_payment(tests.ref('c1'), tests.ref('off_t'), 5000, 'EGP', 'partial', date '2026-03-10');
select public.record_payment(tests.ref('c2'), tests.ref('off_t'), 2000, 'EGP', 'partial', date '2026-03-31');
select public.record_payment(tests.ref('c1'), tests.ref('off_t'), 1000, 'EGP', 'partial', date '2026-03-20');
select public.record_payment(tests.ref('c3'), tests.ref('off_t'), 2000, 'EGP', 'partial', date '2026-03-25');
select public.record_payment(tests.ref('c3'), tests.ref('off_t'), 777, 'EGP', 'partial', date '2026-04-01');
create or replace function pg_temp.confirm(p_amount numeric, p_day date) returns void language plpgsql as $$
begin
  perform tests.login('mgr_a');
  perform public.review_payment((select id from public.payments where amount = p_amount and paid_on = p_day and created_by = tests.uid('agent_a1')), 'confirmed');
end $$;
create or replace function pg_temp.perf(p_user text, p_month date default date '2026-03-01') returns table (a numeric, p numeric, att numeric, rate numeric, comm numeric, cus bigint, cus_att numeric) language sql as $$
  select achieved_amount, pending_amount, amount_attainment, r.rate, commission_egp, achieved_customers, customers_attainment
  from public.report_monthly_commission(tests.ref('alpha'), p_month) r where r.user_id = tests.uid(p_user) $$;

-- nothing confirmed yet: everything is pending, no commission
select tests.login('mgr_a');
select tests.eq((select a from pg_temp.perf('agent_a1')), 0::numeric, 'before any confirmation nothing is achieved');
select tests.eq((select p from pg_temp.perf('agent_a1')), 10000::numeric, 'March payments waiting for review (5000+2000+1000+2000; April excluded)');
select tests.eq((select comm from pg_temp.perf('agent_a1')), 0::numeric, 'no commission before confirmation');

select pg_temp.confirm(5000, date '2026-03-10');
select pg_temp.confirm(2000, date '2026-03-31');
select tests.login('mgr_a');
select tests.eq((select a from pg_temp.perf('agent_a1')), 7000::numeric, 'confirmed: 5000 + 2000 (a payment on the last day of the month counts)');
select tests.eq((select att from pg_temp.perf('agent_a1')), 0.7::numeric, 'attainment 70%');
select tests.eq((select rate from pg_temp.perf('agent_a1')), 0::numeric, 'below the first tier: rate 0');
select tests.eq((select comm from pg_temp.perf('agent_a1')), 0::numeric, 'below the first tier: no commission');
select tests.eq((select cus from pg_temp.perf('agent_a1')), 2::bigint, 'two distinct paying customers');
select tests.eq((select cus_att from pg_temp.perf('agent_a1')), 1::numeric, 'customers target 2/2');

select pg_temp.confirm(1000, date '2026-03-20');
select tests.login('mgr_a');
select tests.eq((select att from pg_temp.perf('agent_a1')), 0.8::numeric, 'attainment 80%');
select tests.eq((select rate from pg_temp.perf('agent_a1')), 0.03::numeric, 'first tier reached exactly at its threshold: 3%');
select tests.eq((select comm from pg_temp.perf('agent_a1')), 240.00::numeric, 'commission = 8000 x 3% (the rate applies to the whole confirmed amount)');
select tests.eq((select cus from pg_temp.perf('agent_a1')), 2::bigint, 'the same customer paying twice counts once');

select pg_temp.confirm(2000, date '2026-03-25');
select tests.login('mgr_a');
select tests.eq((select a from pg_temp.perf('agent_a1')), 10000::numeric, 'confirmed 10000');
select tests.eq((select rate from pg_temp.perf('agent_a1')), 0.06::numeric, 'top tier reached: 6%');
select tests.eq((select comm from pg_temp.perf('agent_a1')), 600.00::numeric, 'commission = 10000 x 6%');
select tests.eq((select cus from pg_temp.perf('agent_a1')), 3::bigint, 'three distinct customers');
select tests.eq((select cus_att from pg_temp.perf('agent_a1')), 1.5::numeric, 'customers target exceeded: 150%');

-- other months, other people ----------------------------------------------------------------------------------------------------------
select tests.eq((select a from pg_temp.perf('agent_a1', date '2026-04-20')), 0::numeric, 'April: the 777 payment is pending, nothing confirmed (the month is taken from any day)');
select tests.eq((select p from pg_temp.perf('agent_a1', date '2026-04-20')), 777::numeric, 'April: the payment dated 2026-04-01 belongs to April');
select tests.eq((select a from pg_temp.perf('agent_a1', date '2026-02-01')), 0::numeric, 'February: nothing');
select tests.login('admin_a');
select tests.eq((select att from pg_temp.perf('agent_a2')), null::numeric, 'no target set: attainment is empty, never 0%');
select tests.eq((select comm from pg_temp.perf('agent_a2')), 0::numeric, 'no target set: no commission');
select tests.login('mgr_a');
select tests.ok((select bool_and(user_id <> tests.uid('agent_a2')) from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')), 'a team manager does not see an employee of another team');
select tests.ok((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01') where user_id in (tests.uid('agent_a1'), tests.uid('mgr_a'))) = 2, 'a team manager sees their team and themselves');
select tests.login('admin_a');
select tests.ok((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')) >= 4, 'a company admin sees every employee of the company');
select tests.login('mgr_a');

-- visibility --------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')), 1::bigint, 'an employee sees only their own row');
select tests.eq((select commission_egp from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')), 600.00::numeric, '...with their own commission');
select tests.login('agent_a2');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')), 1::bigint, 'another employee sees only their own row');
select tests.eq((select user_id from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')), tests.uid('agent_a2'), '...and it is theirs');
select tests.login('agent_b');
select tests.throws($q$select * from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')$q$, 'auth.forbidden', 'another company cannot read it');
select tests.login('outsider');
select tests.throws($q$select * from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01')$q$, 'auth.forbidden', 'a user without memberships cannot');

-- reversal and the existing target screens ----------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.review_payment((select id from public.payments where amount = 2000 and paid_on = date '2026-03-25'), 'rejected', 'bank reversed it');
select tests.eq((select commission_egp from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01') where user_id = tests.uid('agent_a1')), 240.00::numeric,
  'a payment rejected later drops out: back to 8000 x 3%');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha'), date '2026-03-15') where metric::text = 'collected_egp' and user_id = tests.uid('agent_a1')), 8000.00::numeric,
  'report_target_progress computes the new amount metric');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha'), date '2026-03-15') where metric::text = 'paid_customers' and user_id = tests.uid('agent_a1')), 2::numeric,
  'report_target_progress computes the new customers metric');

-- clearing a target -------------------------------------------------------------------------------------------------------------------
select tests.login('mgr_a');
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2026-03-01', null, 0);
select tests.eq((select count(*) from public.sales_targets where user_id = tests.uid('agent_a1') and metric::text in ('collected_egp', 'paid_customers')), 0::bigint, 'NULL / 0 clears the targets');
select tests.eq((select amount_attainment from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01') where user_id = tests.uid('agent_a1')), null::numeric, 'no target: no attainment, no commission');
select tests.eq((select commission_egp from public.report_monthly_commission(tests.ref('alpha'), date '2026-03-01') where user_id = tests.uid('agent_a1')), 0::numeric, 'no target: commission 0 again');

-- sandbox companies report nothing ------------------------------------------------------------------------------------------------------
select tests.logout();
do $$ declare s uuid; begin
  insert into public.companies (name, slug, is_sandbox) values ('Sandbox Co', 'sbx-co', true) returning id into s;
  insert into tests.refs values ('sandbox_co', s);
  insert into public.company_memberships (company_id, user_id, role) values (s, tests.uid('admin_a'), 'company_admin');
end $$;
select tests.login('admin_a');
select tests.eq((select count(*) from public.report_monthly_commission(tests.ref('sandbox_co'), date '2026-03-01')), 0::bigint, 'a sandbox company is excluded from the report (same rule as every report)');

-- audit -------------------------------------------------------------------------------------------------------------------------------------
select tests.logout();
select tests.ok((select count(*) from public.audit_logs where action = 'commission.tiers_set') = 1, 'tier changes are audited');
select tests.ok((select count(*) from public.audit_logs where action = 'target.monthly_set') >= 3, 'target changes are audited');

rollback;
