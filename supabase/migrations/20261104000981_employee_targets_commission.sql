-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only after 20261104000980 and only with explicit approval; psql -1.
-- 20261104000981 - Monthly targets per employee (amount + customer count) and tiered commission.
--
--  * target_metric += collected_egp (confirmed payments recorded by the employee, EGP, by payment date) and paid_customers (distinct
--    customers with a confirmed payment). report_target_progress (0840 body + two branches) computes them, so the existing target screens work.
--  * public.commission_tiers   per company: from attainment X (of the amount target) the commission rate is R. Admins edit it through
--                              set_commission_tiers (replaces the whole list). Every member of the company can read it.
--  * public.set_monthly_target one call sets / clears an employee's two targets for a month (managers).
--  * public.report_monthly_commission(company, month)
--                              one row per employee: targets, achieved (confirmed), pending (waiting review), attainment, the tier rate and the
--                              commission = round(confirmed amount * rate of the highest tier reached, 2). The RATE applies to the WHOLE
--                              confirmed amount (not marginal slices). No amount target or no tier reached => rate 0.
--                              Same visibility as every other report (app.report_scope): company admins and super admins see every employee, a team
--                              manager sees the employees of their team plus themselves, everyone else only their own row; sandbox companies return nothing.
-- A payment that is later rejected simply drops out of the sums. Commission is computed, never stored: it always matches the payments.
-- Rollback: supabase/proposed/rollbacks/20261104000981_employee_targets_commission.rollback.sql (the two enum values stay: PostgreSQL cannot drop them).

-- ------------------------------------------------------------------ 1. metrics
alter type public.target_metric add value if not exists 'collected_egp';
alter type public.target_metric add value if not exists 'paid_customers';

-- ------------------------------------------------------------------ 2. progress (0840 body + the two new metrics)
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

-- ------------------------------------------------------------------ 3. commission tiers
create table public.commission_tiers (
  company_id uuid not null references public.companies (id) on delete cascade,
  min_attainment numeric(7, 4) not null check (min_attainment >= 0 and min_attainment <= 10),
  rate numeric(6, 4) not null check (rate >= 0 and rate <= 1),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, min_attainment)
);
alter table public.commission_tiers enable row level security;
revoke all on public.commission_tiers from public, anon, authenticated;
grant select on public.commission_tiers to authenticated;
grant all on public.commission_tiers to service_role;
create policy commission_tiers_select on public.commission_tiers for select to authenticated using (app.has_company_access(company_id));

-- Replace the whole list. p_tiers = [{"min": 0.8, "rate": 0.03}, {"min": 1, "rate": 0.06}]  (fractions: 0.8 = 80 %, 0.03 = 3 %). Company admins only.
create or replace function public.set_commission_tiers(p_company_id uuid, p_tiers jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare t record; n int := 0; v_prev numeric := -1; v_prev_rate numeric := -1;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) > 12 then raise exception 'commission.invalid_tiers' using errcode = '22023'; end if;
  -- strictly increasing attainment, never decreasing rate (a higher achievement can never pay a lower rate)
  for t in select (e ->> 'min')::numeric as m, (e ->> 'rate')::numeric as r from jsonb_array_elements(p_tiers) e order by 1 loop
    if t.m is null or t.r is null or t.m < 0 or t.m > 10 or t.r < 0 or t.r > 1 or t.m <= v_prev or t.r < v_prev_rate then
      raise exception 'commission.invalid_tiers' using errcode = '22023';
    end if;
    v_prev := t.m; v_prev_rate := t.r;
  end loop;
  delete from public.commission_tiers where company_id = p_company_id;
  for t in select (e ->> 'min')::numeric as m, (e ->> 'rate')::numeric as r from jsonb_array_elements(p_tiers) e order by 1 loop
    insert into public.commission_tiers (company_id, min_attainment, rate, updated_by) values (p_company_id, round(t.m, 4), round(t.r, 4), auth.uid());
    n := n + 1;
  end loop;
  perform app.write_audit(p_company_id, 'commission.tiers_set', 'company', p_company_id, jsonb_build_object('tiers', n));
  return n;
end $$;

-- ------------------------------------------------------------------ 4. monthly target of an employee
-- Sets (or, with NULL / 0, clears) the two targets of one employee for one calendar month. Company admins, or the team manager of the employee
-- (app.manages_user); the employee must be an active member of the company.
create or replace function public.set_monthly_target(p_company_id uuid, p_user_id uuid, p_month date, p_amount_egp numeric, p_customers numeric)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_d0 date; v_d1 date; m public.target_metric; v numeric;
begin
  if auth.uid() is null or not app.is_active_user() or not app.manages_user(p_company_id, p_user_id) then   -- company admins, or the team manager of that employee
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_month is null or not exists (select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.is_active) then
    raise exception 'target.invalid_user' using errcode = '23514';
  end if;
  if (p_amount_egp is not null and (p_amount_egp < 0 or p_amount_egp > 1000000000 or p_amount_egp <> round(p_amount_egp, 2)))
     or (p_customers is not null and (p_customers < 0 or p_customers > 100000 or p_customers <> round(p_customers))) then
    raise exception 'target.invalid_value' using errcode = '23514';
  end if;
  v_d0 := date_trunc('month', p_month)::date;
  v_d1 := (v_d0 + interval '1 month' - interval '1 day')::date;
  for m, v in select * from (values ('collected_egp'::public.target_metric, p_amount_egp), ('paid_customers'::public.target_metric, p_customers)) x(a, b) loop
    delete from public.sales_targets st where st.company_id = p_company_id and st.user_id = p_user_id and st.metric = m
      and st.period_start = v_d0 and st.period_end = v_d1;
    if v is not null and v > 0 then
      insert into public.sales_targets (company_id, user_id, metric, period_start, period_end, target_value, created_by)
      values (p_company_id, p_user_id, m, v_d0, v_d1, v, auth.uid());
    end if;
  end loop;
  perform app.write_audit(p_company_id, 'target.monthly_set', 'profile', p_user_id,
    jsonb_build_object('month', v_d0, 'amount_egp', p_amount_egp, 'customers', p_customers));
end $$;

-- ------------------------------------------------------------------ 5. performance + commission
create or replace function public.report_monthly_commission(p_company_id uuid, p_month date default current_date)
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

revoke all on function public.set_commission_tiers(uuid, jsonb), public.set_monthly_target(uuid, uuid, date, numeric, numeric),
  public.report_monthly_commission(uuid, date) from public, anon;
grant execute on function public.set_commission_tiers(uuid, jsonb), public.set_monthly_target(uuid, uuid, date, numeric, numeric),
  public.report_monthly_commission(uuid, date) to authenticated, service_role;
