-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1. Needs 984 (prices and groups).
-- 20261104000985 - Workshop bookings (the booking is the primary record of a registration), discounts, and booking payments.
-- Additive: one new table, one nullable column on payments, new functions. No existing row is changed.
--
-- A booking ties one customer to ONE specific group of one workshop, for a country and an attendance type, at the agreed price:
--  * The list price is read by the database from the price matrix (984) at booking time and FROZEN in the booking together with its currency.
--    A later price change never touches an existing booking. A combination without an active price cannot be booked (booking.price_not_configured):
--    the system never assumes a price.
--  * Discount: none, a fixed amount (never above the price) or a percentage (0 < p <= 100); a reason is mandatory. The database computes the discount
--    amount and the final price; the original price, the discount and the final price are all stored and visible.
--  * Duplicates: one active booking per customer and group; and a customer cannot hold two active bookings of the same workshop while one of
--    its groups has not finished yet. Capacity is enforced under a row lock on the group (no overbooking by two simultaneous bookings).
--  * Money: payments are recorded against the booking in the BOOKING'S currency (record_booking_payment); the total of pending + confirmed
--    payments can never exceed the final price. The exchange rate to EGP is read by the database (as in migration 980) so commission and company
--    totals keep working. Status of a booking is derived, never typed: paid / partially_paid / pending_approval / rejected / unpaid.
--    "Paid" needs CONFIRMED money >= final price; pending money is never counted as collected.
--  * Bookings are immutable (terms, price, discount); they can only be CANCELLED (reason required), and only while they have no pending or
--    confirmed payment (a payment must be rejected first). Never deleted.
--  * Visibility: managers and admins see every booking of their company; other employees see the bookings they created. Statistics follow the
--    same visibility.
-- Existing payments (without a booking) are untouched and remain valid.
-- Rollback: supabase/proposed/rollbacks/20261104000985_workshop_bookings_discounts.rollback.sql (refuses while any booking exists)

create table public.workshop_bookings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  offering_id uuid not null,
  group_id uuid not null,
  country char(2) not null check (country ~ '^[A-Z]{2}$'),
  attendance text not null check (attendance in ('online', 'offline')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  list_price numeric(14, 2) not null check (list_price > 0),
  discount_type text not null default 'none' check (discount_type in ('none', 'fixed', 'percent')),
  discount_value numeric(10, 2) not null default 0 check (discount_value >= 0),
  discount_amount numeric(14, 2) not null default 0 check (discount_amount >= 0),
  final_price numeric(14, 2) not null check (final_price >= 0),
  discount_reason text check (discount_reason is null or length(discount_reason) <= 300),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  note text check (note is null or length(note) <= 1000),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  foreign key (offering_id, company_id) references public.company_offerings (id, company_id),
  foreign key (group_id, company_id) references public.workshop_groups (id, company_id),
  unique (id, company_id),
  check (discount_amount <= list_price and final_price = list_price - discount_amount),
  check ((discount_type = 'none' and discount_value = 0 and discount_amount = 0)
      or (discount_type = 'fixed' and discount_value > 0 and discount_amount = discount_value)
      or (discount_type = 'percent' and discount_value > 0 and discount_value <= 100 and discount_amount = round(list_price * discount_value / 100, 2))),
  check (discount_type = 'none' or length(btrim(coalesce(discount_reason, ''))) >= 3),
  check ((status = 'booked' and cancelled_at is null) or (status = 'cancelled' and cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) >= 3))
);
create unique index workshop_bookings_active_per_group_uq on public.workshop_bookings (contact_id, group_id) where status = 'booked';
create index workshop_bookings_offering_idx on public.workshop_bookings (offering_id, status, created_at desc);
create index workshop_bookings_group_idx on public.workshop_bookings (group_id) where status = 'booked';
create index workshop_bookings_creator_idx on public.workshop_bookings (created_by);
create index workshop_bookings_contact_idx on public.workshop_bookings (contact_id);

alter table public.workshop_bookings enable row level security;
revoke all on public.workshop_bookings from public, anon, authenticated;
grant select on public.workshop_bookings to authenticated;
grant all on public.workshop_bookings to service_role;
create policy workshop_bookings_select on public.workshop_bookings for select to authenticated
  using (app.has_company_access(company_id) and (created_by = (select auth.uid()) or app.is_company_manager(company_id)));

-- Immutable except the cancellation done by cancel_workshop_booking (which sets the flag in its own transaction).
create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.currency, new.list_price, new.discount_type,
      new.discount_value, new.discount_amount, new.final_price, new.discount_reason, new.note, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.currency, old.list_price, old.discount_type,
      old.discount_value, old.discount_amount, old.final_price, old.discount_reason, old.note, old.created_by, old.created_at)
     or old.status <> 'booked' or coalesce(current_setting('app.booking_cancel', true), '') <> 'on' then
    raise exception 'booking.immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger workshop_bookings_guard before update or delete on public.workshop_bookings
  for each row execute function app.guard_booking();

-- payments gain an optional link to a booking (legacy payments keep NULL); the immutability guard now covers it
alter table public.payments add column booking_id uuid references public.workshop_bookings (id) on delete restrict;
create index payments_booking_idx on public.payments (booking_id) where booking_id is not null;
create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'payment.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.amount, new.currency, new.fx_rate_to_egp, new.fx_source, new.fx_fetched_at,
      new.kind, new.paid_on, new.note, new.created_by, new.created_at, new.booking_id)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.amount, old.currency, old.fx_rate_to_egp, old.fx_source, old.fx_fetched_at,
      old.kind, old.paid_on, old.note, old.created_by, old.created_at, old.booking_id) then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('app.payment_review', true), '') <> 'on' then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ derived money / status (internal)
create or replace function app.booking_payment_status(p_final numeric, p_confirmed numeric, p_pending numeric, p_rejected bigint, p_cancelled boolean)
returns text language sql immutable set search_path = '' as $$
  select case when p_cancelled then 'cancelled'
              when p_confirmed >= p_final then 'paid'
              when p_confirmed > 0 then 'partially_paid'
              when p_pending > 0 then 'pending_approval'
              when p_rejected > 0 then 'rejected'
              else 'unpaid' end
$$;

create or replace function app.booking_money(p_booking_ids uuid[])
returns table (booking_id uuid, confirmed numeric, pending numeric, confirmed_egp numeric, rejected_count bigint)
language sql stable security definer set search_path = '' as $$
  select b.id,
         coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0)::numeric(14, 2),
         coalesce(sum(p.amount) filter (where p.status = 'pending'), 0)::numeric(14, 2),
         coalesce(sum(p.amount_egp) filter (where p.status = 'confirmed'), 0)::numeric(14, 2),
         count(p.id) filter (where p.status = 'rejected')
  from public.workshop_bookings b left join public.payments p on p.booking_id = b.id
  where b.id = any (p_booking_ids)
  group by b.id
$$;

-- ------------------------------------------------------------------ create a booking
create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0); v_damt numeric; v_id uuid;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into g from public.workshop_groups where id = p_group_id for update;       -- the lock serialises bookings of one group (capacity)
  if not found or not app.has_company_access(g.company_id) then raise exception 'booking.group_not_found' using errcode = 'P0002'; end if;
  select * into v_off from public.company_offerings where id = g.offering_id;
  if not g.is_active then raise exception 'booking.group_inactive' using errcode = '23514'; end if;
  if not v_off.is_active then raise exception 'booking.offering_inactive' using errcode = '23514'; end if;
  if not app.can_see_contact(p_contact_id)
     or not exists (select 1 from public.contacts k where k.id = p_contact_id and k.merged_into_id is null)
     or not exists (select 1 from public.contact_companies cc where cc.contact_id = p_contact_id and cc.company_id = g.company_id) then
    raise exception 'booking.contact_not_found' using errcode = 'P0002';
  end if;
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if g.attendance is not null and g.attendance <> v_att then raise exception 'booking.attendance_mismatch' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'booking.invalid_value' using errcode = '23514'; end if;

  select * into v_price from public.workshop_prices
  where offering_id = g.offering_id and country = v_country and attendance = v_att and is_active;
  if not found then raise exception 'booking.price_not_configured' using errcode = '23514'; end if;

  if v_dtype not in ('none', 'fixed', 'percent') then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  if v_dtype = 'none' then
    v_dval := 0; v_damt := 0;
  else
    if v_dval <= 0 or v_dval <> round(v_dval, 2) or (v_dtype = 'percent' and v_dval > 100) or (v_dtype = 'fixed' and v_dval > v_price.price) then
      raise exception 'booking.invalid_discount' using errcode = '23514';
    end if;
    if length(btrim(coalesce(p_discount_reason, ''))) < 3 or length(p_discount_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
    v_damt := case when v_dtype = 'fixed' then v_dval else round(v_price.price * v_dval / 100, 2) end;
  end if;

  if exists (select 1 from public.workshop_bookings b join public.workshop_groups bg on bg.id = b.group_id
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.status = 'booked' and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  if g.capacity is not null and (select count(*) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked') >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_price.price,
          v_dtype, v_dval, v_damt, v_price.price - v_damt, case when v_dtype = 'none' then null else btrim(p_discount_reason) end, nullif(btrim(p_note), ''), v_uid)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
                       'list_price', v_price.price, 'discount_type', v_dtype, 'discount_amount', v_damt, 'final_price', v_price.price - v_damt));
  return v_id;
end $$;

-- ------------------------------------------------------------------ cancel
create or replace function public.cancel_workshop_booking(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.workshop_bookings; v_uid uuid := auth.uid();
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_id for update;
  if not found or not app.has_company_access(b.company_id) or not (b.created_by = v_uid or app.is_company_manager(b.company_id)) then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;
  if b.status <> 'booked' then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 300 then raise exception 'booking.reason_required' using errcode = '23514'; end if;
  if exists (select 1 from public.payments p where p.booking_id = b.id and p.status in ('pending', 'confirmed')) then
    raise exception 'booking.has_payments' using errcode = '23514';
  end if;
  perform set_config('app.booking_cancel', 'on', true);
  update public.workshop_bookings set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason) where id = b.id;
  perform set_config('app.booking_cancel', '', true);
  perform app.write_audit(b.company_id, 'booking.cancelled', 'workshop_booking', b.id, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- ------------------------------------------------------------------ pay a booking (booking currency; rate read here)
create or replace function public.record_booking_payment(p_booking_id uuid, p_amount numeric, p_paid_on date default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); b public.workshop_bookings; m record; v_remaining numeric; v_rate numeric; v_fetched timestamptz; v_id uuid; v_kind text;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_booking_id for update;
  if not found or not app.has_company_access(b.company_id) or not (b.created_by = v_uid or app.is_company_manager(b.company_id)) then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;
  if b.status <> 'booked' then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount, 2) then raise exception 'payment.invalid_amount' using errcode = '23514'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'payment.invalid_date' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  select * into m from app.booking_money(array[b.id]);
  v_remaining := b.final_price - m.confirmed - m.pending;
  if p_amount > v_remaining then raise exception 'booking.overpayment' using errcode = '23514'; end if;
  v_kind := case when p_amount = v_remaining then 'full' else 'partial' end;
  if b.currency = 'EGP' then
    v_rate := 1; v_fetched := null;
  else
    select r.rate_to_egp, r.fetched_at into v_rate, v_fetched from public.fx_rates r where r.currency = b.currency;
    if v_rate is null then raise exception 'payment.rate_unavailable' using errcode = '23514'; end if;
    if v_fetched < now() - interval '48 hours' then raise exception 'payment.rate_stale' using errcode = '23514'; end if;
  end if;
  insert into public.payments (company_id, contact_id, offering_id, booking_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, note, created_by)
  values (b.company_id, b.contact_id, b.offering_id, b.id, p_amount, b.currency, v_rate, case when b.currency = 'EGP' then 'egp' else 'auto' end, v_fetched,
          v_kind, coalesce(p_paid_on, current_date), nullif(btrim(p_note), ''), v_uid)
  returning id into v_id;
  perform app.write_audit(b.company_id, 'payment.recorded', 'payment', v_id,
    jsonb_build_object('currency', b.currency, 'offering_id', b.offering_id, 'kind', v_kind, 'booking_id', b.id));
  return v_id;
end $$;

-- ------------------------------------------------------------------ reads (security definer; the visibility rule is applied inside)
create or replace function app.can_see_booking(b public.workshop_bookings) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.is_active_user() and app.has_company_access(b.company_id) and (b.created_by = auth.uid() or app.is_company_manager(b.company_id))
$$;

-- Bookings of a workshop (optionally one group) with customer data and the derived money / status.
create or replace function public.workshop_bookings_list(p_offering_id uuid, p_group_id uuid default null)
returns table (booking_id uuid, contact_id uuid, customer_name text, phone text, email text, country text, attendance text, group_id uuid, group_name text,
               group_starts_on date, booked_at timestamptz, booking_status text, currency text, list_price numeric, discount_type text, discount_value numeric,
               discount_amount numeric, final_price numeric, confirmed numeric, pending numeric, remaining numeric, payment_status text, recorded_by text)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.company_offerings where id = p_offering_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
  select b.id, b.contact_id, k.full_name, k.phone_e164, k.email, b.country::text, b.attendance, b.group_id, g.name, g.starts_on, b.created_at, b.status, b.currency::text,
         b.list_price, b.discount_type, b.discount_value, b.discount_amount, b.final_price, m.confirmed, m.pending,
         greatest(b.final_price - m.confirmed, 0), app.booking_payment_status(b.final_price, m.confirmed, m.pending, m.rejected_count, b.status = 'cancelled'),
         app.user_display_name(b.created_by)
  from public.workshop_bookings b
  join public.contacts k on k.id = b.contact_id
  join public.workshop_groups g on g.id = b.group_id
  join lateral (select * from app.booking_money(array[b.id])) m on true
  where b.offering_id = p_offering_id and (p_group_id is null or b.group_id = p_group_id) and app.can_see_booking(b)
  order by b.created_at desc;
end $$;

-- Headline numbers of a workshop. Money is never summed across currencies: by_currency has one entry per currency.
create or replace function public.workshop_stats(p_offering_id uuid)
returns table (total_bookings bigint, paid bigint, partially_paid bigint, unpaid bigint, pending_approval bigint, rejected bigint, cancelled bigint,
               online_participants bigint, offline_participants bigint, by_currency jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with l as (select * from public.workshop_bookings_list(p_offering_id)),
  cur as (select currency, sum(confirmed) as collected, sum(final_price - least(confirmed, final_price)) as outstanding,
                 sum(final_price) as total_final, sum(discount_amount) as discounts
          from l where booking_status = 'booked' group by currency)
  select count(*) filter (where booking_status = 'booked'),
         count(*) filter (where payment_status = 'paid'), count(*) filter (where payment_status = 'partially_paid'),
         count(*) filter (where payment_status = 'unpaid'), count(*) filter (where payment_status = 'pending_approval'),
         count(*) filter (where payment_status = 'rejected'), count(*) filter (where booking_status = 'cancelled'),
         count(*) filter (where booking_status = 'booked' and attendance = 'online'), count(*) filter (where booking_status = 'booked' and attendance = 'offline'),
         coalesce((select jsonb_agg(jsonb_build_object('currency', c.currency, 'collected', c.collected, 'outstanding', c.outstanding,
                                                     'total_final', c.total_final, 'discounts', c.discounts) order by c.currency) from cur c), '[]'::jsonb)
  from l;
end $$;

-- Group distribution of a workshop: active bookings per group against capacity.
create or replace function public.workshop_group_stats(p_offering_id uuid)
returns table (group_id uuid, group_name text, starts_on date, capacity integer, is_active boolean, booked bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.company_offerings where id = p_offering_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
  select g.id, g.name, g.starts_on, g.capacity, g.is_active,
         (select count(*) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked' and app.can_see_booking(b))
  from public.workshop_groups g where g.offering_id = p_offering_id order by g.starts_on, g.name;
end $$;

revoke all on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text), public.cancel_workshop_booking(uuid, text),
  public.record_booking_payment(uuid, numeric, date, text), public.workshop_bookings_list(uuid, uuid), public.workshop_stats(uuid), public.workshop_group_stats(uuid),
  app.booking_payment_status(numeric, numeric, numeric, bigint, boolean), app.booking_money(uuid[]), app.can_see_booking(public.workshop_bookings), app.guard_booking() from public, anon;
grant execute on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text), public.cancel_workshop_booking(uuid, text),
  public.record_booking_payment(uuid, numeric, date, text), public.workshop_bookings_list(uuid, uuid), public.workshop_stats(uuid), public.workshop_group_stats(uuid),
  app.booking_payment_status(numeric, numeric, numeric, bigint, boolean), app.can_see_booking(public.workshop_bookings) to authenticated, service_role;
-- app.booking_money is internal (it does not check visibility): only the security-definer functions above call it, as the owner.
grant execute on function app.booking_money(uuid[]) to service_role;
