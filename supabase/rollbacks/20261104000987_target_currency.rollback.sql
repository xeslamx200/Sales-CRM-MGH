-- ROLLBACK of 20261104000987. Restores report_monthly_commission (migration 983) and report_target_progress (migration 981) exactly, then drops the new
-- objects. REFUSES while any company has a target-currency setting: removing it would silently change what its targets and commissions mean.
-- To go back on purpose, first run set_company_target_currency(company, 'EGP') for every such company (that removes the row). Run with psql -1.
do $$ begin
  if exists (select 1 from public.company_target_settings) then raise exception 'rollback refused: a company has a target currency (set it back to EGP first)'; end if;
end $$;

drop function public.report_monthly_commission(uuid, date);
create function public.report_monthly_commission(p_company_id uuid, p_month date default current_date)
returns table (user_id uuid, full_name text, target_amount numeric, achieved_amount numeric, pending_amount numeric, amount_attainment numeric,
               target_customers numeric, achieved_customers bigint, customers_attainment numeric, tier_min numeric, rate numeric, commission_egp numeric,
               target_source text)
language plpgsql stable security definer set search_path = '' as $$
declare v_d0 date; v_d1 date; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
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
    union select d.user_id from public.monthly_target_defaults d where d.company_id = p_company_id and d.user_id is not null
    union select p.created_by from public.payments p
      where p.company_id = p_company_id and p.paid_on between v_d0 and v_d1 and p.status in ('confirmed', 'pending')
  ), visible as (
    select pe.uid from people pe where (v_scope.see_all or pe.uid = auth.uid() or pe.uid = any (v_scope.owners))
      and not exists (select 1 from public.performance_exclusions x where x.company_id = p_company_id and x.user_id = pe.uid)
  ), base as (
    select v.uid,
      (select st.target_value from public.sales_targets st where st.company_id = p_company_id and st.user_id = v.uid
         and st.metric = 'collected_egp' and st.period_start = v_d0 and st.period_end = v_d1) as t_month,
      (select d.amount_egp from public.monthly_target_defaults d where d.company_id = p_company_id and d.user_id = v.uid) as t_user,
      (select d.amount_egp from public.monthly_target_defaults d where d.company_id = p_company_id and d.user_id is null
         and exists (select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = v.uid and cm.is_active and cm.role = 'sales_agent')) as t_company,
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
    select b.*, coalesce(b.t_month, b.t_user, b.t_company) as t_amt,
           case when b.t_month is not null then 'month' when b.t_user is not null then 'user_default' when b.t_company is not null then 'company_default' end as src
    from base b
  ), att2 as (
    select a.*, case when a.t_amt > 0 then trunc(a.a_amt / a.t_amt, 4) end as att_amt,
           case when a.t_cus > 0 then trunc(a.a_cus::numeric / a.t_cus, 4) end as att_cus
    from att a
  )
  select a.uid, coalesce(nullif(btrim(pr.full_name), ''), pr.email), a.t_amt, a.a_amt, a.pend, a.att_amt, a.t_cus, a.a_cus, a.att_cus,
         tier.min_attainment, coalesce(tier.rate, 0), round(a.a_amt * coalesce(tier.rate, 0), 2), a.src
  from att2 a
  join public.profiles pr on pr.id = a.uid
  left join lateral (
    select ct.min_attainment, ct.rate from public.commission_tiers ct
    where ct.company_id = p_company_id and a.t_amt > 0 and a.a_amt >= ct.min_attainment * a.t_amt
    order by ct.min_attainment desc limit 1
  ) tier on true
  order by a.a_amt desc, 2;
end $$;
revoke all on function public.report_monthly_commission(uuid, date) from public, anon;
grant execute on function public.report_monthly_commission(uuid, date) to authenticated, service_role;

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
           app.period_start(st.company_id, st.period_end + 1) as t1,
           -- Actuals are shown only when everyone counted is within the
           -- caller's report scope (same rule as the other reports).
           coalesce(v_scope.see_all
            or st.user_id = any (v_scope.owners)
            or (st.team_id is not null and app.manages_team(p_company_id, st.team_id)), false) as in_scope
    from public.sales_targets st
    where st.company_id = p_company_id and p_on between st.period_start and st.period_end
      and (v_scope.see_all
           or st.user_id = any (v_scope.owners)
           or (st.user_id is null and st.team_id is null)
           or (st.team_id is not null and (app.manages_team(p_company_id, st.team_id) or exists (
               select 1 from public.team_memberships tm where tm.team_id = st.team_id and tm.user_id = auth.uid()))))
  ),
  people as (
    select tg.id as tid, x.uid
    from tg cross join lateral (
      select tg.user_id as uid where tg.user_id is not null
      union all select tm.user_id from public.team_memberships tm where tm.team_id = tg.team_id
      union all select m.user_id from public.company_memberships m
                where tg.user_id is null and tg.team_id is null and m.company_id = p_company_id
    ) x
    where tg.in_scope
  ),
  actual as (
    select tg.id as tid,
      case when not tg.in_scope then null else
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
        when 'collected_egp' then (select coalesce(sum(p.amount_egp), 0) from public.payments p
          where p.company_id = p_company_id and p.status = 'confirmed'
            and p.paid_on >= tg.period_start and p.paid_on <= tg.period_end and p.created_by in (select uid from people where tid = tg.id))
        when 'paid_customers' then (select count(distinct p.contact_id) from public.payments p
          where p.company_id = p_company_id and p.status = 'confirmed'
            and p.paid_on >= tg.period_start and p.paid_on <= tg.period_end and p.created_by in (select uid from people where tid = tg.id))
      end end::numeric as v
    from tg
  )
  select tg.id, tg.metric, tg.user_id, tg.team_id, tg.period_start, tg.period_end, tg.target_value,
         a.v, case when a.v is null then null else round(a.v / tg.target_value, 4) end
  from tg join actual a on a.tid = tg.id
  order by tg.metric, tg.period_start;
end $$;

drop function app.collected_in_target_currency(uuid, uuid, text, date, date);
drop function public.set_company_target_currency(uuid, text);
drop function public.company_target_currency(uuid);
drop function app.company_target_currency(uuid);
drop table public.company_target_settings;
