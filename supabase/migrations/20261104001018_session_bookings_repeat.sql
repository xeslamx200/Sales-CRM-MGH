-- 20261104001018 - A single SESSION can be booked (with its own price), and the same customer may pay more than once for a group (with a confirmation).
--
--  1. workshop_prices.session_price (nullable): the price of ONE session, on the same country / attendance row as the workshop price (same currency).
--     set_workshop_session_price(offering, country, attendance, price|null) sets or clears it (same permission as the prices: the services area).
--  2. workshop_bookings.booking_kind ('full' = the workshop, default; 'session') and session_date (the chosen session of the group; required for a session,
--     must be one of the group's dates). Both are immutable like the rest of the booking. Existing bookings are 'full'.
--  3. create_workshop_booking gains p_kind, p_session_date, p_confirm_repeat (last arguments; the 10-argument function is dropped). A session booking is priced
--     at session_price (booking.session_price_not_configured when it is not set); the discount rules apply to that price.
--  4. The unique index "one active booking per customer and group" is replaced by a plain index: the same customer may be booked again in the same group
--     (a second payment, another session). When that already exists, create_workshop_booking refuses with booking.repeat_unconfirmed unless p_confirm_repeat is
--     true - the form shows what the customer already has and asks the employee to confirm. A whole-workshop booking is still refused for a second,
--     unfinished GROUP of the same workshop (booking.duplicate).
--  5. Seats: one per customer for whole-workshop bookings (a repeat of the same customer takes no second seat; single sessions take none).
--     create_workshop_booking, approve_workshop_booking and workshop_group_stats count the same way.
--  6. booking_existing_for(contact, group): what the customer already has (active bookings) in the group, for the form's note.
-- Rollback: supabase/rollbacks/20261104001018_session_bookings_repeat.rollback.sql (refuses while a session booking or a repeat booking exists).

alter table public.workshop_prices add column session_price numeric(14, 2) check (session_price is null or (session_price > 0 and session_price <= 1000000000));
alter table public.workshop_bookings add column booking_kind text not null default 'full' check (booking_kind in ('full', 'session'));
alter table public.workshop_bookings add column session_date date;
alter table public.workshop_bookings add constraint workshop_bookings_kind_session_check
  check ((booking_kind = 'full' and session_date is null) or (booking_kind = 'session' and session_date is not null));

drop index public.workshop_bookings_active_per_group_uq;
create index workshop_bookings_contact_group_idx on public.workshop_bookings (contact_id, group_id) where status in ('booked', 'pending_approval');

create or replace function public.set_workshop_session_price(p_offering_id uuid, p_country text, p_attendance text, p_price numeric)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_off public.company_offerings; v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, ''))); old public.workshop_prices;
begin
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.can_admin_area(v_off.company_id, 'offerings') then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_price is not null and (p_price <= 0 or p_price > 1000000000 or p_price <> round(p_price, 2)) then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  select * into old from public.workshop_prices where offering_id = p_offering_id and country = v_country and attendance = v_att and is_active for update;
  if not found then raise exception 'price.not_found' using errcode = 'P0002'; end if;
  if old.session_price is not distinct from p_price then return; end if;
  update public.workshop_prices set session_price = p_price, updated_by = auth.uid(), updated_at = now() where id = old.id;
  perform app.write_audit(v_off.company_id, 'workshop.session_price_set', 'company_offering', p_offering_id,
    jsonb_build_object('country', v_country, 'attendance', v_att, 'currency', old.currency, 'old_session_price', old.session_price, 'session_price', p_price));
end $$;

create or replace function public.booking_existing_for(p_contact_id uuid, p_group_id uuid)
returns table (booking_id uuid, booking_kind text, session_date date, status text, final_price numeric, currency text, created_at timestamptz, owner_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.workshop_groups where id = p_group_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) or not app.can_see_contact(p_contact_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  return query
  select b.id, b.booking_kind, b.session_date, b.status, b.final_price, b.currency::text, b.created_at, p.full_name
  from public.workshop_bookings b left join public.profiles p on p.id = b.created_by
  where b.contact_id = p_contact_id and b.group_id = p_group_id and b.status in ('booked', 'pending_approval')
  order by b.created_at;
end $$;

create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.currency, new.list_price, new.note, new.created_by, new.created_at, new.booking_kind, new.session_date)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.currency, old.list_price, old.note, old.created_by, old.created_at, old.booking_kind, old.session_date)
     or old.status not in ('booked', 'pending_approval') then
    raise exception 'booking.immutable' using errcode = '42501';
  end if;
  if (new.discount_type, new.discount_value, new.discount_amount, new.final_price, new.discount_reason)
     is distinct from (old.discount_type, old.discount_value, old.discount_amount, old.final_price, old.discount_reason) then
    -- only none -> an approved request's exact values, while the booking is open, and never together with a cancellation
    if new.status <> 'booked' or old.discount_type <> 'none'
       or not exists (select 1 from public.booking_discount_requests r
                      where r.id = nullif(current_setting('app.booking_discount_apply', true), '')::uuid and r.booking_id = new.id and r.status = 'approved'
                        and r.discount_type = new.discount_type and r.discount_value = new.discount_value and r.requested_amount = new.discount_amount
                        and r.calculated_final = new.final_price and r.reason = new.discount_reason) then
      raise exception 'booking.immutable' using errcode = '42501';
    end if;
  elsif new.status is distinct from old.status then
    -- cancel (or reject a booking that waits for approval) through cancel_workshop_booking, or approve through approve_workshop_booking: nothing else moves the status
    if not ((new.status = 'cancelled' and coalesce(current_setting('app.booking_cancel', true), '') = 'on')
         or (old.status = 'pending_approval' and new.status = 'booked' and coalesce(current_setting('app.booking_approve', true), '') = 'on')) then
      raise exception 'booking.immutable' using errcode = '42501';
    end if;
  elsif (new.cancelled_by, new.cancelled_at, new.cancel_reason) is distinct from (old.cancelled_by, old.cancelled_at, old.cancel_reason) then
    raise exception 'booking.immutable' using errcode = '42501';
  end if;
  return new;
end $$;


drop function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date, uuid);

create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null,
  p_booked_on date default null, p_booked_by uuid default null,
  p_kind text default 'full', p_session_date date default null, p_confirm_repeat boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0);
  v_level text; v_damt numeric := 0; v_apply boolean; v_id uuid; v_req_id uuid; v_status text; v_name text; r record; v_tz text; v_today date; v_created timestamptz := now(); v_owner uuid; v_recorded uuid;
  v_kind text := lower(btrim(coalesce(p_kind, 'full'))); v_base numeric; v_rep boolean;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  v_owner := v_uid;
  select * into g from public.workshop_groups where id = p_group_id for update;       -- serialises bookings of one group (capacity)
  if not found or not app.has_company_access(g.company_id) then raise exception 'booking.group_not_found' using errcode = 'P0002'; end if;
  select * into v_off from public.company_offerings where id = g.offering_id;
  if not g.is_active then raise exception 'booking.group_inactive' using errcode = '23514'; end if;
  if not v_off.is_active then raise exception 'booking.offering_inactive' using errcode = '23514'; end if;
  if not app.can_see_contact(p_contact_id)
     or not exists (select 1 from public.contacts k where k.id = p_contact_id and k.merged_into_id is null)
     or not exists (select 1 from public.contact_companies cc where cc.contact_id = p_contact_id and cc.company_id = g.company_id) then
    raise exception 'booking.contact_not_found' using errcode = 'P0002';
  end if;
  -- on behalf of an employee (a booking the employee made): only a super admin (any sales person of the company) or a sales manager (herself and the
  -- members of the teams she manages); the employee owns the booking (created_by) and the person who typed it is kept in recorded_by
  if p_booked_by is not null and p_booked_by <> v_uid then
    if not app.can_book_for(g.company_id, p_booked_by) then raise exception 'booking.owner_not_allowed' using errcode = '42501'; end if;
    v_owner := p_booked_by; v_recorded := v_uid;
  end if;
  -- the booking date: today when not given; never in the future, at most 90 days back (the company's own calendar day); a past day is stamped at noon of that day
  select c.timezone into v_tz from public.companies c where c.id = g.company_id;
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  if p_booked_on is not null and p_booked_on <> v_today then
    if p_booked_on > v_today or p_booked_on < v_today - 90 then raise exception 'booking.invalid_date' using errcode = '23514'; end if;
    v_created := (p_booked_on::timestamp + interval '12 hours') at time zone coalesce(v_tz, 'UTC');
  end if;
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if g.attendance is not null and g.attendance <> v_att then raise exception 'booking.attendance_mismatch' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  select * into v_price from public.workshop_prices where offering_id = g.offering_id and country = v_country and attendance = v_att and is_active;
  if not found then raise exception 'booking.price_not_configured' using errcode = '23514'; end if;
  -- the whole workshop (its price) or ONE session of the group (its own price, on the same country / attendance row)
  if v_kind not in ('full', 'session') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if v_kind = 'session' then
    if p_session_date is null or not (p_session_date = any (g.sessions)) then raise exception 'booking.invalid_session' using errcode = '23514'; end if;
    if v_price.session_price is null then raise exception 'booking.session_price_not_configured' using errcode = '23514'; end if;
    v_base := v_price.session_price;
  else
    if p_session_date is not null then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
    v_base := v_price.price;
  end if;

  if v_dtype not in ('none', 'fixed', 'percent') then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  if v_dtype = 'none' then
    v_dval := 0;
  else
    if v_dval <= 0 or v_dval <> round(v_dval, 2) or (v_dtype = 'percent' and v_dval > 100) or (v_dtype = 'fixed' and v_dval > v_base) then
      raise exception 'booking.invalid_discount' using errcode = '23514';
    end if;
    if length(btrim(coalesce(p_discount_reason, ''))) < 3 or length(p_discount_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
    v_damt := app.discount_amount_for(v_dtype, v_dval, v_base);
    if v_damt <= 0 then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  end if;
  v_level := app.discount_required_level(v_dtype, v_dval, v_base);
  v_apply := v_level in ('none', 'employee');          -- above 10 % the booking starts at the FULL price and the discount waits for approval

  -- the same customer may pay more than once for the same group (e.g. a second payment, a second session); the employee must say it is fine
  -- (p_confirm_repeat): the booking form shows what the customer already has in this group first
  select exists (select 1 from public.workshop_bookings b
                 where b.contact_id = p_contact_id and b.group_id = g.id and b.status in ('booked', 'pending_approval')
                   and (v_kind = 'full' or b.booking_kind = 'full' or b.session_date = p_session_date)) into v_rep;
  if v_rep and not coalesce(p_confirm_repeat, false) then raise exception 'booking.repeat_unconfirmed' using errcode = '23514'; end if;
  -- a whole-workshop booking is still refused for a second, unfinished GROUP of the same workshop
  if v_kind = 'full' and exists (select 1 from public.workshop_bookings b join public.workshop_groups bg on bg.id = b.group_id
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.group_id <> g.id and b.booking_kind = 'full'
               and b.status in ('booked', 'pending_approval') and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  -- seats: one per customer of a whole-workshop booking (a repeat payment of the same customer takes no second seat); single sessions take none
  if v_kind = 'full' and g.capacity is not null
     and (select count(distinct b.contact_id) from public.workshop_bookings b
          where b.group_id = g.id and b.status = 'booked' and b.booking_kind = 'full' and b.contact_id <> p_contact_id) >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  -- a company admin's booking is approved by definition; everybody else's waits for a company admin (it counts nowhere until then)
  v_status := case when app.is_company_admin(g.company_id) then 'booked' else 'pending_approval' end;
  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by, status, created_at, recorded_by, booking_kind, session_date)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_base,
          case when v_apply then v_dtype else 'none' end, case when v_apply then v_dval else 0 end, case when v_apply then v_damt else 0 end,
          v_base - case when v_apply then v_damt else 0 end, case when v_apply and v_dtype <> 'none' then btrim(p_discount_reason) else null end,
          nullif(btrim(p_note), ''), v_owner, v_status, v_created, v_recorded, v_kind, p_session_date)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('kind', v_kind, 'session_date', p_session_date, 'repeat_confirmed', v_rep, 'booked_for', v_owner, 'entered_by', v_uid, 'status', v_status, 'booked_on', v_created, 'offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
                       'list_price', v_base, 'discount_type', case when v_apply then v_dtype else 'none' end,
                       'discount_amount', case when v_apply then v_damt else 0 end, 'final_price', v_base - case when v_apply then v_damt else 0 end));
  if v_level <> 'none' then
    insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount,
                                                  effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
    values (g.company_id, v_id, v_uid, v_dtype, v_dval, btrim(p_discount_reason), v_base, v_damt,
            app.discount_effective_percent(v_dtype, v_dval, v_base), v_level, v_base, v_base - v_damt,
            case when v_apply then 'approved' else 'pending' end, case when v_apply then v_uid end, case when v_apply then now() end,
            case when v_apply then v_base - v_damt end)
    returning id into v_req_id;
    perform app.write_audit(g.company_id, 'discount.requested', 'workshop_booking', v_id,
      jsonb_build_object('request_id', v_req_id, 'type', v_dtype, 'value', v_dval, 'effective_percent', app.discount_effective_percent(v_dtype, v_dval, v_base),
                         'required_level', v_level, 'auto_approved', v_apply));
  end if;
  if v_status = 'pending_approval' then
    select k.full_name into v_name from public.contacts k where k.id = p_contact_id;
    for r in select m.user_id from public.company_memberships m where m.company_id = g.company_id and m.role = 'company_admin' and m.is_active loop
      perform app.notify(r.user_id, g.company_id, 'booking_approval', 'حجز بانتظار الاعتماد', coalesce(v_name, '') || ' — ' || v_off.name, 'workshop_booking', v_id);
    end loop;
  end if;
  return v_id;
end $$;

create or replace function public.approve_workshop_booking(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.workshop_bookings; g public.workshop_groups; v_uid uuid := auth.uid();
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_id for update;
  if not found or not app.has_company_access(b.company_id) then raise exception 'booking.not_found' using errcode = 'P0002'; end if;
  if not app.is_company_admin(b.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if b.status <> 'pending_approval' then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 300 then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  select * into g from public.workshop_groups where id = b.group_id for update;     -- serialises with other bookings of the group (capacity)
  -- a repeat of the same customer was confirmed by the employee when the booking was made; only the seat is re-checked (whole-workshop bookings)
  if b.booking_kind = 'full' and g.capacity is not null
     and (select count(distinct x.contact_id) from public.workshop_bookings x
          where x.group_id = g.id and x.status = 'booked' and x.booking_kind = 'full' and x.contact_id <> b.contact_id) >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;
  perform set_config('app.booking_approve', 'on', true);
  update public.workshop_bookings set status = 'booked' where id = b.id;
  perform set_config('app.booking_approve', '', true);
  perform app.write_audit(b.company_id, 'booking.approved', 'workshop_booking', b.id, jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
  perform app.notify(b.created_by, b.company_id, 'booking_approved', 'تم اعتماد الحجز', null, 'workshop_booking', b.id);
end $$;

create or replace function public.workshop_group_stats(p_offering_id uuid)
returns table (group_id uuid, group_name text, starts_on date, capacity integer, is_active boolean, booked bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.company_offerings where id = p_offering_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
  select g.id, g.name, g.starts_on, g.capacity, g.is_active,
         (select count(distinct b.contact_id) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked' and b.booking_kind = 'full' and app.can_see_booking(b))
  from public.workshop_groups g where g.offering_id = p_offering_id order by g.starts_on, g.name;
end $$;

revoke all on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date, uuid, text, date, boolean),
  public.set_workshop_session_price(uuid, text, text, numeric), public.booking_existing_for(uuid, uuid) from public, anon;
grant execute on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date, uuid, text, date, boolean),
  public.set_workshop_session_price(uuid, text, text, numeric), public.booking_existing_for(uuid, uuid) to authenticated, service_role;
