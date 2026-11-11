-- ROLLBACK of 20261104000986. Restores the 985 versions of guard_booking, create_workshop_booking, cancel_workshop_booking, booking_money,
-- workshop_bookings_list and workshop_stats, then drops the 986 objects. It REFUSES while any discount request exists: pending, approved or rejected
-- requests are business records and the 985 functions know nothing about them (a booking holding an approved discount would also lose its audit
-- trail). To discard on purpose the owner must first decide what happens to those rows. Run with psql -1.
do $$ begin
  if exists (select 1 from public.booking_discount_requests) then raise exception 'rollback refused: discount requests exist'; end if;
end $$;

drop function public.discount_requests_list(uuid, text);
drop function public.booking_payments(uuid);
drop function public.booking_detail(uuid);
drop function public.customer_payment_rows(uuid, uuid, uuid, uuid, text, text, date, date);
drop function public.workshop_stats(uuid);
drop function public.workshop_bookings_list(uuid, uuid);
drop function app.booking_rows(uuid, uuid, uuid);
drop function app.booking_money(uuid[]);
drop function public.request_booking_discount(uuid, text, numeric, text);
drop function public.approve_booking_discount(uuid, text);
drop function public.reject_booking_discount(uuid, text);

create function app.booking_money(p_booking_ids uuid[])
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
revoke all on function app.booking_money(uuid[]) from public, anon, authenticated;
grant execute on function app.booking_money(uuid[]) to service_role;

create function public.workshop_bookings_list(p_offering_id uuid, p_group_id uuid default null)
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

create function public.workshop_stats(p_offering_id uuid)
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
revoke all on function public.workshop_bookings_list(uuid, uuid), public.workshop_stats(uuid) from public, anon;
grant execute on function public.workshop_bookings_list(uuid, uuid), public.workshop_stats(uuid) to authenticated, service_role;

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

drop trigger booking_discount_requests_no_truncate on public.booking_discount_requests;
drop trigger booking_discount_requests_guard on public.booking_discount_requests;
drop table public.booking_discount_requests;
drop function app.guard_discount_request();
drop function app.can_approve_discount(uuid, text);
drop function app.discount_required_level(text, numeric, numeric);
drop function app.discount_effective_percent(text, numeric, numeric);
drop function app.discount_amount_for(text, numeric, numeric);
