-- Company business hours and business-hours response times.
--
-- Hours are wall-clock times in the company's own timezone, one or more
-- intervals per weekday (split shifts such as 08:00–12:00 and 16:00–20:00 are
-- common). A weekday with no interval is closed. Holidays close a whole day.
-- A company without any interval has no business hours configured: the
-- business-hours columns in reports are then NULL ("not configured"), never 0.

create table public.company_business_hours (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday … 6 = Saturday (extract(dow))
  opens time not null,
  closes time not null,
  created_at timestamptz not null default now(),
  check (opens < closes)
);
create index company_business_hours_company_idx on public.company_business_hours (company_id, weekday);

create table public.company_holidays (
  company_id uuid not null references public.companies (id) on delete cascade,
  day date not null,
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (company_id, day)
);

alter table public.company_business_hours enable row level security;
alter table public.company_holidays enable row level security;

create policy business_hours_select on public.company_business_hours for select to authenticated
  using (app.has_company_access(company_id));
create policy business_hours_write on public.company_business_hours for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));
create policy holidays_select on public.company_holidays for select to authenticated
  using (app.has_company_access(company_id));
create policy holidays_write on public.company_holidays for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));

grant select, insert, update, delete on public.company_business_hours, public.company_holidays to authenticated;

-- Intervals of the same day must not overlap (overlaps would double-count).
-- SECURITY DEFINER: must see every interval of the company.
create or replace function app.guard_business_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.company_business_hours h
             where h.company_id = new.company_id and h.weekday = new.weekday and h.id <> new.id
               and h.opens < new.closes and new.opens < h.closes) then
    raise exception 'business_hours.overlap' using errcode = '23P01';
  end if;
  return new;
end $$;
create trigger company_business_hours_guard before insert or update on public.company_business_hours
  for each row execute function app.guard_business_hours();

-- Replace a company's weekly schedule in one statement (all or nothing).
-- p_hours: [{"weekday": 0-6, "opens": "HH:MM", "closes": "HH:MM"}, …]. Invoker:
-- RLS (company admins) decides; an empty array means "not configured".
create or replace function public.set_business_hours(p_company_id uuid, p_hours jsonb)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not app.is_company_admin(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 28 then
    raise exception 'business_hours.invalid' using errcode = '22023';
  end if;
  delete from public.company_business_hours where company_id = p_company_id;
  insert into public.company_business_hours (company_id, weekday, opens, closes)
  select p_company_id, (x->>'weekday')::smallint, (x->>'opens')::time, (x->>'closes')::time
  from jsonb_array_elements(p_hours) x;
exception
  when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or check_violation or not_null_violation then
    raise exception 'business_hours.invalid' using errcode = '22023';
end $$;
revoke all on function public.set_business_hours(uuid, jsonb) from public, anon;
grant execute on function public.set_business_hours(uuid, jsonb) to authenticated;

-- Seconds between two instants that fall inside the company's business hours
-- (its timezone, its holidays). NULL when no hours are configured.
create or replace function app.business_seconds(p_company_id uuid, p_from timestamptz, p_to timestamptz)
returns bigint
language sql stable set search_path = '' as $$
  with c as (select timezone from public.companies where id = p_company_id),
  configured as (select exists (select 1 from public.company_business_hours where company_id = p_company_id) as yes),
  windows as (
    select ((d::date + h.opens) at time zone c.timezone) as w0, ((d::date + h.closes) at time zone c.timezone) as w1
    from c
    cross join generate_series((p_from at time zone c.timezone)::date, (p_to at time zone c.timezone)::date, interval '1 day') d
    join public.company_business_hours h on h.company_id = p_company_id and h.weekday = extract(dow from d)::smallint
    where p_to > p_from
      and not exists (select 1 from public.company_holidays x where x.company_id = p_company_id and x.day = d::date)
  )
  select case when not (select yes from configured) or p_from is null or p_to is null then null
    else coalesce((select sum(greatest(extract(epoch from least(p_to, w1) - greatest(p_from, w0)), 0)) from windows), 0)::bigint end
$$;
revoke all on function app.business_seconds(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.business_seconds(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- WhatsApp response report: add business-hours columns. The return type
-- changes, so the function is dropped and recreated in this same transaction
-- (no data involved; grants are restored below).
-- destructive-ok: return-type change of a stateless report function, recreated immediately below
drop function public.report_whatsapp_response(uuid, date, date, boolean);
create function public.report_whatsapp_response(
  p_company_id uuid, p_from date, p_to date, p_include_simulated boolean default false
) returns table (user_id uuid, full_name text, turns_answered bigint,
                 avg_response_seconds numeric, median_response_seconds numeric,
                 answered_within_15m numeric, unanswered_turns bigint,
                 avg_business_seconds numeric, median_business_seconds numeric,
                 business_within_15m numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz; t1 timestamptz;
  v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'report.invalid_period' using errcode = '22023';
  end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with msgs as (
    select m.*, lag(m.direction) over (partition by m.conversation_id order by m.sent_at, m.created_at) as prev_dir
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.company_id = p_company_id and (p_include_simulated or not m.is_simulated)
      and m.status <> 'failed'
  ),
  turns as (
    select m.conversation_id, m.sent_at as asked_at
    from msgs m
    where m.direction = 'inbound' and (m.prev_dir is null or m.prev_dir = 'outbound')
      and m.sent_at >= t0 and m.sent_at < t1
  ),
  answered as (
    select t.conversation_id, t.asked_at, r.sent_by, r.sent_at as answered_at,
      case when r.sent_by is not null then app.business_seconds(p_company_id, t.asked_at, r.sent_at) end as biz
    from turns t
    left join lateral (
      select o.sent_by, o.sent_at from msgs o
      where o.conversation_id = t.conversation_id and o.direction = 'outbound'
        and o.sent_by is not null and o.sent_at >= t.asked_at
      order by o.sent_at limit 1
    ) r on true
  ),
  visible as (
    select a.* from answered a
    where a.sent_by is null or v_scope.see_all or a.sent_by = any (v_scope.owners)
  )
  select v.sent_by, app.user_display_name(v.sent_by),
    count(*) filter (where v.sent_by is not null),
    round(avg(extract(epoch from v.answered_at - v.asked_at)) filter (where v.sent_by is not null), 0),
    round((percentile_cont(0.5) within group (order by extract(epoch from v.answered_at - v.asked_at)))::numeric, 0),
    round((count(*) filter (where v.answered_at - v.asked_at <= interval '15 minutes'))::numeric
          / nullif(count(*) filter (where v.sent_by is not null), 0), 4),
    count(*) filter (where v.sent_by is null),
    round(avg(v.biz), 0),
    round((percentile_cont(0.5) within group (order by v.biz))::numeric, 0),
    round((count(*) filter (where v.biz <= 900))::numeric / nullif(count(v.biz), 0), 4)
  from visible v
  where v.sent_by is not null or v_scope.see_all or v_scope.include_unowned
  group by v.sent_by
  order by v.sent_by nulls last;
end $$;
revoke all on function public.report_whatsapp_response(uuid, date, date, boolean) from public, anon;
grant execute on function public.report_whatsapp_response(uuid, date, date, boolean) to authenticated, service_role;
