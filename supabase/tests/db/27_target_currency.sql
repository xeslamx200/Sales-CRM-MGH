-- Target currency (proposed migration 987; needs 981 + 983). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..987 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/27_target_currency.sql
begin;
select tests.logout();
select public.upsert_fx_rates('{"QAR": 14.1, "USD": 50}'::jsonb, 'test-source');

-- fixtures: a workshop, customers owned by the two sales employees ---------------------------------------------------------------------------
do $$
declare o uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'TC Workshop', 'workshop') returning id into o;
  insert into tests.refs values ('tco', o);
  for i in 1..12 loop
    insert into public.contacts (full_name, phone_e164) values ('TC ' || i, '+2010111' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('tc' || i, c);
  end loop;
end $$;
create or replace function pg_temp.pay(p_contact text, p_amount numeric, p_cur text, p_day date, p_confirm boolean default true) returns void language plpgsql as $$
begin
  perform tests.login('agent_a1');
  perform public.record_payment(tests.ref(p_contact), tests.ref('tco'), p_amount, p_cur, 'partial', p_day);
  if p_confirm then
    perform tests.login('admin_a');
    perform public.review_payment((select id from public.payments where contact_id = tests.ref(p_contact) and amount = p_amount and currency = p_cur and paid_on = p_day), 'confirmed');
  end if;
end $$;
create or replace function pg_temp.perf(p_month date) returns table (t numeric, a numeric, pend numeric, att numeric, rate numeric, comm numeric, cur text) language sql as $$
  select target_amount, achieved_amount, pending_amount, amount_attainment, r.rate, commission_egp, target_currency
  from public.report_monthly_commission(tests.ref('alpha'), p_month) r where r.user_id = tests.uid('agent_a1') $$;

-- setting the currency ---------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.set_target_default(tests.ref('alpha'), null, 10000);
select public.set_commission_tiers(tests.ref('alpha'), '[{"min":0.8,"rate":0.03},{"min":0.9,"rate":0.04},{"min":1,"rate":0.05}]');
select tests.eq((select public.company_target_currency(tests.ref('alpha'))), 'EGP', 'default: Egyptian pounds (nothing changes for a company that sets nothing)');
select tests.login('mgr_a');
select tests.throws($q$select public.set_company_target_currency(tests.ref('alpha'), 'QAR')$q$, 'auth.forbidden', 'a sales manager cannot set it');
select tests.login('agent_a1');
select tests.throws($q$select public.set_company_target_currency(tests.ref('alpha'), 'QAR')$q$, 'auth.forbidden', 'an agent cannot');
select tests.login('admin_b');
select tests.throws($q$select public.set_company_target_currency(tests.ref('alpha'), 'QAR')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.login('admin_a');
select tests.throws($q$select public.set_company_target_currency(tests.ref('alpha'), 'QR')$q$, 'target.invalid_value', 'a currency code has 3 letters');
select tests.throws($q$select public.set_company_target_currency(tests.ref('alpha'), 'XYZ')$q$, 'target.currency_unavailable', 'a currency without an exchange rate is refused (no rate is ever assumed)');

-- EGP behaviour first (month 2025-04): QAR 8000 at 14.1 = EGP 112800 against a target of 112800 -> 100 % in EGP ---------------------------------
select public.set_target_default(tests.ref('alpha'), null, 112800);
select pg_temp.pay('tc1', 8000, 'QAR', date '2025-04-10');
select tests.login('admin_a');
select tests.eq((select a || '/' || cur from pg_temp.perf(date '2025-04-01')), '112800.00/EGP', 'before the setting: the collected amount is in EGP (8000 QAR x 14.1)');
select tests.eq((select rate || '/' || comm from pg_temp.perf(date '2025-04-01')), '0.0500/5640.00', '100 % of an EGP target -> 5 % of the collected EGP');

-- switch the company to QAR: targets are now written in QAR ---------------------------------------------------------------------------------
select public.set_target_default(tests.ref('alpha'), null, 10000);
select public.set_company_target_currency(tests.ref('alpha'), 'qar');
select tests.eq((select public.company_target_currency(tests.ref('alpha'))), 'QAR', 'the company now keeps its targets in QAR');
select tests.eq((select a || '/' || t || '/' || cur from pg_temp.perf(date '2025-04-01')), '8000.00/10000.00/QAR', 'a payment in QAR counts at its own amount (8000), against a 10 000 QAR target');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-04-01')), '0.8000/0.0300/240.00', '80 % -> 3 %, commission = 3 % of the 8000 COLLECTED = 240 (not 3 % of the 10 000 target = 300)');

-- month 2025-05: mixed currencies: 8000 QAR + 14100 EGP (= 1000 QAR) + 100 USD (5000 EGP = 354.61 QAR) -------------------------------------
select pg_temp.pay('tc2', 8000, 'QAR', date '2025-05-05');
select pg_temp.pay('tc3', 14100, 'EGP', date '2025-05-06');
select pg_temp.pay('tc4', 100, 'USD', date '2025-05-07');
select tests.login('admin_a');
select tests.eq((select a from pg_temp.perf(date '2025-05-01')), 9354.61::numeric, 'mixed payments are converted into QAR: 8000 + 1000 + 354.61 = 9354.61');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-05-01')), '0.9354/0.0400/374.18', '93.54 % -> 4 %; commission 4 % x 9354.61 = 374.18 (NOT 4 % x the 10 000 target = 400)');

-- boundaries in QAR ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.pay('tc5', 7900, 'QAR', date '2025-06-05');
select pg_temp.pay('tc6', 8999, 'QAR', date '2025-07-05');
select pg_temp.pay('tc7', 9000, 'QAR', date '2025-08-05');
select pg_temp.pay('tc8', 10000, 'QAR', date '2025-09-05');
select tests.login('admin_a');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-06-01')), '0.7900/0/0.00', '79 % -> 0 %');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-07-01')), '0.8999/0.0300/269.97', '89.99 % -> 3 % of 8999');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-08-01')), '0.9000/0.0400/360.00', '90 % -> 4 % of 9000');
select tests.eq((select att || '/' || rate || '/' || comm from pg_temp.perf(date '2025-09-01')), '1.0000/0.0500/500.00', '100 % -> 5 % of 10000');

-- pending money is never collected, in any currency -------------------------------------------------------------------------------------------
select pg_temp.pay('tc9', 5000, 'QAR', date '2025-10-05', false);
select pg_temp.pay('tc10', 7000, 'QAR', date '2025-10-06');
select tests.login('admin_a');
select tests.eq((select a || '/' || pend || '/' || comm from pg_temp.perf(date '2025-10-01')), '7000.00/5000.00/0.00', 'pending 5000 QAR is shown apart and not counted; 7000 = 70 % -> no commission');

-- the dashboard target progress uses the same currency ---------------------------------------------------------------------------------------
select tests.login('mgr_a');
select public.set_monthly_target(tests.ref('alpha'), tests.uid('agent_a1'), date '2025-05-15', 10000, null);
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha'), date '2025-05-20') where user_id = tests.uid('agent_a1') and metric::text = 'collected_egp'), 9354.61::numeric,
  'report_target_progress shows the same collected amount in the target currency');

-- other companies are untouched ------------------------------------------------------------------------------------------------------------
select tests.login('admin_b');
select tests.eq((select public.company_target_currency(tests.ref('beta'))), 'EGP', 'Beta still uses EGP');
select tests.throws($q$select public.company_target_currency(tests.ref('alpha'))$q$, 'auth.forbidden', 'and cannot read Alpha''s setting');
select tests.eq((select count(*) from public.company_target_settings), 0::bigint, 'nor see its row');
select tests.login('agent_a1');
select tests.eq((select public.company_target_currency(tests.ref('alpha'))), 'QAR', 'a member of the company can read it (the UI needs it)');
select tests.throws($q$insert into public.company_target_settings (company_id, currency) values (tests.ref('alpha'), 'USD')$q$, 'permission denied', 'no direct write');

-- going back to EGP removes the row ----------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.set_company_target_currency(tests.ref('alpha'), 'EGP');
select tests.eq((select public.company_target_currency(tests.ref('alpha'))), 'EGP', 'back to EGP');
select tests.logout();
select tests.eq((select count(*) from public.audit_logs where action = 'target.currency_set'), 2::bigint, 'every change is audited');
rollback;
