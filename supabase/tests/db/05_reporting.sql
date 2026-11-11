-- Metric definitions and report scopes. Brief §19 scenarios 6 and 9.
-- Alpha's time zone is Asia/Qatar (UTC+3); September 2026 is the test period.
begin;

do $$
declare
  a uuid := tests.ref('alpha');
  a1 uuid := tests.uid('agent_a1'); a2 uuid := tests.uid('agent_a2');
  ct uuid := tests.ref('contact_shared');
  p uuid; s_open uuid; s_won uuid; s_lost uuid;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid;
begin
  perform set_config('app.actor_id', a1::text, true);
  select id into p from public.pipelines where company_id = a and kind = 'deal' and is_default;
  select id into s_open from public.pipeline_stages where pipeline_id = p and stage_type = 'open' order by position limit 1;
  select id into s_won from public.pipeline_stages where pipeline_id = p and stage_type = 'won';
  select id into s_lost from public.pipeline_stages where pipeline_id = p and stage_type = 'lost';

  -- Leads created by a1: 4 in September, 1 in August.
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values
    (a, ct, 'L1', a1, a1, '2026-09-02 09:00+03') returning id into l1;
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values
    (a, ct, 'L2', a1, a1, '2026-09-05 09:00+03') returning id into l2;
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values
    (a, ct, 'L3', a2, a1, '2026-09-06 09:00+03') returning id into l3;   -- created by a1, owned by a2
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values
    (a, ct, 'L4', null, a1, '2026-09-30 23:30+03') returning id into l4;  -- last minute of the month, local
  insert into public.leads (company_id, contact_id, title, owner_id, created_by, created_at) values
    (a, ct, 'L-aug', a1, a1, '2026-08-31 23:59+03');
  insert into public.lead_assignments (lead_id, company_id, from_user_id, to_user_id, assigned_by, created_at)
    values (l3, a, null, a2, a1, '2026-09-06 10:00+03');

  -- Deals.
  insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at, created_at)
    values (a, l1, ct, p, s_won, 'D won 1000', 1000, a1, a1, '2026-09-10 12:00+03', '2026-09-03 09:00+03');
  -- 22:00 UTC on Aug 31 = 01:00 on Sep 1 in Qatar: belongs to September.
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at, created_at)
    values (a, ct, p, s_won, 'D won 500 boundary', 500, a1, a1, '2026-08-31 22:00+00', '2026-08-20 09:00+03');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, lost_at, loss_reason)
    values (a, ct, p, s_lost, 'D lost', 700, a1, a1, '2026-09-15 12:00+03', 'price');
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, probability)
    values (a, ct, p, s_open, 'D open', 2000, a1, a1, 40);
  update public.deals set probability = 40 where title = 'D open';
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at)
    values (a, ct, p, s_won, 'D won 300 a2', 300, a2, a2, '2026-09-20 12:00+03');
  -- 21:30 UTC on Sep 30 = 00:30 on Oct 1 in Qatar: NOT September.
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at)
    values (a, ct, p, s_won, 'D won october', 9999, a1, a1, '2026-09-30 21:30+00');

  -- Tasks for a1: 2 completed in Sept, 1 in Aug, 1 overdue open, 1 open not yet due.
  insert into public.tasks (company_id, title, assigned_to, created_by, status, completed_at, completed_by) values
    (a, 'T1', a1, a1, 'completed', '2026-09-08 10:00+03', a1),
    (a, 'T2', a1, a1, 'completed', '2026-09-28 10:00+03', a1),
    (a, 'T-aug', a1, a1, 'completed', '2026-08-28 10:00+03', a1);
  insert into public.tasks (company_id, title, assigned_to, created_by, due_at) values
    (a, 'T overdue', a1, a1, now() - interval '1 day'),
    (a, 'T future', a1, a1, now() + interval '1 day');

  -- Activities by a1 in Sept: 3 calls on 2 distinct leads, 1 meeting; 1 call in Aug.
  insert into public.activities (company_id, type, actor_id, lead_id, occurred_at) values
    (a, 'call', a1, l1, '2026-09-02 10:00+03'),
    (a, 'call', a1, l1, '2026-09-04 10:00+03'),
    (a, 'call', a1, l2, '2026-09-05 10:00+03'),
    (a, 'meeting', a1, l2, '2026-09-07 10:00+03'),
    (a, 'call', a1, l2, '2026-08-30 10:00+03');
end $$;

-- ------------------------------------------- 9. company KPIs (admin view)
select tests.login('admin_a');
create temp table k as select * from public.report_company_kpis('2026-09-01', '2026-09-30');
select tests.eq((select count(*) from k), 1::bigint, 'admin_a gets one KPI row (Alpha only)');
select tests.eq((select leads_created from k), 4::bigint, 'leads created in Sept (local time, incl. 23:30 on Sep 30)');
select tests.eq((select leads_converted from k), 1::bigint, 'cohort conversion: 1 of the Sept leads has a deal');
select tests.eq((select lead_conversion_rate from k), 0.25, 'lead conversion rate = 1/4');
select tests.eq((select deals_won from k), 3::bigint, 'won deals in Sept: 1000, 500 (tz boundary), 300 — not the Oct one');
select tests.eq((select won_revenue from k), 1800.00, 'realized revenue = only deals won in the period');
select tests.eq((select deals_lost from k), 1::bigint, 'lost deals in Sept');
select tests.eq((select win_rate from k), 0.75, 'win rate = won / (won + lost) = 3/4');
select tests.eq((select open_pipeline_value from k), 2000.00, 'open deal value is pipeline, not revenue');
select tests.eq((select weighted_pipeline_value from k), 800.00, 'weighted pipeline = amount x probability');
select tests.eq((select overdue_tasks from k), 1::bigint, 'overdue = open and past due (completed/future excluded)');
select tests.eq((select tasks_completed from k), 2::bigint, 'tasks completed in Sept');
select tests.eq((select activities_logged from k), 4::bigint, 'activities in Sept');
drop table k;

-- Employee performance (admin sees every member).
create temp table e as select * from public.report_employee_performance(tests.ref('alpha'), '2026-09-01', '2026-09-30');
select tests.eq((select leads_created from e where user_id = tests.uid('agent_a1')), 4::bigint,
  'a1 created 4 leads (including one now owned by a2)');
select tests.eq((select leads_created from e where user_id = tests.uid('agent_a2')), 0::bigint,
  'a2 created none: ownership is not creation');
select tests.eq((select leads_assigned from e where user_id = tests.uid('agent_a2')), 1::bigint, 'a2 received 1 assignment');
select tests.eq((select calls_logged from e where user_id = tests.uid('agent_a1')), 3::bigint, 'a1 calls in Sept');
select tests.eq((select meetings_logged from e where user_id = tests.uid('agent_a1')), 1::bigint, 'a1 meetings in Sept');
select tests.eq((select leads_contacted from e where user_id = tests.uid('agent_a1')), 2::bigint,
  'leads contacted = distinct leads with outreach activity');
select tests.eq((select follow_ups_completed from e where user_id = tests.uid('agent_a1')), 2::bigint, 'a1 completed 2 tasks in Sept');
select tests.eq((select overdue_tasks from e where user_id = tests.uid('agent_a1')), 1::bigint, 'a1 has 1 overdue task');
select tests.eq((select deals_won from e where user_id = tests.uid('agent_a1')), 2::bigint, 'a1 won 2 deals in Sept');
select tests.eq((select won_revenue from e where user_id = tests.uid('agent_a1')), 1500.00, 'a1 revenue');
select tests.eq((select win_rate from e where user_id = tests.uid('agent_a1')), 0.6667, 'a1 win rate 2/3');
select tests.eq((select won_revenue from e where user_id = tests.uid('agent_a2')), 300.00, 'a2 revenue');
select tests.eq((select calls_logged from e where user_id = tests.uid('agent_a2')), 0::bigint,
  'no recorded activity is reported as zero recorded, not invented');
drop table e;

-- Daily series sums agree with the totals.
create temp table ds as select * from public.report_daily_series(tests.ref('alpha'), '2026-09-01', '2026-09-30');
select tests.eq((select count(*) from ds), 30::bigint, 'one row per local day');
select tests.eq((select sum(won_revenue) from ds), 1800.00, 'daily revenue sums to the period total');
select tests.eq((select deals_won from ds where day = '2026-09-01'), 1::bigint, 'boundary deal lands on Sep 1 local');
select tests.eq((select leads_created from ds where day = '2026-09-30'), 1::bigint, '23:30 lead lands on Sep 30 local');
drop table ds;

-- -------------------------------------------------------- report scopes
select tests.login('mgr_a');
create temp table e as select * from public.report_employee_performance(tests.ref('alpha'), '2026-09-01', '2026-09-30');
select tests.eq((select array_agg(full_name order by full_name collate "C") from e),
  array['Agent Alpha One', 'Manager Alpha', 'Shared Employee'],
  'manager sees self + managed team members only (not agent_a2)');
drop table e;
create temp table k as select * from public.report_company_kpis('2026-09-01', '2026-09-30');
select tests.eq((select won_revenue from k), 1500.00, 'manager KPIs exclude unmanaged agent_a2 revenue');
drop table k;

select tests.login('agent_a1');
create temp table e as select * from public.report_employee_performance(tests.ref('alpha'), '2026-09-01', '2026-09-30');
select tests.eq((select array_agg(full_name) from e), array['Agent Alpha One'], 'agent sees only their own performance');
drop table e;
select tests.throws($q$select * from public.report_daily_series(tests.ref('alpha'), '2026-09-01', '2026-09-30', tests.uid('agent_a2'))$q$,
  'auth.forbidden', 'agent cannot request another agent''s series');

select tests.login('admin_b');
select tests.throws($q$select * from public.report_employee_performance(tests.ref('alpha'), '2026-09-01', '2026-09-30')$q$,
  'auth.forbidden', 'another company''s admin cannot read Alpha reports');
select tests.eq(tests.count($q$select * from public.report_company_kpis('2026-09-01', '2026-09-30', array[tests.ref('alpha')])$q$),
  0::bigint, 'requesting Alpha KPIs from Beta returns nothing');

select tests.login('super');
select tests.eq(tests.count($q$select * from public.report_company_kpis('2026-09-01', '2026-09-30')$q$), 3::bigint,
  'super admin compares all three companies');
select tests.throws($q$select * from public.report_company_kpis('2026-09-30', '2026-09-01')$q$, 'report.invalid_period',
  'reversed periods are rejected');

-- ------------------------------ 6. task completion updates performance
select tests.login('agent_a1');
create temp table before_ as select follow_ups_completed as n
  from public.report_employee_performance(tests.ref('alpha'), current_date - 1, current_date + 1);
select tests.lives($q$update public.tasks set status = 'completed' where title = 'T overdue'$q$, 'agent completes overdue task');
create temp table after_ as select follow_ups_completed as n, overdue_tasks as o
  from public.report_employee_performance(tests.ref('alpha'), current_date - 1, current_date + 1);
select tests.eq((select n from after_) - (select n from before_), 1::bigint, 'completing a task adds exactly one follow-up');
select tests.eq((select o from after_), 0::bigint, 'and removes it from overdue');

-- ----------------------------------------------------------- targets
select tests.logout();
insert into public.sales_targets (company_id, user_id, metric, period_start, period_end, target_value, created_by)
values (tests.ref('alpha'), tests.uid('agent_a1'), 'won_revenue', '2026-09-01', '2026-09-30', 3000, tests.uid('admin_a')),
       (tests.ref('alpha'), null, 'deals_won', '2026-09-01', '2026-09-30', 6, tests.uid('admin_a'));
select tests.login('agent_a1');
create temp table tp as select * from public.report_target_progress(tests.ref('alpha'), '2026-09-15');
select tests.eq((select actual_value from tp where metric = 'won_revenue'), 1500.00, 'target actual uses the revenue definition');
select tests.eq((select attainment from tp where metric = 'won_revenue'), 0.5000, '50% attainment');
-- 0840: an agent sees the company-wide target but not the company's actual.
select tests.eq((select actual_value from tp where metric = 'deals_won'), null::numeric,
  'agent does not see the company-wide actual (outside their report scope)');
select tests.login('admin_a');
select tests.eq((select actual_value from public.report_target_progress(tests.ref('alpha'), '2026-09-15') where metric = 'deals_won'),
  3::numeric, 'company-wide target counts all members (admin view)');

-- ------------------------------------------------- WhatsApp response time
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'r1', '97455557777', 'Rana', 'text', 'q1', null, '2026-09-10 10:00+03');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'r2', '97455557777', 'Rana', 'text', 'q1 again', null, '2026-09-10 10:02+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'delivered', 'answer', tests.uid('agent_a1'), '2026-09-10 10:10+03', 'o1'
from public.conversations where customer_wa_id = '97455557777';
-- An automated/unknown-sender outbound does not count as an employee reply.
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'r3', '97455557777', 'Rana', 'text', 'q2', null, '2026-09-11 10:00+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'sent', 'auto', null, '2026-09-11 10:01+03', 'o2'
from public.conversations where customer_wa_id = '97455557777';
select tests.login('admin_a');
create temp table wr as select * from public.report_whatsapp_response(tests.ref('alpha'), '2026-09-01', '2026-09-30');
select tests.eq((select turns_answered from wr where user_id = tests.uid('agent_a1')), 1::bigint,
  'two quick customer messages form one turn');
select tests.eq((select avg_response_seconds from wr where user_id = tests.uid('agent_a1')), 600::numeric,
  'response time measured from the first customer message of the turn (10 min)');
select tests.eq((select unanswered_turns from wr where user_id is null), 1::bigint,
  'a turn answered only by an unattributed sender is unanswered, not credited to anyone');

rollback;
