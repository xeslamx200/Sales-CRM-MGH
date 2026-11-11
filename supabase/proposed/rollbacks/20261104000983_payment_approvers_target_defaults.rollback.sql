-- ROLLBACK of 20261104000983. Restores review_payment (migration 980) and report_monthly_commission (migration 981) exactly, then drops the new
-- objects. Refuses to run while any company has a payment approval policy or any default target (that would silently change who can approve
-- payments / who has a target): clear them first with clear_payment_approval_policy / set_target_default(…, NULL). Run with psql -1.
do $$ begin
  if exists (select 1 from public.payment_approval_policy) then raise exception 'rollback refused: a payment approval policy exists (clear_payment_approval_policy first)'; end if;
  if exists (select 1 from public.performance_exclusions) then raise exception 'rollback refused: performance exclusions exist (set_performance_exclusion(company, user, false) first)'; end if;
  if exists (select 1 from public.monthly_target_defaults) then raise exception 'rollback refused: default targets exist (set_target_default(company, user, NULL) first)'; end if;
end $$;

drop function public.report_monthly_commission(uuid, date);
create function public.report_monthly_commission(p_company_id uuid, p_month date default current_date)
returns table (user_id uuid, full_name text, target_amount numeric, achieved_amount numeric, pending_amount numeric, amount_attainment numeric,
               target_customers numeric, achieved_customers bigint, customers_attainment numeric, tier_min numeric, rate numeric, commission_egp numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_d0 date; v_d1 date; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  -- same scope as the other reports: no row for a sandbox company (nothing is reported for it)
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  v_d0 := date_trunc('month', coalesce(p_month, current_date))::date;
  v_d1 := (v_d0 + interval '1 month' - interval '1 day')::date;
  return query
  with people as (
    select cm.user_id as uid from public.company_memberships cm
      where cm.company_id = p_company_id and cm.is_active and cm.role in ('sales_agent', 'cs_agent', 'sales_manager')
    union select st.user_id from public.sales_targets st
      where st.company_id = p_company_id and st.user_id is not null and st.metric in ('collected_egp', 'paid_customers')
        and st.period_start = v_d0 and st.period_end = v_d1
    union select p.created_by from public.payments p
      where p.company_id = p_company_id and p.paid_on between v_d0 and v_d1 and p.status in ('confirmed', 'pending')
  ), visible as (
    select pe.uid from people pe where v_scope.see_all or pe.uid = auth.uid() or pe.uid = any (v_scope.owners)
  ), base as (
    select v.uid,
      (select st.target_value from public.sales_targets st where st.company_id = p_company_id and st.user_id = v.uid
         and st.metric = 'collected_egp' and st.period_start = v_d0 and st.period_end = v_d1) as t_amt,
      (select st.target_value from public.sales_targets st where st.company_id = p_company_id and st.user_id = v.uid
         and st.metric = 'paid_customers' and st.period_start = v_d0 and st.period_end = v_d1) as t_cus,
      (select coalesce(sum(p.amount_egp), 0) from public.payments p where p.company_id = p_company_id and p.created_by = v.uid
         and p.status = 'confirmed' and p.paid_on between v_d0 and v_d1) as a_amt,
      (select coalesce(sum(p.amount_egp), 0) from public.payments p where p.company_id = p_company_id and p.created_by = v.uid
         and p.status = 'pending' and p.paid_on between v_d0 and v_d1) as pend,
      (select count(distinct p.contact_id) from public.payments p where p.company_id = p_company_id and p.created_by = v.uid
         and p.status = 'confirmed' and p.paid_on between v_d0 and v_d1) as a_cus
    from visible v
  ), att as (
    select b.*, case when b.t_amt > 0 then round(b.a_amt / b.t_amt, 4) end as att_amt,
           case when b.t_cus > 0 then round(b.a_cus::numeric / b.t_cus, 4) end as att_cus
    from base b
  )
  select a.uid, coalesce(nullif(btrim(pr.full_name), ''), pr.email), a.t_amt, a.a_amt, a.pend, a.att_amt, a.t_cus, a.a_cus, a.att_cus,
         tier.min_attainment, coalesce(tier.rate, 0), round(a.a_amt * coalesce(tier.rate, 0), 2)
  from att a
  join public.profiles pr on pr.id = a.uid
  left join lateral (
    select ct.min_attainment, ct.rate from public.commission_tiers ct
    where ct.company_id = p_company_id and a.att_amt is not null and ct.min_attainment <= a.att_amt
    order by ct.min_attainment desc limit 1
  ) tier on true
  order by a.a_amt desc, 2;
end $$;
revoke all on function public.report_monthly_commission(uuid, date) from public, anon;
grant execute on function public.report_monthly_commission(uuid, date) to authenticated, service_role;

create or replace function public.review_payment(p_id uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); p public.payments;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_decision not in ('confirmed', 'rejected') then raise exception 'payment.invalid_decision' using errcode = '23514'; end if;
  select * into p from public.payments where id = p_id for update;
  if not found or not app.is_company_manager(p.company_id) then raise exception 'payment.not_found' using errcode = 'P0002'; end if;
  if p.created_by = v_uid and not app.is_company_admin(p.company_id) then raise exception 'payment.cannot_review_own' using errcode = '42501'; end if;
  if p.status = 'rejected' or (p.status = 'confirmed' and (p_decision <> 'rejected' or not app.is_company_admin(p.company_id))) then
    raise exception 'payment.invalid_transition' using errcode = '23514';
  end if;
  if p_decision = 'rejected' and (p_note is null or btrim(p_note) = '') then raise exception 'payment.reason_required' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  perform set_config('app.payment_review', 'on', true);
  update public.payments set status = p_decision, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '') where id = p_id;
  perform set_config('app.payment_review', '', true);
  perform app.write_audit(p.company_id, 'payment.' || p_decision, 'payment', p.id, jsonb_build_object('from', p.status));
end $$;

drop function public.set_performance_exclusion(uuid, uuid, boolean, text);
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
drop table public.performance_exclusions;
drop function public.set_target_default(uuid, uuid, numeric);
drop function public.clear_payment_approval_policy(uuid);
drop function public.set_payment_approvers(uuid, uuid[]);
drop function public.can_review_payments(uuid);
drop function app.can_review_payments(uuid);
drop table public.monthly_target_defaults;
drop table public.payment_approvers;
drop table public.payment_approval_policy;
