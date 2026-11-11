-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000983 - (1) who may approve / reject payments, enforced in the database; (2) default monthly targets by role / person;
--                  (3) commission tier chosen on the EXACT attainment (no rounding up across a threshold).
-- No existing row is changed. Companies that do nothing after this migration behave exactly as before.
--
-- 1. Payment approvers. A company is "restricted" when it has a row in payment_approval_policy; from then on ONLY the people listed in
--    payment_approvers may approve or reject its payments (pending -> confirmed | rejected, and confirmed -> rejected with a reason).
--    Company admins, sales managers and super admins who are not on the list are refused by review_payment itself (the UI only hides buttons).
--    Restricted is fail-closed: an empty list means nobody can review until an admin sets it again. An unrestricted company keeps the
--    migration-980 rule (managers review; confirmed -> rejected by company admins). Listing and unlisting is done by company admins / super
--    admins with set_payment_approvers / clear_payment_approval_policy and is audited. Approvers must be active managers of the company so that
--    row-level security lets them see the payments they review.
-- 2. Default targets. monthly_target_defaults holds an amount in EGP for the company (user_id NULL: applies to every active sales_agent) or for
--    one person (any role, e.g. a team leader). report_monthly_commission uses, in order: the explicit target of that month (set_monthly_target),
--    the person's default, the company default for sales agents. Nobody else gets a target.
-- 3. report_monthly_commission: the tier is the highest one whose threshold the exact ratio reaches (collected >= threshold x target); the shown
--    attainment is truncated, never rounded up (89.995 % is displayed 89.99 % and pays the 80 % tier). Commission is still computed, never stored,
--    from CONFIRMED payments only (pending / rejected / estimates of deals never count). Payments carry no discount yet, so the amount used is the
--    confirmed amount as recorded; when discounts exist the price is net of them and this function needs no change because it sums money received.
-- 4. Performance exclusions (test accounts, non-sales staff). performance_exclusions lists people who are left OUT of sales performance:
--    report_monthly_commission (targets, attainment, ranking, commission) and report_employee_performance (through app.report_users) skip them.
--    Nothing is deleted or changed: their payments, leads, messages and history stay exactly as they are and remain visible everywhere else
--    (payments list, inbox, company-wide KPIs). Removing the row brings them back. Company admins only, audited (set_performance_exclusion).
-- Rollback: supabase/proposed/rollbacks/20261104000983_payment_approvers_target_defaults.rollback.sql

-- ------------------------------------------------------------------ 1. approvers
create table public.payment_approval_policy (
  company_id uuid primary key references public.companies (id) on delete cascade,
  enabled_by uuid references public.profiles (id) on delete set null,
  enabled_at timestamptz not null default now()
);
create table public.payment_approvers (
  company_id uuid not null references public.payment_approval_policy (company_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
alter table public.payment_approval_policy enable row level security;
alter table public.payment_approvers enable row level security;
revoke all on public.payment_approval_policy, public.payment_approvers from public, anon, authenticated;
grant select on public.payment_approval_policy, public.payment_approvers to authenticated;
grant all on public.payment_approval_policy, public.payment_approvers to service_role;
create policy payment_approval_policy_select on public.payment_approval_policy for select to authenticated using (app.is_company_manager(company_id));
create policy payment_approvers_select on public.payment_approvers for select to authenticated using (app.is_company_manager(company_id));

-- May the caller approve / reject payments of this company? (also used by the UI to show or hide the buttons)
create or replace function app.can_review_payments(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null or not app.is_active_user() then false
    when exists (select 1 from public.payment_approval_policy pol where pol.company_id = p_company_id) then
      exists (select 1 from public.payment_approvers a
              join public.company_memberships cm on cm.company_id = a.company_id and cm.user_id = a.user_id and cm.is_active
              where a.company_id = p_company_id and a.user_id = auth.uid())
    else app.is_company_manager(p_company_id)
  end
$$;
create or replace function public.can_review_payments(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select app.can_review_payments(p_company_id) $$;

-- Replace the approver list (and switch the company to restricted). Company admins / super admins only.
create or replace function public.set_payment_approvers(p_company_id uuid, p_user_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_n int;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select array_agg(distinct u) into v_ids from unnest(p_user_ids) u where u is not null;
  v_n := coalesce(cardinality(v_ids), 0);
  if v_n < 1 or v_n > 10 then raise exception 'approver.invalid_list' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_ids) u where not exists (
       select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = u and cm.is_active
         and cm.role in ('company_admin', 'sales_manager'))) then
    raise exception 'approver.invalid_user' using errcode = '23514';
  end if;
  insert into public.payment_approval_policy (company_id, enabled_by) values (p_company_id, auth.uid()) on conflict (company_id) do nothing;
  delete from public.payment_approvers where company_id = p_company_id;
  insert into public.payment_approvers (company_id, user_id, added_by) select p_company_id, u, auth.uid() from unnest(v_ids) u;
  perform app.write_audit(p_company_id, 'payment.approvers_set', 'company', p_company_id, jsonb_build_object('approvers', to_jsonb(v_ids)));
  return v_n;
end $$;

-- Back to the migration-980 rule (managers review). Company admins / super admins only; audited.
create or replace function public.clear_payment_approval_policy(p_company_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  delete from public.payment_approval_policy where company_id = p_company_id;
  perform app.write_audit(p_company_id, 'payment.approval_policy_cleared', 'company', p_company_id, '{}'::jsonb);
end $$;

-- review_payment: identical to migration 980 for unrestricted companies; restricted companies require the caller to be a listed approver.
create or replace function public.review_payment(p_id uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); p public.payments; v_restricted boolean;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_decision not in ('confirmed', 'rejected') then raise exception 'payment.invalid_decision' using errcode = '23514'; end if;
  select * into p from public.payments where id = p_id for update;
  if not found then raise exception 'payment.not_found' using errcode = 'P0002'; end if;
  v_restricted := exists (select 1 from public.payment_approval_policy pol where pol.company_id = p.company_id);
  if v_restricted then
    if not app.can_review_payments(p.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  elsif not app.is_company_manager(p.company_id) then
    raise exception 'payment.not_found' using errcode = 'P0002';
  end if;
  if p.created_by = v_uid and not app.is_company_admin(p.company_id) then raise exception 'payment.cannot_review_own' using errcode = '42501'; end if;
  if p.status = 'rejected'
     or (p.status = 'confirmed' and (p_decision <> 'rejected' or not (v_restricted or app.is_company_admin(p.company_id)))) then
    raise exception 'payment.invalid_transition' using errcode = '23514';
  end if;
  if p_decision = 'rejected' and (p_note is null or btrim(p_note) = '') then raise exception 'payment.reason_required' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  perform set_config('app.payment_review', 'on', true);
  update public.payments set status = p_decision, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '') where id = p_id;
  perform set_config('app.payment_review', '', true);
  perform app.write_audit(p.company_id, 'payment.' || p_decision, 'payment', p.id, jsonb_build_object('from', p.status, 'restricted_policy', v_restricted));
end $$;

-- ------------------------------------------------------------------ 2. default targets
create table public.monthly_target_defaults (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  amount_egp numeric(14, 2) not null check (amount_egp > 0 and amount_egp <= 1000000000),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index monthly_target_defaults_company_uq on public.monthly_target_defaults (company_id) where user_id is null;
create unique index monthly_target_defaults_user_uq on public.monthly_target_defaults (company_id, user_id) where user_id is not null;
alter table public.monthly_target_defaults enable row level security;
revoke all on public.monthly_target_defaults from public, anon, authenticated;
grant select on public.monthly_target_defaults to authenticated;
grant all on public.monthly_target_defaults to service_role;
create policy monthly_target_defaults_select on public.monthly_target_defaults for select to authenticated using (app.is_company_manager(company_id));

-- p_user_id NULL = the default for every active sales agent of the company; NULL / 0 amount removes the default. Company admins only.
create or replace function public.set_target_default(p_company_id uuid, p_user_id uuid, p_amount_egp numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_user_id is not null and not exists (select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.is_active) then
    raise exception 'target.invalid_user' using errcode = '23514';
  end if;
  if p_amount_egp is not null and (p_amount_egp < 0 or p_amount_egp > 1000000000 or p_amount_egp <> round(p_amount_egp, 2)) then
    raise exception 'target.invalid_value' using errcode = '23514';
  end if;
  delete from public.monthly_target_defaults d where d.company_id = p_company_id and d.user_id is not distinct from p_user_id;
  if p_amount_egp is not null and p_amount_egp > 0 then
    insert into public.monthly_target_defaults (company_id, user_id, amount_egp, updated_by) values (p_company_id, p_user_id, p_amount_egp, auth.uid());
  end if;
  perform app.write_audit(p_company_id, 'target.default_set', 'company', p_company_id, jsonb_build_object('user_id', p_user_id, 'amount_egp', p_amount_egp));
end $$;

-- ------------------------------------------------------------------ 2b. performance exclusions
create table public.performance_exclusions (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason text check (reason is null or length(reason) <= 300),
  excluded_by uuid references public.profiles (id) on delete set null,
  excluded_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
alter table public.performance_exclusions enable row level security;
revoke all on public.performance_exclusions from public, anon, authenticated;
grant select on public.performance_exclusions to authenticated;
grant all on public.performance_exclusions to service_role;
create policy performance_exclusions_select on public.performance_exclusions for select to authenticated using (app.is_company_manager(company_id));

create or replace function public.set_performance_exclusion(p_company_id uuid, p_user_id uuid, p_excluded boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_user_id is null or not exists (select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = p_user_id) then
    raise exception 'target.invalid_user' using errcode = '23514';
  end if;
  if p_reason is not null and length(p_reason) > 300 then raise exception 'target.invalid_value' using errcode = '23514'; end if;
  delete from public.performance_exclusions where company_id = p_company_id and user_id = p_user_id;
  if coalesce(p_excluded, true) then
    insert into public.performance_exclusions (company_id, user_id, reason, excluded_by) values (p_company_id, p_user_id, nullif(btrim(p_reason), ''), auth.uid());
  end if;
  perform app.write_audit(p_company_id, 'performance.exclusion_set', 'profile', p_user_id, jsonb_build_object('excluded', coalesce(p_excluded, true), 'reason', p_reason));
end $$;

-- employees report: same body as migration 0700 plus the exclusion filter
create or replace function app.report_users(p_company_id uuid, p_team_id uuid default null)
returns table (user_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(nullif(p.full_name, ''), p.email, '')
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
  join app.report_scope() s on s.company_id = m.company_id
  where m.company_id = p_company_id and m.is_active
    and (s.see_all or p.id = any (s.owners))
    and not exists (select 1 from public.performance_exclusions x where x.company_id = m.company_id and x.user_id = p.id)
    and (p_team_id is null or exists (
      select 1 from public.team_memberships tm where tm.team_id = p_team_id and tm.user_id = p.id))
$$;

-- ------------------------------------------------------------------ 3. commission report (new column target_source; exact tier)
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

revoke all on function app.can_review_payments(uuid), public.can_review_payments(uuid), public.set_payment_approvers(uuid, uuid[]),
  public.clear_payment_approval_policy(uuid), public.set_target_default(uuid, uuid, numeric), public.set_performance_exclusion(uuid, uuid, boolean, text),
  public.report_monthly_commission(uuid, date) from public, anon;
grant execute on function app.can_review_payments(uuid), public.can_review_payments(uuid), public.set_payment_approvers(uuid, uuid[]),
  public.clear_payment_approval_policy(uuid), public.set_target_default(uuid, uuid, numeric), public.set_performance_exclusion(uuid, uuid, boolean, text),
  public.report_monthly_commission(uuid, date) to authenticated, service_role;
