-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1. Read-only reports: no table, column or data change.
-- 20261104000982 - Leads per day, and how fast customers get an answer (including answers sent from the WhatsApp Business App).
--
--  * report_leads_per_day(company, from, to)        one row per day in the company's time zone: leads created, split automatic (from WhatsApp) / manual.
--  * report_response_speed(company, from, to)       one row per day plus one overall row (day NULL): customer "turns", answered / unanswered, who answered
--                                                   (CRM employee vs the phone app), average / median / 90th percentile time to the first reply, share
--                                                   answered within 5 / 15 / 60 minutes, and the same in BUSINESS hours when hours are configured.
--  * report_waiting_now(company)                    conversations whose last message is from the customer (nobody answered yet), longest wait first.
--
-- What counts as a "turn": a customer message that is the first one after our last message (or the first message ever). Several customer messages
-- in a row are ONE turn. The ANSWER is the first later outbound message of ANY kind that did not fail: an employee in the CRM, or a reply sent from the
-- WhatsApp Business App / another app / the Meta agent (an echo, sender unknown). The older report_whatsapp_response only counts CRM employees, so on a
-- Coexistence number it shows nearly everything as unanswered; it is left unchanged (it attributes answers to people, which an echo cannot).
-- Time is calendar time between the two messages; the business-hours variant uses app.business_seconds (NULL until opening hours are set).
-- Visibility = the other reports: app.report_scope() (sandbox companies return nothing; admins see the company; others see what they can access).
-- Rollback: supabase/proposed/rollbacks/20261104000982_daily_leads_response_speed.rollback.sql (drops the three functions).

create or replace function public.report_leads_per_day(p_company_id uuid, p_from date, p_to date)
returns table (day date, total bigint, automatic bigint, manual bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  return query
  with days as (select generate_series(p_from, p_to, interval '1 day')::date as d),
  mine as (
    select (l.created_at at time zone v_tz)::date as d, l.auto_created
    from public.leads l
    where l.company_id = p_company_id
      and l.created_at >= app.period_start(p_company_id, p_from) and l.created_at < app.period_start(p_company_id, p_to + 1)
      and (v_scope.see_all or app.can_access_lead(l.id))
  )
  select days.d, count(m.d), count(m.d) filter (where m.auto_created), count(m.d) filter (where not m.auto_created)
  from days left join mine m on m.d = days.d
  group by days.d order by days.d;
end $$;

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

create or replace function public.report_waiting_now(p_company_id uuid)
returns table (conversation_id uuid, contact_name text, waiting_since timestamptz, waiting_seconds bigint, owner_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  return query
  select c.id, k.full_name, lm.turn_start, extract(epoch from now() - lm.turn_start)::bigint, app.user_display_name(c.owner_id)
  from public.conversations c
  join public.contacts k on k.id = c.contact_id
  join lateral (
    -- the customer's messages since our last outbound message: the turn started at the first of them
    select min(m.sent_at) as turn_start,
           (select o.direction from public.messages o where o.conversation_id = c.id and o.status <> 'failed' order by o.sent_at desc, o.created_at desc limit 1) as last_dir
    from public.messages m
    where m.conversation_id = c.id and m.direction = 'inbound' and m.status <> 'failed'
      and m.sent_at > coalesce((select max(o.sent_at) from public.messages o where o.conversation_id = c.id and o.direction = 'outbound' and o.status <> 'failed'), '-infinity')
  ) lm on lm.last_dir = 'inbound' and lm.turn_start is not null
  where c.company_id = p_company_id and not c.is_simulated and c.status <> 'resolved'
    and (v_scope.see_all or app.can_access_conversation(c.id))
  order by lm.turn_start
  limit 100;
end $$;

revoke all on function public.report_leads_per_day(uuid, date, date), public.report_response_speed(uuid, date, date), public.report_waiting_now(uuid) from public, anon;
grant execute on function public.report_leads_per_day(uuid, date, date), public.report_response_speed(uuid, date, date), public.report_waiting_now(uuid) to authenticated, service_role;
