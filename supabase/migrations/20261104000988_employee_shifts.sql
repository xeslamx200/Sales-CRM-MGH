-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000988 - Working shifts of sales employees and the shift activity report (what each employee did INSIDE and OUTSIDE their shift).
-- Purely additive: one table, helper functions and read-only reporting; no existing row or function is changed.
--
--  * employee_shifts: one open shift per employee (start time, end time, weekdays, effective from / to). Changing a shift closes the previous one the day
--    before and keeps it, so past days are always judged with the shift that applied then. Times are wall-clock times in the COMPANY time zone (DST-safe);
--    an end time earlier than the start time is a shift that crosses midnight (it belongs to the day it started; its early-morning part counts inside).
--    The end is exclusive (19:00 is already outside a 10:00 - 19:00 shift).
--  * report_shift_activity: per employee and calendar day (company time zone): the shift of the day, first / last activity, and the number of activities
--    INSIDE and OUTSIDE the shift, per kind: WhatsApp replies sent by the employee, leads created, bookings created, payments recorded, logged activities
--    (calls / notes / meetings...). A working day with no activity is listed (absent); activity on a day off is entirely outside the shift. Only employees
--    that have a shift are reported; people excluded from performance (performance_exclusions) are left out; visibility follows app.report_scope().
--    Activity outside the shift is never mixed into the in-shift counts.
-- Rollback: supabase/proposed/rollbacks/20261104000988_employee_shifts.rollback.sql (refuses while any shift exists)

create table public.employee_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  starts_at time not null,
  ends_at time not null,
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),   -- ISO: 1 = Monday ... 7 = Sunday
  effective_from date not null,
  effective_to date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (starts_at <> ends_at),
  check (effective_to is null or effective_to >= effective_from)
);
create unique index employee_shifts_one_open_uq on public.employee_shifts (company_id, user_id) where effective_to is null;
create index employee_shifts_user_idx on public.employee_shifts (company_id, user_id, effective_from);
alter table public.employee_shifts enable row level security;
revoke all on public.employee_shifts from public, anon, authenticated;
grant select on public.employee_shifts to authenticated;
grant all on public.employee_shifts to service_role;
-- an employee reads their own shift; managers and admins read the company's
create policy employee_shifts_select on public.employee_shifts for select to authenticated
  using (app.has_company_access(company_id) and (user_id = (select auth.uid()) or app.is_company_manager(company_id)));

-- Set (replace) an employee's shift from a date. Company admins only; audited.
create or replace function public.set_employee_shift(p_company_id uuid, p_user_id uuid, p_starts time, p_ends time, p_weekdays smallint[], p_from date default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_from date; v_days smallint[]; v_tz text; v_prev public.employee_shifts; v_id uuid;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_user_id is null or not exists (select 1 from public.company_memberships cm where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.is_active) then
    raise exception 'shift.invalid_user' using errcode = '23514';
  end if;
  select array_agg(distinct d order by d) into v_days from unnest(p_weekdays) d where d is not null;
  if p_starts is null or p_ends is null or p_starts = p_ends or v_days is null or not (v_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]) then raise exception 'shift.invalid_value' using errcode = '23514'; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  v_from := coalesce(p_from, (now() at time zone v_tz)::date);
  select * into v_prev from public.employee_shifts where company_id = p_company_id and user_id = p_user_id and effective_to is null for update;
  if found then
    if v_prev.effective_from >= v_from then
      -- same start day: the new shift replaces the one that has not started yet / starts today
      if v_prev.effective_from > v_from then raise exception 'shift.invalid_period' using errcode = '23514'; end if;
      delete from public.employee_shifts where id = v_prev.id;
    else
      update public.employee_shifts set effective_to = v_from - 1 where id = v_prev.id;
    end if;
  end if;
  insert into public.employee_shifts (company_id, user_id, starts_at, ends_at, weekdays, effective_from, created_by)
  values (p_company_id, p_user_id, p_starts, p_ends, v_days, v_from, auth.uid()) returning id into v_id;
  perform app.write_audit(p_company_id, 'shift.set', 'profile', p_user_id,
    jsonb_build_object('starts', p_starts, 'ends', p_ends, 'weekdays', to_jsonb(v_days), 'from', v_from));
  return v_id;
end $$;

-- End an employee's shift (they are no longer reported from the day after p_to). Company admins only; audited.
create or replace function public.clear_employee_shift(p_company_id uuid, p_user_id uuid, p_to date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_to date; v_row public.employee_shifts;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  select * into v_row from public.employee_shifts where company_id = p_company_id and user_id = p_user_id and effective_to is null for update;
  if not found then raise exception 'shift.not_found' using errcode = 'P0002'; end if;
  v_to := coalesce(p_to, (now() at time zone v_tz)::date);
  if v_to < v_row.effective_from then raise exception 'shift.invalid_period' using errcode = '23514'; end if;
  update public.employee_shifts set effective_to = v_to where id = v_row.id;
  perform app.write_audit(p_company_id, 'shift.cleared', 'profile', p_user_id, jsonb_build_object('to', v_to));
end $$;

-- The shift (if any) of an employee that STARTS on a given company-local date.
create or replace function app.shift_starting_on(p_company_id uuid, p_user_id uuid, p_day date) returns public.employee_shifts
language sql stable security definer set search_path = '' as $$
  select s from public.employee_shifts s
  where s.company_id = p_company_id and s.user_id = p_user_id and s.effective_from <= p_day and (s.effective_to is null or s.effective_to >= p_day)
    and extract(isodow from p_day)::smallint = any (s.weekdays)
  limit 1
$$;

-- Is this instant inside the employee's shift? (company time zone, end exclusive, midnight-crossing shifts supported)
create or replace function app.in_shift(p_company_id uuid, p_user_id uuid, p_ts timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; l timestamp; d date; t time; s public.employee_shifts;
begin
  select timezone into v_tz from public.companies where id = p_company_id;
  l := p_ts at time zone v_tz; d := l::date; t := l::time;
  s := app.shift_starting_on(p_company_id, p_user_id, d);
  if s.id is not null and ((s.ends_at > s.starts_at and t >= s.starts_at and t < s.ends_at) or (s.ends_at < s.starts_at and t >= s.starts_at)) then return true; end if;
  s := app.shift_starting_on(p_company_id, p_user_id, d - 1);
  if s.id is not null and s.ends_at < s.starts_at and t < s.ends_at then return true; end if;
  return false;
end $$;

-- ------------------------------------------------------------------ the report
create or replace function public.report_shift_activity(p_company_id uuid, p_from date, p_to date, p_user_id uuid default null)
returns table (user_id uuid, full_name text, day date, working_day boolean, shift_starts time, shift_ends time, first_activity timestamptz, last_activity timestamptz,
               in_shift bigint, out_of_shift bigint,
               replies_in bigint, replies_out bigint, leads_in bigint, leads_out bigint, bookings_in bigint, bookings_out bigint,
               payments_in bigint, payments_out bigint, activities_in bigint, activities_out bigint)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_tz text;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  if not exists (select 1 from app.report_scope() s where s.company_id = p_company_id) then return; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with staff as (
    select u.user_id as uid, u.full_name as nm from app.report_users(p_company_id, null) u
    where (p_user_id is null or u.user_id = p_user_id)
      and exists (select 1 from public.employee_shifts s where s.company_id = p_company_id and s.user_id = u.user_id
                  and s.effective_from <= p_to and (s.effective_to is null or s.effective_to >= p_from))
  ),
  ev as (
    select m.sent_by as uid, m.sent_at as ts, 'reply'::text as kind from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.company_id = p_company_id and m.direction = 'outbound' and m.sent_by in (select uid from staff) and m.status <> 'failed' and not m.is_simulated
        and m.sent_at >= t0 and m.sent_at < t1
    union all select l.created_by, l.created_at, 'lead' from public.leads l
      where l.company_id = p_company_id and l.created_by in (select uid from staff) and l.created_at >= t0 and l.created_at < t1
    union all select b.created_by, b.created_at, 'booking' from public.workshop_bookings b
      where b.company_id = p_company_id and b.created_by in (select uid from staff) and b.created_at >= t0 and b.created_at < t1
    union all select p.created_by, p.created_at, 'payment' from public.payments p
      where p.company_id = p_company_id and p.created_by in (select uid from staff) and p.created_at >= t0 and p.created_at < t1
    union all select a.actor_id, a.occurred_at, 'activity' from public.activities a
      where a.company_id = p_company_id and a.actor_id in (select uid from staff) and a.occurred_at >= t0 and a.occurred_at < t1
  ),
  ev2 as (
    select e.uid, e.kind, e.ts, (e.ts at time zone v_tz)::date as d, app.in_shift(p_company_id, e.uid, e.ts) as inside from ev e
  ),
  agg as (
    select e.uid, e.d, min(e.ts) as first_ts, max(e.ts) as last_ts,
      count(*) filter (where e.inside) as n_in, count(*) filter (where not e.inside) as n_out,
      count(*) filter (where e.inside and e.kind = 'reply') as r_in, count(*) filter (where not e.inside and e.kind = 'reply') as r_out,
      count(*) filter (where e.inside and e.kind = 'lead') as l_in, count(*) filter (where not e.inside and e.kind = 'lead') as l_out,
      count(*) filter (where e.inside and e.kind = 'booking') as b_in, count(*) filter (where not e.inside and e.kind = 'booking') as b_out,
      count(*) filter (where e.inside and e.kind = 'payment') as p_in, count(*) filter (where not e.inside and e.kind = 'payment') as p_out,
      count(*) filter (where e.inside and e.kind = 'activity') as a_in, count(*) filter (where not e.inside and e.kind = 'activity') as a_out
    from ev2 e group by e.uid, e.d
  ),
  grid as (
    select st.uid, st.nm, g.d::date as d from staff st cross join generate_series(p_from, p_to, interval '1 day') g(d)
  ),
  j as (
    select gr.uid, gr.nm, gr.d, (app.shift_starting_on(p_company_id, gr.uid, gr.d)).id is not null as working,
           (app.shift_starting_on(p_company_id, gr.uid, gr.d)).starts_at as s_start, (app.shift_starting_on(p_company_id, gr.uid, gr.d)).ends_at as s_end,
           exists (select 1 from public.employee_shifts s where s.company_id = p_company_id and s.user_id = gr.uid and s.effective_from <= gr.d and (s.effective_to is null or s.effective_to >= gr.d)) as covered,
           ag.first_ts, ag.last_ts, ag.n_in, ag.n_out, ag.r_in, ag.r_out, ag.l_in, ag.l_out, ag.b_in, ag.b_out, ag.p_in, ag.p_out, ag.a_in, ag.a_out
    from grid gr left join agg ag on ag.uid = gr.uid and ag.d = gr.d
  )
  select j.uid, j.nm, j.d, j.working, j.s_start, j.s_end, j.first_ts, j.last_ts,
         coalesce(j.n_in, 0), coalesce(j.n_out, 0), coalesce(j.r_in, 0), coalesce(j.r_out, 0), coalesce(j.l_in, 0), coalesce(j.l_out, 0),
         coalesce(j.b_in, 0), coalesce(j.b_out, 0), coalesce(j.p_in, 0), coalesce(j.p_out, 0), coalesce(j.a_in, 0), coalesce(j.a_out, 0)
  from j
  where (j.working or coalesce(j.n_in, 0) + coalesce(j.n_out, 0) > 0) and (j.covered or j.n_in is not null)
  order by j.nm, j.d;
end $$;

revoke all on function public.set_employee_shift(uuid, uuid, time, time, smallint[], date), public.clear_employee_shift(uuid, uuid, date),
  public.report_shift_activity(uuid, date, date, uuid), app.shift_starting_on(uuid, uuid, date), app.in_shift(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.set_employee_shift(uuid, uuid, time, time, smallint[], date), public.clear_employee_shift(uuid, uuid, date),
  public.report_shift_activity(uuid, date, date, uuid) to authenticated, service_role;
grant execute on function app.shift_starting_on(uuid, uuid, date), app.in_shift(uuid, uuid, timestamptz) to service_role;
