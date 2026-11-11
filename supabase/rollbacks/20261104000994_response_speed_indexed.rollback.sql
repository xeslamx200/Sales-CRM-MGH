-- ROLLBACK of 20261104000994: restores the exact 20261104000982 body of public.report_response_speed. Run with psql -1.

create or replace function public.report_response_speed(p_company_id uuid, p_from date, p_to date)
returns table (day date, turns bigint, answered bigint, unanswered bigint, answered_by_crm bigint, answered_by_phone bigint,
               avg_seconds numeric, median_seconds numeric, p90_seconds numeric,
               within_5m numeric, within_15m numeric, within_60m numeric,
               avg_business_seconds numeric, median_business_seconds numeric, business_within_15m numeric)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_tz text; v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with msgs as (
    select m.conversation_id, m.direction, m.sent_at, m.sent_by, m.created_at,
           lag(m.direction) over (partition by m.conversation_id order by m.sent_at, m.created_at) as prev_dir
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.company_id = p_company_id and not m.is_simulated and m.status <> 'failed'
      and (v_scope.see_all or app.can_access_conversation(c.id))
  ),
  turns as (
    select m.conversation_id, m.sent_at as asked_at from msgs m
    where m.direction = 'inbound' and (m.prev_dir is null or m.prev_dir = 'outbound') and m.sent_at >= t0 and m.sent_at < t1
  ),
  answered as (
    select t.asked_at, r.sent_at as answered_at, r.sent_by,
           case when r.sent_at is not null then app.business_seconds(p_company_id, t.asked_at, r.sent_at) end as biz
    from turns t
    left join lateral (
      select o.sent_at, o.sent_by from msgs o
      where o.conversation_id = t.conversation_id and o.direction = 'outbound' and o.sent_at >= t.asked_at
      order by o.sent_at, o.created_at limit 1
    ) r on true
  ),
  x as (
    select (a.asked_at at time zone v_tz)::date as d, a.*, extract(epoch from a.answered_at - a.asked_at) as secs from answered a
  )
  select case when grouping(x.d) = 1 then null else x.d end,
    count(*),
    count(*) filter (where x.answered_at is not null),
    count(*) filter (where x.answered_at is null),
    count(*) filter (where x.answered_at is not null and x.sent_by is not null),
    count(*) filter (where x.answered_at is not null and x.sent_by is null),
    round(avg(x.secs), 0),
    round((percentile_cont(0.5) within group (order by x.secs))::numeric, 0),
    round((percentile_cont(0.9) within group (order by x.secs))::numeric, 0),
    round((count(*) filter (where x.secs <= 300))::numeric / nullif(count(*) filter (where x.answered_at is not null), 0), 4),
    round((count(*) filter (where x.secs <= 900))::numeric / nullif(count(*) filter (where x.answered_at is not null), 0), 4),
    round((count(*) filter (where x.secs <= 3600))::numeric / nullif(count(*) filter (where x.answered_at is not null), 0), 4),
    round(avg(x.biz), 0),
    round((percentile_cont(0.5) within group (order by x.biz))::numeric, 0),
    round((count(*) filter (where x.biz <= 900))::numeric / nullif(count(x.biz), 0), 4)
  from x
  group by rollup (x.d)
  order by x.d nulls last;
end $$;
