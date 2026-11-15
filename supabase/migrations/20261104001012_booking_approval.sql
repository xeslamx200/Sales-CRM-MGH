-- 20261104001012 - Every booking waits for a company admin's approval, and counts nowhere until it is approved.
--
-- New booking status 'pending_approval' (between creation and the decision):
--  * create_workshop_booking: a company admin's (or super admin's) booking is 'booked' at once; anybody else's is 'pending_approval' and every company
--    admin of the company gets a notification. A pending booking does NOT take a seat of the group (capacity counts 'booked' only), is not in any
--    count, total, revenue, report or dashboard figure (they all filter status = 'booked'), cannot receive a payment (booking.awaiting_approval) and
--    cannot get a discount request. It does block a second booking of the same customer for the same workshop (booking.duplicate).
--  * approve_workshop_booking(id, note): company admin / super admin only. Re-checks the seat and the duplicate rule, then 'booked'; audited; the person
--    who made the booking is notified.
--  * cancel_workshop_booking: also works on a pending booking = reject it (company admin) or withdraw it (the person who made it); the reason is required.
--  * app.guard_booking: the only status moves are booked/pending -> cancelled (cancel function) and pending -> booked (approve function).
-- Existing bookings stay 'booked' (nothing is rewritten here).
-- Rollback: supabase/rollbacks/20261104001012_booking_approval.rollback.sql (refuses while a booking waits for approval).

alter table public.workshop_bookings drop constraint workshop_bookings_status_check;
alter table public.workshop_bookings add constraint workshop_bookings_status_check check (status in ('booked', 'pending_approval', 'cancelled'));
alter table public.workshop_bookings drop constraint workshop_bookings_check3;
alter table public.workshop_bookings add constraint workshop_bookings_check3 check (
  (status in ('booked', 'pending_approval') and cancelled_at is null)
  or (status = 'cancelled' and cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) >= 3));
drop index public.workshop_bookings_active_per_group_uq;
create unique index workshop_bookings_active_per_group_uq on public.workshop_bookings (contact_id, group_id) where status in ('booked', 'pending_approval');

create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.currency, new.list_price, new.note, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.currency, old.list_price, old.note, old.created_by, old.created_at)
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

create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0);
  v_level text; v_damt numeric := 0; v_apply boolean; v_id uuid; v_req_id uuid; v_status text; v_name text; r record;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
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
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if g.attendance is not null and g.attendance <> v_att then raise exception 'booking.attendance_mismatch' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  select * into v_price from public.workshop_prices where offering_id = g.offering_id and country = v_country and attendance = v_att and is_active;
  if not found then raise exception 'booking.price_not_configured' using errcode = '23514'; end if;

  if v_dtype not in ('none', 'fixed', 'percent') then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  if v_dtype = 'none' then
    v_dval := 0;
  else
    if v_dval <= 0 or v_dval <> round(v_dval, 2) or (v_dtype = 'percent' and v_dval > 100) or (v_dtype = 'fixed' and v_dval > v_price.price) then
      raise exception 'booking.invalid_discount' using errcode = '23514';
    end if;
    if length(btrim(coalesce(p_discount_reason, ''))) < 3 or length(p_discount_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
    v_damt := app.discount_amount_for(v_dtype, v_dval, v_price.price);
    if v_damt <= 0 then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  end if;
  v_level := app.discount_required_level(v_dtype, v_dval, v_price.price);
  v_apply := v_level in ('none', 'employee');          -- above 10 % the booking starts at the FULL price and the discount waits for approval

  if exists (select 1 from public.workshop_bookings b join public.workshop_groups bg on bg.id = b.group_id
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.status in ('booked', 'pending_approval') and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  if g.capacity is not null and (select count(*) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked') >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  -- a company admin's booking is approved by definition; everybody else's waits for a company admin (it counts nowhere until then)
  v_status := case when app.is_company_admin(g.company_id) then 'booked' else 'pending_approval' end;
  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by, status)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_price.price,
          case when v_apply then v_dtype else 'none' end, case when v_apply then v_dval else 0 end, case when v_apply then v_damt else 0 end,
          v_price.price - case when v_apply then v_damt else 0 end, case when v_apply and v_dtype <> 'none' then btrim(p_discount_reason) else null end,
          nullif(btrim(p_note), ''), v_uid, v_status)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('status', v_status, 'offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
                       'list_price', v_price.price, 'discount_type', case when v_apply then v_dtype else 'none' end,
                       'discount_amount', case when v_apply then v_damt else 0 end, 'final_price', v_price.price - case when v_apply then v_damt else 0 end));
  if v_level <> 'none' then
    insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount,
                                                  effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
    values (g.company_id, v_id, v_uid, v_dtype, v_dval, btrim(p_discount_reason), v_price.price, v_damt,
            app.discount_effective_percent(v_dtype, v_dval, v_price.price), v_level, v_price.price, v_price.price - v_damt,
            case when v_apply then 'approved' else 'pending' end, case when v_apply then v_uid end, case when v_apply then now() end,
            case when v_apply then v_price.price - v_damt end)
    returning id into v_req_id;
    perform app.write_audit(g.company_id, 'discount.requested', 'workshop_booking', v_id,
      jsonb_build_object('request_id', v_req_id, 'type', v_dtype, 'value', v_dval, 'effective_percent', app.discount_effective_percent(v_dtype, v_dval, v_price.price),
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
  if g.capacity is not null and (select count(*) from public.workshop_bookings x where x.group_id = g.id and x.status = 'booked') >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;
  if exists (select 1 from public.workshop_bookings x join public.workshop_groups xg on xg.id = x.group_id
             where x.contact_id = b.contact_id and x.offering_id = b.offering_id and x.status = 'booked' and x.id <> b.id and xg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  perform set_config('app.booking_approve', 'on', true);
  update public.workshop_bookings set status = 'booked' where id = b.id;
  perform set_config('app.booking_approve', '', true);
  perform app.write_audit(b.company_id, 'booking.approved', 'workshop_booking', b.id, jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
  perform app.notify(b.created_by, b.company_id, 'booking_approved', 'تم اعتماد الحجز', null, 'workshop_booking', b.id);
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
  if b.status not in ('booked', 'pending_approval') then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  -- a booking that waits for approval is rejected by a company admin, or withdrawn by the person who made it
  if b.status = 'pending_approval' and not (b.created_by = v_uid or app.is_company_admin(b.company_id)) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 300 then raise exception 'booking.reason_required' using errcode = '23514'; end if;
  if exists (select 1 from public.payments p where p.booking_id = b.id and p.status in ('pending', 'confirmed')) then
    raise exception 'booking.has_payments' using errcode = '23514';
  end if;
  perform set_config('app.discount_decision', 'on', true);
  update public.booking_discount_requests set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = 'booking cancelled'
   where booking_id = b.id and status = 'pending';
  perform set_config('app.discount_decision', '', true);
  perform set_config('app.booking_cancel', 'on', true);
  update public.workshop_bookings set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason) where id = b.id;
  perform set_config('app.booking_cancel', '', true);
  perform app.write_audit(b.company_id, 'booking.cancelled', 'workshop_booking', b.id, jsonb_build_object('reason', btrim(p_reason), 'was', b.status));
end $$;

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
  if b.status = 'pending_approval' then raise exception 'booking.awaiting_approval' using errcode = '23514'; end if;
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

revoke all on function public.approve_workshop_booking(uuid, text) from public, anon;
grant execute on function public.approve_workshop_booking(uuid, text) to authenticated, service_role;
