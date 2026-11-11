-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only after 20261104000993 and only with explicit approval.
-- 20261104000994 - public.report_response_speed no longer times out on a company with tens of thousands of messages.
--
-- Before: one CTE put EVERY message of the company (all time) through a window function and then, for every customer turn, scanned that CTE
-- again for the first reply (cost grows with turns x messages). With ~51,000 imported messages for one company the dashboard took ~16 s and the
-- database cancelled it (57014 statement timeout), so the whole dashboard failed.
-- Now: the turns of the period are found directly (one indexed look-up of the previous message and of the first reply per turn, through
-- messages_conversation_idx). Same filters (not simulated, not failed, conversation access), same ordering (sent_at, created_at), same output
-- columns and the same arithmetic; only messages with identical sent_at AND created_at can order differently (they did before, too).
-- Signature, grants and security are unchanged (CREATE OR REPLACE). No table, column or index.
-- Rollback: supabase/proposed/rollbacks/20261104000994_response_speed_indexed.rollback.sql (restores the 982 body). Run with psql -1.

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
  with turns as (
    -- a customer message that starts a turn: the message right before it in the same conversation (same ordering as before) is not
    -- also from the customer. Looked up per message through messages_conversation_idx instead of a window over every message of the company.
    select m.conversation_id, m.sent_at as asked_at
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    left join lateral (
      select p.direction from public.messages p
      where p.conversation_id = m.conversation_id and not p.is_simulated and p.status <> 'failed'
        and (p.sent_at, p.created_at) < (m.sent_at, m.created_at)
      order by p.sent_at desc, p.created_at desc limit 1
    ) pv on true
    where c.company_id = p_company_id and not m.is_simulated and m.status <> 'failed'
      and m.direction = 'inbound' and m.sent_at >= t0 and m.sent_at < t1
      and pv.direction is distinct from 'inbound'
      and (v_scope.see_all or app.can_access_conversation(c.id))
  ),
  answered as (
    select t.asked_at, r.sent_at as answered_at, r.sent_by,
           case when r.sent_at is not null then app.business_seconds(p_company_id, t.asked_at, r.sent_at) end as biz
    from turns t
    left join lateral (
      select o.sent_at, o.sent_by from public.messages o
      where o.conversation_id = t.conversation_id and o.direction = 'outbound' and not o.is_simulated and o.status <> 'failed'
        and o.sent_at >= t.asked_at
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
