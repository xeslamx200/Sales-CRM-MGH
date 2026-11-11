-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000990 - Dashboard figures from workshop bookings and payments (instead of Deals): report_workshop_kpis and report_workshop_breakdown.
-- Purely additive and read-only: three functions; no table, row or existing function is changed.
--
--  * report_workshop_kpis(company, from, to, user): first row (currency null) = counts of the period: bookings (booked, created in the period), cancelled
--    (cancelled in the period), customers (distinct people booked), leads created, leads that already have a booking. Then one row PER CURRENCY:
--    bookings, list_value (prices before discounts), discount_total, booked_value (what the customers owe after approved discounts = the net revenue
--    booked), collected (CONFIRMED payments dated in the period), pending (payments awaiting approval, dated in the period), remaining (snapshot, all
--    active bookings: final price minus confirmed money). Money is never added across currencies. There are no cost figures in the CRM, so nothing
--    here is a profit: it is revenue (booked and collected).
--  * report_workshop_daily: per day and currency, bookings, booked value and confirmed money collected (the daily revenue chart).
--  * report_workshop_breakdown: the same per workshop and currency (bookings and booked value of the period, collected in the period, remaining now).
--  Visibility follows app.report_scope(): the company for admins / managers, one's own bookings and payments (created_by) for agents. Rejected payments and
--  cancelled bookings never count as revenue. Pending and rejected discounts never changed a price, so booked_value is already net of approved discounts only.
-- Rollback: supabase/proposed/rollbacks/20261104000990_workshop_dashboard.rollback.sql

create or replace function public.report_workshop_kpis(p_company_id uuid, p_from date, p_to date, p_user_id uuid default null)
returns table (currency text, bookings bigint, cancelled bigint, customers bigint, list_value numeric, discount_total numeric, booked_value numeric,
               collected numeric, pending numeric, remaining numeric, leads_created bigint, leads_booked bigint)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with b as (
    select x.* from public.workshop_bookings x
    where x.company_id = p_company_id and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
  ),
  pay as (
    select x.* from public.payments x
    where x.company_id = p_company_id and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
  ),
  lc as (
    select l.* from public.leads l
    where l.company_id = p_company_id and l.created_at >= t0 and l.created_at < t1
      and (v_scope.see_all or l.created_by = any (v_scope.owners)) and (p_user_id is null or l.created_by = p_user_id)
  ),
  money as (
    select k.cur,
      (select count(*) from b where b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1) as n_book,
      (select coalesce(sum(b.list_price), 0) from b where b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1) as list_v,
      (select coalesce(sum(b.discount_amount), 0) from b where b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1) as disc_v,
      (select coalesce(sum(b.final_price), 0) from b where b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1) as final_v,
      (select coalesce(sum(p.amount), 0) from pay p where p.currency::text = k.cur and p.status = 'confirmed' and p.paid_on between p_from and p_to) as coll,
      (select coalesce(sum(p.amount), 0) from pay p where p.currency::text = k.cur and p.status = 'pending' and p.paid_on between p_from and p_to) as pend,
      (select coalesce(sum(b.final_price - least(coalesce((select sum(p.amount) from public.payments p where p.booking_id = b.id and p.status = 'confirmed'), 0), b.final_price)), 0)
         from b where b.currency::text = k.cur and b.status = 'booked') as rem
    from (select b.currency::text as cur from b union select p.currency::text from pay p) k
  )
  select null::text, (select count(*) from b where b.status = 'booked' and b.created_at >= t0 and b.created_at < t1),
         (select count(*) from b where b.status = 'cancelled' and b.cancelled_at >= t0 and b.cancelled_at < t1),
         (select count(distinct b.contact_id) from b where b.status = 'booked' and b.created_at >= t0 and b.created_at < t1),
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         (select count(*) from lc),
         (select count(*) from lc where exists (select 1 from public.workshop_bookings x where x.contact_id = lc.contact_id and x.company_id = p_company_id and x.status = 'booked'))
  union all
  select m.cur, m.n_book, null::bigint, null::bigint, m.list_v, m.disc_v, m.final_v, m.coll, m.pend, m.rem, null::bigint, null::bigint
  from money m
  order by 1 nulls first;
end $$;

create or replace function public.report_workshop_breakdown(p_company_id uuid, p_from date, p_to date, p_user_id uuid default null)
returns table (offering_id uuid, offering_name text, currency text, bookings bigint, booked_value numeric, collected numeric, remaining numeric)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with b as (
    select x.* from public.workshop_bookings x
    where x.company_id = p_company_id and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
  ),
  pay as (
    select x.* from public.payments x
    where x.company_id = p_company_id and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
  ),
  keys as (select b.offering_id as oid, b.currency::text as cur from b union select p.offering_id, p.currency::text from pay p)
  select k.oid, o.name, k.cur,
    (select count(*) from b where b.offering_id = k.oid and b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1),
    (select coalesce(sum(b.final_price), 0) from b where b.offering_id = k.oid and b.currency::text = k.cur and b.status = 'booked' and b.created_at >= t0 and b.created_at < t1),
    (select coalesce(sum(p.amount), 0) from pay p where p.offering_id = k.oid and p.currency::text = k.cur and p.status = 'confirmed' and p.paid_on between p_from and p_to),
    (select coalesce(sum(b.final_price - least(coalesce((select sum(p.amount) from public.payments p where p.booking_id = b.id and p.status = 'confirmed'), 0), b.final_price)), 0)
       from b where b.offering_id = k.oid and b.currency::text = k.cur and b.status = 'booked')
  from keys k join public.company_offerings o on o.id = k.oid
  order by o.name, k.cur;
end $$;

-- Per day and currency: bookings made, their net value and the confirmed money collected (payment date) - the daily revenue chart.
create or replace function public.report_workshop_daily(p_company_id uuid, p_from date, p_to date, p_user_id uuid default null)
returns table (day date, currency text, bookings bigint, booked_value numeric, collected numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_scope record; v_tz text;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  return query
  with b as (
    select (x.created_at at time zone v_tz)::date as d, x.currency::text as cur, x.final_price from public.workshop_bookings x
    where x.company_id = p_company_id and x.status = 'booked' and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
      and (x.created_at at time zone v_tz)::date between p_from and p_to
  ),
  pay as (
    select x.paid_on as d, x.currency::text as cur, x.amount from public.payments x
    where x.company_id = p_company_id and x.status = 'confirmed' and (v_scope.see_all or x.created_by = any (v_scope.owners)) and (p_user_id is null or x.created_by = p_user_id)
      and x.paid_on between p_from and p_to
  ),
  keys as (select b.d, b.cur from b union select pay.d, pay.cur from pay)
  select k.d, k.cur, (select count(*) from b where b.d = k.d and b.cur = k.cur), (select coalesce(sum(b.final_price), 0) from b where b.d = k.d and b.cur = k.cur),
         (select coalesce(sum(pay.amount), 0) from pay where pay.d = k.d and pay.cur = k.cur)
  from keys k order by k.d, k.cur;
end $$;

revoke all on function public.report_workshop_kpis(uuid, date, date, uuid), public.report_workshop_breakdown(uuid, date, date, uuid), public.report_workshop_daily(uuid, date, date, uuid) from public, anon;
grant execute on function public.report_workshop_kpis(uuid, date, date, uuid), public.report_workshop_breakdown(uuid, date, date, uuid), public.report_workshop_daily(uuid, date, date, uuid) to authenticated, service_role;
