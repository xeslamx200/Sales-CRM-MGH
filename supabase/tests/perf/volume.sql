-- Volume check (NOT part of the regular suite): ~50k leads, then time the
-- hot paths as different roles. Everything runs in one transaction that is
-- rolled back. Run after ./scripts/db/test.sh (needs helpers + fixtures):
--   psql -d crm_test -f supabase/tests/perf/volume.sql
\set ON_ERROR_STOP on
\timing off
begin;
select tests.logout();
set local app.actor_id = '';

-- ------------------------------------------------------------------ data
create temp table agents as
  select unnest(array[tests.uid('agent_a1'), tests.uid('agent_a2'), tests.uid('shared'), tests.uid('mgr_a')]) as id;

insert into public.contacts (full_name, phone_e164, email)
select 'Volume Person ' || g, '+9745' || lpad(g::text, 7, '0'), case when g % 3 = 0 then 'v' || g || '@example.test' end
from generate_series(1, 50000) g;

insert into public.contact_companies (contact_id, company_id, created_by)
select c.id, case when n % 5 = 0 then tests.ref('beta') else tests.ref('alpha') end, tests.uid('admin_a')
from (select id, row_number() over () as n from public.contacts where full_name like 'Volume Person %') c;

insert into public.leads (company_id, contact_id, title, source, status, priority, owner_id, created_by, created_at, next_follow_up_at)
select cc.company_id, cc.contact_id, 'Volume lead ' || n,
  (array['website','phone','referral','whatsapp']::public.lead_source[])[1 + n % 4],
  (array['new','contacted','qualified','unqualified','lost']::public.lead_status[])[1 + n % 5],
  'medium',
  case when cc.company_id = tests.ref('alpha') and n % 7 <> 0 then (select id from agents offset (n % 4) limit 1) end,
  tests.uid('admin_a'),
  now() - make_interval(days => (n % 365)::int),
  case when n % 3 = 0 then now() + make_interval(days => ((n % 20) - 10)::int) end
from (select contact_id, company_id, row_number() over () as n from public.contact_companies cc
      join public.contacts c on c.id = cc.contact_id where c.full_name like 'Volume Person %') cc;

-- Fresh statistics before the trigger-heavy inserts: cached trigger plans
-- (e.g. the task guard's lead lookup) must not be planned for empty tables.
analyze public.contacts, public.contact_companies, public.leads;

insert into public.activities (company_id, type, actor_id, lead_id, occurred_at)
select l.company_id, (array['call','meeting','note']::public.activity_type[])[1 + n % 3],
  coalesce(l.owner_id, tests.uid('admin_a')), l.id, least(l.created_at + interval '1 hour', now())
from (select *, row_number() over () as n from public.leads where title like 'Volume lead %') l, generate_series(1, 2);

insert into public.tasks (company_id, title, lead_id, assigned_to, created_by, due_at, status, completed_at, completed_by)
select l.company_id, 'Volume task', l.id, l.owner_id, tests.uid('admin_a'), l.created_at + interval '2 days',
  case when n % 2 = 0 then 'completed'::public.task_status else 'open' end,
  case when n % 2 = 0 then least(l.created_at + interval '1 day', now()) end,
  case when n % 2 = 0 then coalesce(l.owner_id, tests.uid('admin_a')) end
from (select *, row_number() over () as n from public.leads where title like 'Volume lead %') l;

analyze;
select count(*) as leads, (select count(*) from public.activities) as activities, (select count(*) from public.tasks) as tasks
from public.leads;

-- ------------------------------------------------------------ timings
create or replace function pg_temp.time_it(p_label text, p_sql text) returns void language plpgsql as $$
declare t0 timestamptz; n bigint;
begin
  t0 := clock_timestamp();
  execute 'select count(*) from (' || p_sql || ') q' into n;
  raise notice '%: % rows in % ms', rpad(p_label, 52), n, round(extract(epoch from clock_timestamp() - t0) * 1000);
end $$;

\echo '--- agent_a1'
select tests.login('agent_a1');
select pg_temp.time_it('leads list page (25, newest)', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null order by created_at desc limit 25$$);
select pg_temp.time_it('leads list exact count', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null$$);
select pg_temp.time_it('my open tasks', $$select id from public.tasks where assigned_to = auth.uid() and status in ('open','in_progress') order by due_at limit 25$$);
select pg_temp.time_it('report_company_kpis (30 days)', $$select * from public.report_company_kpis(current_date - 29, current_date)$$);
select pg_temp.time_it('global_search', $$select * from public.global_search('Volume Person 1234')$$);

\echo '--- mgr_a'
select tests.login('mgr_a');
select pg_temp.time_it('leads list page (25, newest)', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null order by created_at desc limit 25$$);
select pg_temp.time_it('leads list exact count', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null$$);
select pg_temp.time_it('report_employee_performance (30 days)', $$select * from public.report_employee_performance(tests.ref('alpha'), current_date - 29, current_date)$$);

\echo '--- admin_a'
select tests.login('admin_a');
select pg_temp.time_it('leads list page (25, newest)', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null order by created_at desc limit 25$$);
select pg_temp.time_it('leads list exact count', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null$$);
select pg_temp.time_it('leads overdue follow-ups', $$select id from public.leads where company_id = tests.ref('alpha') and archived_at is null and next_follow_up_at < now()$$);
select pg_temp.time_it('report_company_kpis (365 days)', $$select * from public.report_company_kpis(current_date - 365, current_date)$$);
select pg_temp.time_it('report_daily_series (90 days)', $$select * from public.report_daily_series(tests.ref('alpha'), current_date - 89, current_date)$$);
select pg_temp.time_it('report_employee_performance (365 days)', $$select * from public.report_employee_performance(tests.ref('alpha'), current_date - 365, current_date)$$);
select pg_temp.time_it('global_search by phone digits', $$select * from public.global_search('0012345')$$);
select pg_temp.time_it('contacts list (contact_companies join)', $$select cc.id from public.contact_companies cc join public.contacts c on c.id = cc.contact_id where cc.company_id = tests.ref('alpha') order by cc.created_at desc limit 25$$);
rollback;
