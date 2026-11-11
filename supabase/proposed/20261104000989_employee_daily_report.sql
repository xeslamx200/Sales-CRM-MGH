-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000989 - Presence (first / last time an employee used the CRM each day) and the per-employee DAILY report.
-- Purely additive: one table, two functions; no existing row or function is changed.
--
--  * user_presence_days: one row per employee, company and calendar day (company time zone): first_seen (first time the CRM was opened that day, i.e. the
--    first login / page load) and last_seen (the last "I am still using it" signal). The browser sends a signal when a page opens and then at most every
--    couple of minutes while the tab is visible and the person is interacting; the database keeps at most one write per 30 seconds per person. So
--    last_seen is accurate to a few minutes. Only active members of the company are recorded. Nobody can write the table directly (touch_presence only).
--  * report_employee_day: per employee and day: shift, first / last seen, WhatsApp chats opened (new conversations owned by the employee) and how many of
--    them the employee answered from the CRM, customer messages answered (count, average and median reply time), customer messages still waiting,
--    logged calls, leads created, INTERESTED customers (leads the employee moved to "qualified" that day), bookings (count and total per currency),
--    payments recorded (count and total per currency, rejected ones left out). Money is never added across currencies. A row for conversations that
--    have no owner (user_id null) is returned to people who see the whole company. Visibility follows app.report_scope(); people excluded from
--    performance are left out; conversations follow app.can_access_conversation.
-- Rollback: supabase/proposed/rollbacks/20261104000989_employee_daily_report.rollback.sql (refuses while presence rows exist)

create table public.user_presence_days (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (company_id, user_id, day),
  check (last_seen >= first_seen)
);
alter table public.user_presence_days enable row level security;
revoke all on public.user_presence_days from public, anon, authenticated;
grant select on public.user_presence_days to authenticated;
grant all on public.user_presence_days to service_role;
create policy user_presence_days_select on public.user_presence_days for select to authenticated
  using (app.has_company_access(company_id) and (user_id = (select auth.uid()) or app.is_company_manager(company_id)));

-- "I am here" signal. Cheap and idempotent; the update is skipped when the last write is less than 30 seconds old.
create or replace function public.touch_presence(p_company_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_tz text;
begin
  if v_uid is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.company_memberships m where m.company_id = p_company_id and m.user_id = v_uid and m.is_active) then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  insert into public.user_presence_days as p (company_id, user_id, day, first_seen, last_seen)
  values (p_company_id, v_uid, (now() at time zone v_tz)::date, now(), now())
  on conflict (company_id, user_id, day) do update set last_seen = now()
  where p.last_seen < now() - interval '30 seconds';
end $$;

create or replace function public.report_employee_day(p_company_id uuid, p_from date, p_to date, p_user_id uuid default null)
returns table (user_id uuid, full_name text, day date, has_shift boolean, working_day boolean, shift_starts time, shift_ends time, first_seen timestamptz, last_seen timestamptz,
               chats_opened bigint, chats_replied bigint, turns_answered bigint, turns_waiting bigint, avg_reply_seconds numeric, median_reply_seconds numeric,
               calls_logged bigint, leads_created bigint, interested_leads bigint,
               bookings_count bigint, bookings_amounts jsonb, payments_count bigint, payments_amounts jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_tz text; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with staff as (
    select u.user_id as uid, u.full_name as nm from app.report_users(p_company_id, null) u where p_user_id is null or u.user_id = p_user_id
    union all
    select null::uuid, null::text where v_scope.see_all and p_user_id is null
  ),
  convs as (
    select c.id, c.owner_id, c.created_at from public.conversations c
    where c.company_id = p_company_id and not c.is_simulated and (v_scope.see_all or app.can_access_conversation(c.id))
  ),
  msgs as (
    select m.conversation_id, m.direction, m.sent_at, m.sent_by, m.created_at,
           lag(m.direction) over (partition by m.conversation_id order by m.sent_at, m.created_at) as prev_dir
    from public.messages m join convs c on c.id = m.conversation_id where not m.is_simulated and m.status <> 'failed'
  ),
  turns as (
    select m.conversation_id, m.sent_at as asked_at from msgs m
    where m.direction = 'inbound' and (m.prev_dir is null or m.prev_dir = 'outbound') and m.sent_at >= t0 and m.sent_at < t1
  ),
  answered as (
    select t.conversation_id, t.asked_at, r.sent_at as answered_at, r.sent_by
    from turns t left join lateral (
      select o.sent_at, o.sent_by from msgs o where o.conversation_id = t.conversation_id and o.direction = 'outbound' and o.sent_at >= t.asked_at
      order by o.sent_at, o.created_at limit 1) r on true
  ),
  ev as (
    -- plain counts: kind, owner, instant
    select c.owner_id as uid, c.created_at as ts, 'chat'::text as kind, null::numeric as qty, null::text as cur, null::numeric as secs from convs c
      where c.created_at >= t0 and c.created_at < t1
    union all select c.owner_id, c.created_at, 'chat_replied', null, null, null from convs c
      where c.created_at >= t0 and c.created_at < t1 and c.owner_id is not null
        and exists (select 1 from msgs m where m.conversation_id = c.id and m.direction = 'outbound' and m.sent_by = c.owner_id)
    union all select a.sent_by, a.asked_at, 'turn_answered', null, null, extract(epoch from a.answered_at - a.asked_at)
      from answered a where a.answered_at is not null and a.sent_by is not null
    union all select c.owner_id, a.asked_at, 'turn_waiting', null, null, null
      from answered a join convs c on c.id = a.conversation_id where a.answered_at is null
    union all select a.actor_id, a.occurred_at, 'call', null, null, null from public.activities a
      where a.company_id = p_company_id and a.type = 'call' and a.occurred_at >= t0 and a.occurred_at < t1
    union all select l.created_by, l.created_at, 'lead', null, null, null from public.leads l
      where l.company_id = p_company_id and l.created_at >= t0 and l.created_at < t1
    union all select h.changed_by, h.created_at, 'interested', null, null, null
      from (select distinct on (x.lead_id, (x.created_at at time zone v_tz)::date) x.* from public.lead_status_history x
            where x.company_id = p_company_id and x.to_status = 'qualified' and x.created_at >= t0 and x.created_at < t1
            order by x.lead_id, (x.created_at at time zone v_tz)::date, x.created_at) h
    union all select b.created_by, b.created_at, 'booking', b.final_price, b.currency::text, null from public.workshop_bookings b
      where b.company_id = p_company_id and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1
    union all select p.created_by, p.created_at, 'payment', p.amount, p.currency::text, null from public.payments p
      where p.company_id = p_company_id and p.status <> 'rejected' and p.created_at >= t0 and p.created_at < t1
  ),
  ev2 as (select e.*, (e.ts at time zone v_tz)::date as d from ev e),
  money as (
    select e.uid, e.d, e.kind, e.cur, sum(e.qty) as total, count(*) as n from ev2 e where e.kind in ('booking', 'payment') group by e.uid, e.d, e.kind, e.cur
  ),
  agg as (
    select e.uid, e.d,
      count(*) filter (where e.kind = 'chat') as chats, count(*) filter (where e.kind = 'chat_replied') as chats_r,
      count(*) filter (where e.kind = 'turn_answered') as t_ans, count(*) filter (where e.kind = 'turn_waiting') as t_wait,
      round(avg(e.secs) filter (where e.kind = 'turn_answered'), 0) as avg_s,
      round((percentile_cont(0.5) within group (order by e.secs) filter (where e.kind = 'turn_answered'))::numeric, 0) as med_s,
      count(*) filter (where e.kind = 'call') as calls, count(*) filter (where e.kind = 'lead') as leads, count(*) filter (where e.kind = 'interested') as interested
    from ev2 e group by e.uid, e.d
  ),
  mon as (
    select m.uid, m.d,
      coalesce(sum(m.n) filter (where m.kind = 'booking'), 0) as b_n,
      coalesce(jsonb_object_agg(m.cur, m.total) filter (where m.kind = 'booking'), '{}'::jsonb) as b_amt,
      coalesce(sum(m.n) filter (where m.kind = 'payment'), 0) as p_n,
      coalesce(jsonb_object_agg(m.cur, m.total) filter (where m.kind = 'payment'), '{}'::jsonb) as p_amt
    from money m group by m.uid, m.d
  ),
  grid as (
    select st.uid, st.nm, g.d::date as d from staff st cross join generate_series(p_from, p_to, interval '1 day') g(d)
  ),
  j as (
    select gr.uid, gr.nm, gr.d,
           gr.uid is not null and exists (select 1 from public.employee_shifts s where s.company_id = p_company_id and s.user_id = gr.uid
                                          and s.effective_from <= gr.d and (s.effective_to is null or s.effective_to >= gr.d)) as covered,
           gr.uid is not null and (app.shift_starting_on(p_company_id, gr.uid, gr.d)).id is not null as working,
           case when gr.uid is null then null else (app.shift_starting_on(p_company_id, gr.uid, gr.d)).starts_at end as s_start,
           case when gr.uid is null then null else (app.shift_starting_on(p_company_id, gr.uid, gr.d)).ends_at end as s_end,
           pr.first_seen as fs, pr.last_seen as ls,
           coalesce(ag.chats, 0) as chats, coalesce(ag.chats_r, 0) as chats_r, coalesce(ag.t_ans, 0) as t_ans, coalesce(ag.t_wait, 0) as t_wait,
           ag.avg_s, ag.med_s, coalesce(ag.calls, 0) as calls, coalesce(ag.leads, 0) as leads, coalesce(ag.interested, 0) as interested,
           coalesce(mo.b_n, 0)::bigint as b_n, coalesce(mo.b_amt, '{}'::jsonb) as b_amt, coalesce(mo.p_n, 0)::bigint as p_n, coalesce(mo.p_amt, '{}'::jsonb) as p_amt
    from grid gr
    left join agg ag on ag.uid is not distinct from gr.uid and ag.d = gr.d
    left join mon mo on mo.uid is not distinct from gr.uid and mo.d = gr.d
    left join public.user_presence_days pr on pr.company_id = p_company_id and pr.user_id = gr.uid and pr.day = gr.d
  )
  select j.uid, j.nm, j.d, j.covered, j.working, j.s_start, j.s_end, j.fs, j.ls, j.chats, j.chats_r, j.t_ans, j.t_wait, j.avg_s, j.med_s,
         j.calls, j.leads, j.interested, j.b_n, j.b_amt, j.p_n, j.p_amt
  from j
  where j.working or j.fs is not null
     or j.chats + j.t_ans + j.t_wait + j.calls + j.leads + j.interested + j.b_n + j.p_n > 0
  order by (j.uid is null), j.nm, j.d;
end $$;

revoke all on function public.touch_presence(uuid), public.report_employee_day(uuid, date, date, uuid) from public, anon;
grant execute on function public.touch_presence(uuid), public.report_employee_day(uuid, date, date, uuid) to authenticated, service_role;
