-- ROLLBACK of 20261104001004: the body of migration 990. Run with psql -1.
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
