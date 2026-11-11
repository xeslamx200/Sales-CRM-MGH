-- =============================================================================
-- 0830 — report_daily_series: same definitions and output, one pass per table.
--
-- The 0700 version ran five correlated subqueries per day with a
-- non-sargable `(ts at time zone tz)::date = day` filter, rescanning the
-- company's rows ~5 × days times (2.4 s for 90 days at 50k leads).
-- A timestamp falls on local day D exactly when it is in
-- [period_start(D), period_start(D + 1)), so each table is now read once over
-- the period range (index-friendly) and grouped by local date. Values are
-- unchanged; supabase/tests/db/05_reporting.sql checks them exactly.
-- =============================================================================
create or replace function public.report_daily_series(
  p_company_id uuid, p_from date, p_to date, p_user_id uuid default null
) returns table (day date, leads_created bigint, calls_logged bigint, tasks_completed bigint,
                 deals_won bigint, won_revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_scope record;
  t0 timestamptz;
  t1 timestamptz;
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
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);

  return query
  with days as (
    select generate_series(p_from, p_to, interval '1 day')::date as day
  ),
  l as (
    select (x.created_at at time zone v_tz)::date as day, count(*) as n
    from public.leads x
    where x.company_id = p_company_id and x.created_at >= t0 and x.created_at < t1
      and (v_scope.see_all or x.created_by = any (v_scope.owners))
      and (p_user_id is null or x.created_by = p_user_id)
    group by 1
  ),
  a as (
    select (x.occurred_at at time zone v_tz)::date as day, count(*) as n
    from public.activities x
    where x.company_id = p_company_id and x.type = 'call' and x.occurred_at >= t0 and x.occurred_at < t1
      and (v_scope.see_all or x.actor_id = any (v_scope.owners))
      and (p_user_id is null or x.actor_id = p_user_id)
    group by 1
  ),
  t as (
    select (x.completed_at at time zone v_tz)::date as day, count(*) as n
    from public.tasks x
    where x.company_id = p_company_id and x.status = 'completed' and x.completed_at >= t0 and x.completed_at < t1
      and (v_scope.see_all or x.completed_by = any (v_scope.owners))
      and (p_user_id is null or x.completed_by = p_user_id)
    group by 1
  ),
  d as (
    select (x.won_at at time zone v_tz)::date as day, count(*) as n, coalesce(sum(x.amount), 0) as revenue
    from public.deals x
    where x.company_id = p_company_id and x.status = 'won' and x.archived_at is null
      and x.won_at >= t0 and x.won_at < t1
      and (v_scope.see_all or x.owner_id = any (v_scope.owners) or (v_scope.include_unowned and x.owner_id is null))
      and (p_user_id is null or x.owner_id = p_user_id)
    group by 1
  )
  select days.day,
    coalesce(l.n, 0)::bigint, coalesce(a.n, 0)::bigint, coalesce(t.n, 0)::bigint,
    coalesce(d.n, 0)::bigint, coalesce(d.revenue, 0)::numeric
  from days
  left join l on l.day = days.day
  left join a on a.day = days.day
  left join t on t.day = days.day
  left join d on d.day = days.day
  order by days.day;
end $$;
