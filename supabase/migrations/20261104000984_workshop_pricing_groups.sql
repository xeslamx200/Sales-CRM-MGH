-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000984 - Workshop price matrix (per workshop x country x attendance, with its own currency) and workshop groups / cohorts.
-- Purely additive: no existing table or row is changed, no existing workshop is renamed, merged or deleted. Prices and groups are DATA entered by
-- company admins; nothing is seeded here (the MGH price list is a separate data script that needs the owner's approval of the workshop mapping).
--
-- Rules
--  * A price exists only if an admin set it. A combination without an active row is "not configured": workshop_price_for returns nothing and the
--    UI must ask an admin to define it. The system never assumes, converts or defaults a price.
--  * Every change of a price (create, change, deactivate, reactivate) appends an immutable row to workshop_price_history with who and when.
--    Prices are never deleted; "removing" a price deactivates it. Bookings (next migration) copy the agreed price at booking time, so a later
--    price change never touches an existing booking or payment.
--  * Groups (cohorts) belong to one workshop: a name ("Group 1"), the exact session dates (e.g. 6, 7 and 8 December), an optional capacity,
--    an optional attendance type, and an active flag. Never deleted, only deactivated.
--  * Writes only through the functions below (company admins = owner and managers with admin rights; audited). Reads: any member of the company.
-- Rollback: supabase/proposed/rollbacks/20261104000984_workshop_pricing_groups.rollback.sql (refuses while any price or group exists)

-- ------------------------------------------------------------------ 1. price matrix
create table public.workshop_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  offering_id uuid not null,
  country char(2) not null check (country ~ '^[A-Z]{2}$'),
  attendance text not null check (attendance in ('online', 'offline')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  price numeric(14, 2) not null check (price > 0 and price <= 1000000000),
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (offering_id, company_id) references public.company_offerings (id, company_id),
  unique (offering_id, country, attendance)
);
create index workshop_prices_company_idx on public.workshop_prices (company_id, offering_id);

create table public.workshop_price_history (
  id bigint generated always as identity primary key,
  price_id uuid not null references public.workshop_prices (id) on delete restrict,
  company_id uuid not null,
  offering_id uuid not null,
  country char(2) not null,
  attendance text not null,
  old_price numeric(14, 2),
  old_currency char(3),
  old_active boolean,
  new_price numeric(14, 2) not null,
  new_currency char(3) not null,
  new_active boolean not null,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);
create index workshop_price_history_price_idx on public.workshop_price_history (price_id, changed_at desc);

create or replace function app.block_price_history_mutation() returns trigger
language plpgsql as $$ begin raise exception 'price.history_immutable' using errcode = '42501'; end $$;
create trigger workshop_price_history_no_update before update or delete on public.workshop_price_history
  for each row execute function app.block_price_history_mutation();
create trigger workshop_price_history_no_truncate before truncate on public.workshop_price_history
  for each statement execute function app.block_price_history_mutation();

-- ------------------------------------------------------------------ 2. groups
create table public.workshop_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  offering_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  sessions date[] not null check (cardinality(sessions) between 1 and 60),
  starts_on date not null,
  ends_on date not null,
  capacity integer check (capacity is null or capacity between 1 and 10000),
  attendance text check (attendance is null or attendance in ('online', 'offline')),
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (offering_id, company_id) references public.company_offerings (id, company_id),
  unique (id, company_id),
  unique (offering_id, name),
  check (ends_on >= starts_on)
);
create index workshop_groups_company_idx on public.workshop_groups (company_id, offering_id, starts_on);

alter table public.workshop_prices enable row level security;
alter table public.workshop_price_history enable row level security;
alter table public.workshop_groups enable row level security;
revoke all on public.workshop_prices, public.workshop_price_history, public.workshop_groups from public, anon, authenticated;
grant select on public.workshop_prices, public.workshop_price_history, public.workshop_groups to authenticated;
grant all on public.workshop_prices, public.workshop_price_history, public.workshop_groups to service_role;
create policy workshop_prices_select on public.workshop_prices for select to authenticated using (app.has_company_access(company_id));
create policy workshop_price_history_select on public.workshop_price_history for select to authenticated using (app.is_company_manager(company_id));
create policy workshop_groups_select on public.workshop_groups for select to authenticated using (app.has_company_access(company_id));

-- ------------------------------------------------------------------ 3. set a price (company admins). p_price NULL = deactivate.
create or replace function public.set_workshop_price(p_offering_id uuid, p_country text, p_attendance text, p_currency text, p_price numeric)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_off public.company_offerings; v_country text := upper(btrim(coalesce(p_country, ''))); v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_att text := lower(btrim(coalesce(p_attendance, ''))); old public.workshop_prices; v_id uuid;
begin
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.is_company_admin(v_off.company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') or v_cur !~ '^[A-Z]{3}$' then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  if p_price is not null and (p_price <= 0 or p_price > 1000000000 or p_price <> round(p_price, 2)) then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  select * into old from public.workshop_prices where offering_id = p_offering_id and country = v_country and attendance = v_att for update;
  if p_price is null then
    if not found then raise exception 'price.not_found' using errcode = 'P0002'; end if;
    if not old.is_active then return old.id; end if;
    update public.workshop_prices set is_active = false, updated_by = auth.uid(), updated_at = now() where id = old.id;
    insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, old_price, old_currency, old_active, new_price, new_currency, new_active, changed_by)
    values (old.id, old.company_id, old.offering_id, old.country, old.attendance, old.price, old.currency, true, old.price, old.currency, false, auth.uid());
    v_id := old.id;
  elsif not found then
    insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price, created_by, updated_by)
    values (v_off.company_id, p_offering_id, v_country, v_att, v_cur, p_price, auth.uid(), auth.uid()) returning id into v_id;
    insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, new_price, new_currency, new_active, changed_by)
    values (v_id, v_off.company_id, p_offering_id, v_country, v_att, p_price, v_cur, true, auth.uid());
  else
    v_id := old.id;
    if (old.price, old.currency, old.is_active) is distinct from (p_price, v_cur, true) then
      update public.workshop_prices set price = p_price, currency = v_cur, is_active = true, updated_by = auth.uid(), updated_at = now() where id = old.id;
      insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, old_price, old_currency, old_active, new_price, new_currency, new_active, changed_by)
      values (old.id, old.company_id, old.offering_id, old.country, old.attendance, old.price, old.currency, old.is_active, p_price, v_cur, true, auth.uid());
    end if;
  end if;
  perform app.write_audit(v_off.company_id, 'workshop.price_set', 'company_offering', p_offering_id,
    jsonb_build_object('country', v_country, 'attendance', v_att, 'currency', v_cur, 'price', p_price));
  return v_id;
end $$;

-- The configured, active price (nothing = not configured: never assume one). Visibility follows RLS (members of the company).
create or replace function public.workshop_price_for(p_offering_id uuid, p_country text, p_attendance text)
returns table (price numeric, currency text)
language sql stable security invoker set search_path = '' as $$
  select wp.price, wp.currency::text from public.workshop_prices wp
  where wp.offering_id = p_offering_id and wp.country = upper(btrim(p_country)) and wp.attendance = lower(btrim(p_attendance)) and wp.is_active
$$;

-- Active workshops x countries x attendance types that have NO active price (the "needs an admin to define it" list). Managers and admins.
create or replace function public.workshop_price_gaps(p_company_id uuid, p_countries text[])
returns table (offering_id uuid, offering_name text, country text, attendance text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_manager(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_countries is null or cardinality(p_countries) = 0 or cardinality(p_countries) > 30 then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  return query
  select o.id, o.name, c.code, a.att
  from public.company_offerings o
  cross join (select distinct upper(btrim(x)) as code from unnest(p_countries) x where upper(btrim(x)) ~ '^[A-Z]{2}$') c
  cross join (values ('online'), ('offline')) a(att)
  where o.company_id = p_company_id and o.is_active
    and not exists (select 1 from public.workshop_prices wp where wp.offering_id = o.id and wp.country = c.code and wp.attendance = a.att and wp.is_active)
  order by o.name, c.code, a.att;
end $$;

-- ------------------------------------------------------------------ 4. groups (company admins). p_group_id NULL = create.
create or replace function public.set_workshop_group(p_group_id uuid, p_offering_id uuid, p_name text, p_sessions date[], p_capacity integer,
                                                      p_attendance text, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_off public.company_offerings; v_sessions date[]; v_id uuid; v_att text := nullif(lower(btrim(coalesce(p_attendance, ''))), ''); g public.workshop_groups;
begin
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.is_company_admin(v_off.company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select array_agg(distinct d order by d) into v_sessions from unnest(p_sessions) d where d is not null;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or v_sessions is null or cardinality(v_sessions) > 60
     or (p_capacity is not null and p_capacity not between 1 and 10000) or (v_att is not null and v_att not in ('online', 'offline')) then
    raise exception 'group.invalid_value' using errcode = '23514';
  end if;
  if p_group_id is null then
    insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance, is_active, created_by, updated_by)
    values (v_off.company_id, p_offering_id, btrim(p_name), v_sessions, v_sessions[1], v_sessions[cardinality(v_sessions)], p_capacity, v_att, coalesce(p_active, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    select * into g from public.workshop_groups where id = p_group_id and company_id = v_off.company_id and offering_id = p_offering_id for update;
    if not found then raise exception 'group.not_found' using errcode = 'P0002'; end if;
    update public.workshop_groups set name = btrim(p_name), sessions = v_sessions, starts_on = v_sessions[1], ends_on = v_sessions[cardinality(v_sessions)],
      capacity = p_capacity, attendance = v_att, is_active = coalesce(p_active, true), updated_by = auth.uid(), updated_at = now() where id = p_group_id;
    v_id := p_group_id;
  end if;
  perform app.write_audit(v_off.company_id, 'workshop.group_set', 'company_offering', p_offering_id,
    jsonb_build_object('group_id', v_id, 'name', btrim(p_name), 'sessions', to_jsonb(v_sessions), 'capacity', p_capacity, 'active', coalesce(p_active, true)));
  return v_id;
end $$;

revoke all on function public.set_workshop_price(uuid, text, text, text, numeric), public.workshop_price_for(uuid, text, text),
  public.workshop_price_gaps(uuid, text[]), public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean) from public, anon;
grant execute on function public.set_workshop_price(uuid, text, text, text, numeric), public.workshop_price_for(uuid, text, text),
  public.workshop_price_gaps(uuid, text[]), public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean) to authenticated, service_role;
