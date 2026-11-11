-- =============================================================================
-- 0700 — Reporting functions.
--
-- Every metric has one definition, documented in docs/METRICS.md and
-- implemented once here. Periods are calendar dates interpreted in each
-- company's own time zone: [p_from 00:00 local, p_to + 1 day 00:00 local).
--
-- These are SECURITY DEFINER for speed, so each one applies the caller's
-- scope explicitly via app.report_scope(), which mirrors the RLS rules:
--   super admin / company admin : whole company
--   sales manager               : themselves, members of teams they manage,
--                                 and unassigned records
--   agents                      : only themselves
-- Simulated (development) WhatsApp data is excluded unless requested.
-- =============================================================================

create or replace function app.period_start(p_company_id uuid, p_day date) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select (p_day::timestamp) at time zone c.timezone from public.companies c where c.id = p_company_id
$$;

create or replace function app.report_scope()
returns table (company_id uuid, see_all boolean, owners uuid[], include_unowned boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  r record;
  v_role public.app_role;
begin
  if v_uid is null then return; end if;
  for r in select id from app.accessible_company_ids() as t(id) loop
    if app.is_super_admin() then
      return query select r.id, true, array[]::uuid[], true;
      continue;
    end if;
    v_role := app.company_role(r.id);
    if v_role = 'company_admin' then
      return query select r.id, true, array[]::uuid[], true;
    elsif v_role = 'sales_manager' then
      return query select r.id, false,
        array_append(coalesce((
          select array_agg(distinct tm.user_id)
          from public.teams t join public.team_memberships tm on tm.team_id = t.id
          where t.company_id = r.id and t.is_active and t.manager_id = v_uid), array[]::uuid[]), v_uid),
        true;
    else
      return query select r.id, false, array[v_uid], false;
    end if;
  end loop;
end $$;

-- Members visible in reports for a company, optionally narrowed to a team.
create or replace function app.report_users(p_company_id uuid, p_team_id uuid default null)
returns table (user_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(nullif(p.full_name, ''), p.email, '')
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
  join app.report_scope() s on s.company_id = m.company_id
  where m.company_id = p_company_id and m.is_active
    and (s.see_all or p.id = any (s.owners))
    and (p_team_id is null or exists (
      select 1 from public.team_memberships tm where tm.team_id = p_team_id and tm.user_id = p.id))
$$;

-- -----------------------------------------------------------------------------
-- Company KPIs (dashboard + company comparison). One row per company in scope.
-- -----------------------------------------------------------------------------
create or replace function public.report_company_kpis(
  p_from date, p_to date,
  p_company_ids uuid[] default null,
  p_team_id uuid default null,
  p_user_id uuid default null
) returns table (
  company_id uuid, company_name text, currency char(3),
  open_leads bigint,             -- snapshot: not archived, status new/contacted/qualified
  leads_created bigint,          -- leads.created_at in period
  leads_converted bigint,        -- leads created in period that now have a deal (cohort)
  lead_conversion_rate numeric,  -- leads_converted / leads_created
  open_deals bigint,             -- snapshot: status open, not archived
  open_pipeline_value numeric,   -- snapshot: sum(amount) of open deals (estimate, not revenue)
  weighted_pipeline_value numeric, -- snapshot: sum(amount * probability / 100) of open deals
  deals_won bigint,              -- won_at in period
  deals_lost bigint,             -- lost_at in period
  won_revenue numeric,           -- sum(amount) of deals won in period = realized revenue
  win_rate numeric,              -- deals_won / (deals_won + deals_lost)
  overdue_tasks bigint,          -- snapshot: open/in_progress with due_at < now()
  tasks_completed bigint,        -- completed_at in period
  activities_logged bigint       -- activities.occurred_at in period
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'report.invalid_period' using errcode = '22023';
  end if;
  return query
  with scope as (
    select s.*, c.name, c.currency as cur,
           app.period_start(c.id, p_from) as t0, app.period_start(c.id, p_to + 1) as t1
    from app.report_scope() s join public.companies c on c.id = s.company_id
    where p_company_ids is null or s.company_id = any (p_company_ids)
  ),
  team_users as (
    select tm.user_id from public.team_memberships tm where tm.team_id = p_team_id
  ),
  -- "owner filter": record visible in scope and matching the team/user filters
  l as (
    select l.*, s.t0, s.t1 from public.leads l join scope s on s.company_id = l.company_id
    where (s.see_all or l.owner_id = any (s.owners) or (s.include_unowned and l.owner_id is null))
      and (p_user_id is null or l.owner_id = p_user_id)
      and (p_team_id is null or l.owner_id in (select user_id from team_users))
  ),
  lc as (  -- leads attributed to their creator for "created" metrics
    select l.*, s.t0, s.t1 from public.leads l join scope s on s.company_id = l.company_id
    where (s.see_all or l.created_by = any (s.owners))
      and (p_user_id is null or l.created_by = p_user_id)
      and (p_team_id is null or l.created_by in (select user_id from team_users))
      and l.created_at >= s.t0 and l.created_at < s.t1
  ),
  d as (
    select d.*, s.t0, s.t1 from public.deals d join scope s on s.company_id = d.company_id
    where d.archived_at is null
      and (s.see_all or d.owner_id = any (s.owners) or (s.include_unowned and d.owner_id is null))
      and (p_user_id is null or d.owner_id = p_user_id)
      and (p_team_id is null or d.owner_id in (select user_id from team_users))
  ),
  t as (
    select t.*, s.t0, s.t1 from public.tasks t join scope s on s.company_id = t.company_id
    where (s.see_all or t.assigned_to = any (s.owners) or (s.include_unowned and t.assigned_to is null))
      and (p_user_id is null or t.assigned_to = p_user_id)
      and (p_team_id is null or t.assigned_to in (select user_id from team_users))
  ),
  a as (
    select a.* from public.activities a join scope s on s.company_id = a.company_id
    where (s.see_all or a.actor_id = any (s.owners))
      and (p_user_id is null or a.actor_id = p_user_id)
      and (p_team_id is null or a.actor_id in (select user_id from team_users))
      and a.occurred_at >= s.t0 and a.occurred_at < s.t1
  )
  select s.company_id, s.name, s.cur,
    (select count(*) from l where l.company_id = s.company_id and l.archived_at is null
       and l.status in ('new', 'contacted', 'qualified')),
    (select count(*) from lc where lc.company_id = s.company_id),
    (select count(*) from lc where lc.company_id = s.company_id
       and exists (select 1 from public.deals x where x.lead_id = lc.id)),
    (select round(count(*) filter (where exists (select 1 from public.deals x where x.lead_id = lc.id))::numeric
                  / nullif(count(*), 0), 4) from lc where lc.company_id = s.company_id),
    (select count(*) from d where d.company_id = s.company_id and d.status = 'open'),
    (select coalesce(sum(d.amount), 0) from d where d.company_id = s.company_id and d.status = 'open'),
    (select coalesce(round(sum(d.amount * coalesce(d.probability, 0) / 100.0), 2), 0)
       from d where d.company_id = s.company_id and d.status = 'open'),
    (select count(*) from d where d.company_id = s.company_id and d.status = 'won' and d.won_at >= d.t0 and d.won_at < d.t1),
    (select count(*) from d where d.company_id = s.company_id and d.status = 'lost' and d.lost_at >= d.t0 and d.lost_at < d.t1),
    (select coalesce(sum(d.amount), 0) from d where d.company_id = s.company_id and d.status = 'won'
       and d.won_at >= d.t0 and d.won_at < d.t1),
    (select round(count(*) filter (where d.status = 'won')::numeric / nullif(count(*), 0), 4)
       from d where d.company_id = s.company_id and (
         (d.status = 'won' and d.won_at >= d.t0 and d.won_at < d.t1) or
         (d.status = 'lost' and d.lost_at >= d.t0 and d.lost_at < d.t1))),
    (select count(*) from t where t.company_id = s.company_id and t.status in ('open', 'in_progress') and t.due_at < now()),
    (select count(*) from t where t.company_id = s.company_id and t.status = 'completed'
       and t.completed_at >= t.t0 and t.completed_at < t.t1),
    (select count(*) from a where a.company_id = s.company_id)
  from scope s
  order by s.name;
end $$;

-- -----------------------------------------------------------------------------
-- Employee performance for one company. One row per visible member.
-- -----------------------------------------------------------------------------
create or replace function public.report_employee_performance(
  p_company_id uuid, p_from date, p_to date, p_team_id uuid default null
) returns table (
  user_id uuid, full_name text,
  leads_created bigint,        -- leads.created_by = user, created in period
  leads_assigned bigint,       -- assignment events to the user in period
  leads_contacted bigint,      -- distinct leads with a call/meeting/email/whatsapp activity by the user in period
  calls_logged bigint,
  meetings_logged bigint,
  follow_ups_completed bigint, -- tasks completed_by = user, completed in period
  overdue_tasks bigint,        -- snapshot: assigned to user, open/in_progress, due_at < now()
  deals_created bigint,        -- deals.created_by = user, created in period
  deals_won bigint,            -- deals owned by user with won_at in period
  deals_lost bigint,           -- deals owned by user with lost_at in period
  won_revenue numeric,         -- sum(amount) of those won deals
  win_rate numeric,            -- won / (won + lost)
  whatsapp_replies bigint,     -- outbound messages sent_by user in period, not failed
  sign_ins bigint              -- sign-in events in period (NOT working time)
)
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz;
  t1 timestamptz;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'report.invalid_period' using errcode = '22023';
  end if;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  select u.user_id, u.full_name,
    (select count(*) from public.leads l where l.company_id = p_company_id and l.created_by = u.user_id
       and l.created_at >= t0 and l.created_at < t1),
    (select count(*) from public.lead_assignments la where la.company_id = p_company_id and la.to_user_id = u.user_id
       and la.created_at >= t0 and la.created_at < t1),
    (select count(distinct a.lead_id) from public.activities a where a.company_id = p_company_id and a.actor_id = u.user_id
       and a.lead_id is not null and a.type in ('call', 'meeting', 'email', 'whatsapp')
       and a.occurred_at >= t0 and a.occurred_at < t1),
    (select count(*) from public.activities a where a.company_id = p_company_id and a.actor_id = u.user_id
       and a.type = 'call' and a.occurred_at >= t0 and a.occurred_at < t1),
    (select count(*) from public.activities a where a.company_id = p_company_id and a.actor_id = u.user_id
       and a.type = 'meeting' and a.occurred_at >= t0 and a.occurred_at < t1),
    (select count(*) from public.tasks t where t.company_id = p_company_id and t.completed_by = u.user_id
       and t.status = 'completed' and t.completed_at >= t0 and t.completed_at < t1),
    (select count(*) from public.tasks t where t.company_id = p_company_id and t.assigned_to = u.user_id
       and t.status in ('open', 'in_progress') and t.due_at < now()),
    (select count(*) from public.deals d where d.company_id = p_company_id and d.created_by = u.user_id
       and d.created_at >= t0 and d.created_at < t1),
    (select count(*) from public.deals d where d.company_id = p_company_id and d.owner_id = u.user_id
       and d.status = 'won' and d.won_at >= t0 and d.won_at < t1 and d.archived_at is null),
    (select count(*) from public.deals d where d.company_id = p_company_id and d.owner_id = u.user_id
       and d.status = 'lost' and d.lost_at >= t0 and d.lost_at < t1 and d.archived_at is null),
    (select coalesce(sum(d.amount), 0) from public.deals d where d.company_id = p_company_id and d.owner_id = u.user_id
       and d.status = 'won' and d.won_at >= t0 and d.won_at < t1 and d.archived_at is null),
    (select round(count(*) filter (where d.status = 'won')::numeric / nullif(count(*), 0), 4)
       from public.deals d where d.company_id = p_company_id and d.owner_id = u.user_id and d.archived_at is null
       and ((d.status = 'won' and d.won_at >= t0 and d.won_at < t1)
         or (d.status = 'lost' and d.lost_at >= t0 and d.lost_at < t1))),
    (select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id
       where c.company_id = p_company_id and m.sent_by = u.user_id and m.direction = 'outbound'
       and m.status <> 'failed' and not m.is_simulated and m.sent_at >= t0 and m.sent_at < t1),
    (select count(*) from public.auth_events e where e.user_id = u.user_id and e.event = 'sign_in'
       and e.created_at >= t0 and e.created_at < t1)
  from app.report_users(p_company_id, p_team_id) u
  order by u.full_name;
end $$;

-- -----------------------------------------------------------------------------
-- Daily series for charts (company local days).
-- -----------------------------------------------------------------------------
create or replace function public.report_daily_series(
  p_company_id uuid, p_from date, p_to date, p_user_id uuid default null
) returns table (day date, leads_created bigint, calls_logged bigint, tasks_completed bigint,
                 deals_won bigint, won_revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'report.invalid_period' using errcode = '22023';
  end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if p_user_id is not null and not (v_scope.see_all or p_user_id = any (v_scope.owners)) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  return query
  with days as (select generate_series(p_from, p_to, interval '1 day')::date as day)
  select days.day,
    (select count(*) from public.leads l where l.company_id = p_company_id
       and (l.created_at at time zone v_tz)::date = days.day
       and (v_scope.see_all or l.created_by = any (v_scope.owners))
       and (p_user_id is null or l.created_by = p_user_id)),
    (select count(*) from public.activities a where a.company_id = p_company_id and a.type = 'call'
       and (a.occurred_at at time zone v_tz)::date = days.day
       and (v_scope.see_all or a.actor_id = any (v_scope.owners))
       and (p_user_id is null or a.actor_id = p_user_id)),
    (select count(*) from public.tasks t where t.company_id = p_company_id and t.status = 'completed'
       and (t.completed_at at time zone v_tz)::date = days.day
       and (v_scope.see_all or t.completed_by = any (v_scope.owners))
       and (p_user_id is null or t.completed_by = p_user_id)),
    (select count(*) from public.deals d where d.company_id = p_company_id and d.status = 'won' and d.archived_at is null
       and (d.won_at at time zone v_tz)::date = days.day
       and (v_scope.see_all or d.owner_id = any (v_scope.owners) or (v_scope.include_unowned and d.owner_id is null))
       and (p_user_id is null or d.owner_id = p_user_id)),
    (select coalesce(sum(d.amount), 0) from public.deals d where d.company_id = p_company_id and d.status = 'won'
       and d.archived_at is null and (d.won_at at time zone v_tz)::date = days.day
       and (v_scope.see_all or d.owner_id = any (v_scope.owners) or (v_scope.include_unowned and d.owner_id is null))
       and (p_user_id is null or d.owner_id = p_user_id))
  from days order by days.day;
end $$;

-- -----------------------------------------------------------------------------
-- Sales target progress: actual values use the same definitions as above.
-- -----------------------------------------------------------------------------
create or replace function public.report_target_progress(p_company_id uuid, p_on date default current_date)
returns table (target_id uuid, metric public.target_metric, user_id uuid, team_id uuid,
               period_start date, period_end date, target_value numeric, actual_value numeric, attainment numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  return query
  with tg as (
    select st.*, app.period_start(st.company_id, st.period_start) as t0,
           app.period_start(st.company_id, st.period_end + 1) as t1
    from public.sales_targets st
    where st.company_id = p_company_id and p_on between st.period_start and st.period_end
      and (v_scope.see_all
           or st.user_id = any (v_scope.owners)
           or (st.user_id is null and st.team_id is null)
           or (st.team_id is not null and (app.manages_team(p_company_id, st.team_id) or exists (
               select 1 from public.team_memberships tm where tm.team_id = st.team_id and tm.user_id = auth.uid()))))
  ),
  people as (  -- who a target counts: one user, a team's members, or the whole company
    select tg.id as tid, x.uid
    from tg cross join lateral (
      select tg.user_id as uid where tg.user_id is not null
      union all select tm.user_id from public.team_memberships tm where tm.team_id = tg.team_id
      union all select m.user_id from public.company_memberships m
                where tg.user_id is null and tg.team_id is null and m.company_id = p_company_id
    ) x
  ),
  actual as (
    select tg.id as tid,
      case tg.metric
        when 'won_revenue' then (select coalesce(sum(d.amount), 0) from public.deals d
          where d.company_id = p_company_id and d.status = 'won' and d.archived_at is null
            and d.won_at >= tg.t0 and d.won_at < tg.t1 and d.owner_id in (select uid from people where tid = tg.id))
        when 'deals_won' then (select count(*) from public.deals d
          where d.company_id = p_company_id and d.status = 'won' and d.archived_at is null
            and d.won_at >= tg.t0 and d.won_at < tg.t1 and d.owner_id in (select uid from people where tid = tg.id))
        when 'leads_created' then (select count(*) from public.leads l
          where l.company_id = p_company_id and l.created_at >= tg.t0 and l.created_at < tg.t1
            and l.created_by in (select uid from people where tid = tg.id))
        when 'leads_contacted' then (select count(distinct a.lead_id) from public.activities a
          where a.company_id = p_company_id and a.lead_id is not null and a.type in ('call', 'meeting', 'email', 'whatsapp')
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'calls_logged' then (select count(*) from public.activities a
          where a.company_id = p_company_id and a.type = 'call'
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'meetings_logged' then (select count(*) from public.activities a
          where a.company_id = p_company_id and a.type = 'meeting'
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'tasks_completed' then (select count(*) from public.tasks t
          where t.company_id = p_company_id and t.status = 'completed'
            and t.completed_at >= tg.t0 and t.completed_at < tg.t1 and t.completed_by in (select uid from people where tid = tg.id))
      end::numeric as v
    from tg
  )
  select tg.id, tg.metric, tg.user_id, tg.team_id, tg.period_start, tg.period_end, tg.target_value,
         a.v, round(a.v / tg.target_value, 4)
  from tg join actual a on a.tid = tg.id
  order by tg.metric, tg.period_start;
end $$;

-- -----------------------------------------------------------------------------
-- WhatsApp response times.
-- A "customer turn" starts at the first inbound message after the previous
-- outbound message (or the first inbound ever). Its response is the first
-- later outbound message sent by an authenticated user (sent_by not null,
-- not failed). Calendar time, not business hours — see docs/METRICS.md.
-- Turns with no reply yet are counted as unanswered, never as zero.
-- -----------------------------------------------------------------------------
create or replace function public.report_whatsapp_response(
  p_company_id uuid, p_from date, p_to date, p_include_simulated boolean default false
) returns table (user_id uuid, full_name text, turns_answered bigint,
                 avg_response_seconds numeric, median_response_seconds numeric,
                 answered_within_15m numeric, unanswered_turns bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz; t1 timestamptz;
  v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'report.invalid_period' using errcode = '22023';
  end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with msgs as (
    select m.*, lag(m.direction) over (partition by m.conversation_id order by m.sent_at, m.created_at) as prev_dir
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.company_id = p_company_id and (p_include_simulated or not m.is_simulated)
      and m.status <> 'failed'
  ),
  turns as (
    select m.conversation_id, m.sent_at as asked_at
    from msgs m
    where m.direction = 'inbound' and (m.prev_dir is null or m.prev_dir = 'outbound')
      and m.sent_at >= t0 and m.sent_at < t1
  ),
  answered as (
    select t.conversation_id, t.asked_at, r.sent_by, r.sent_at as answered_at
    from turns t
    left join lateral (
      select o.sent_by, o.sent_at from msgs o
      where o.conversation_id = t.conversation_id and o.direction = 'outbound'
        and o.sent_by is not null and o.sent_at >= t.asked_at
      order by o.sent_at limit 1
    ) r on true
  ),
  visible as (
    select a.* from answered a
    where a.sent_by is null or v_scope.see_all or a.sent_by = any (v_scope.owners)
  )
  select v.sent_by, app.user_display_name(v.sent_by),
    count(*) filter (where v.sent_by is not null),
    round(avg(extract(epoch from v.answered_at - v.asked_at)) filter (where v.sent_by is not null), 0),
    round((percentile_cont(0.5) within group (order by extract(epoch from v.answered_at - v.asked_at)))::numeric, 0),
    round((count(*) filter (where v.answered_at - v.asked_at <= interval '15 minutes'))::numeric
          / nullif(count(*) filter (where v.sent_by is not null), 0), 4),
    count(*) filter (where v.sent_by is null)
  from visible v
  where v.sent_by is not null or v_scope.see_all or v_scope.include_unowned
  group by v.sent_by
  order by v.sent_by nulls last;
end $$;

-- -----------------------------------------------------------------------------
-- WhatsApp workload snapshot per number (inbox header + dashboard).
-- -----------------------------------------------------------------------------
create or replace function public.report_whatsapp_workload(p_company_ids uuid[] default null)
returns table (whatsapp_account_id uuid, display_name text, company_id uuid,
               open_conversations bigint, unassigned_conversations bigint, unread_conversations bigint)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.display_name, c.company_id,
    count(*) filter (where c.status <> 'resolved'),
    count(*) filter (where c.status <> 'resolved' and c.owner_id is null),
    count(*) filter (where c.unread_count > 0)
  from public.conversations c join public.whatsapp_accounts a on a.id = c.whatsapp_account_id
  where (p_company_ids is null or c.company_id = any (p_company_ids))
  group by a.id, a.display_name, c.company_id
  order by a.display_name
$$;

revoke all on function
  public.report_company_kpis(date, date, uuid[], uuid, uuid),
  public.report_employee_performance(uuid, date, date, uuid),
  public.report_daily_series(uuid, date, date, uuid),
  public.report_target_progress(uuid, date),
  public.report_whatsapp_response(uuid, date, date, boolean),
  public.report_whatsapp_workload(uuid[])
from public, anon;
grant execute on function
  public.report_company_kpis(date, date, uuid[], uuid, uuid),
  public.report_employee_performance(uuid, date, date, uuid),
  public.report_daily_series(uuid, date, date, uuid),
  public.report_target_progress(uuid, date),
  public.report_whatsapp_response(uuid, date, date, boolean),
  public.report_whatsapp_workload(uuid[])
to authenticated, service_role;
revoke all on function app.period_start(uuid, date), app.report_scope(), app.report_users(uuid, uuid) from public, anon;
grant execute on function app.period_start(uuid, date), app.report_scope(), app.report_users(uuid, uuid) to authenticated, service_role;
