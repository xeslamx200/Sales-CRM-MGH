-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1. Needs 984 + 985.
-- 20261104000986 - Discount approval workflow for bookings, richer booking reads, and the customer-payments read.
-- Forward migration: migration 985 is untouched. It REPLACES (create or replace / drop + create) functions of 985 so that a discount can no longer
-- take effect on a booking without the required authorization, and adds one table. No existing row is changed.
--
-- Policy (fixed in the database; the effective percentage of a FIXED discount = amount / original price):
--     0 %  .. 10 %   employee  - applies at once (recorded as an approved request, approver = the requester)
--   > 10 %  .. 25 %   manager   - the booking is created at the FULL price; the discount is a PENDING request until a manager / admin approves it
--   > 25 %  .. 100 %  admin     - same, but only a company admin may approve (a 100 % discount is always admin)
--   * A reason (>= 3 characters) is mandatory for every discount.
--   * A requester can never approve their own pending request (a pending request always needs a manager or admin, never the requester).
--   * Approving applies the discount to the booking through a guarded update that checks the approved request row itself, so no direct call,
--     no direct UPDATE and not even the owner role can change a booking's discount without a matching approved request.
--   * A pending or rejected discount NEVER changes the booking price, the remaining balance, or any total: only an approved one does.
--   * Approval is refused if the money already pending + confirmed on the booking is more than the discounted final price.
--   * Requests are immutable except the single pending -> approved|rejected decision; never deleted; every step is also audit-logged.
--   * Cancelling a booking rejects its pending requests.
-- Rollback: supabase/proposed/rollbacks/20261104000986_booking_discount_approval.rollback.sql (refuses while any request exists)

-- ------------------------------------------------------------------ 1. pure helpers (exact numeric arithmetic, no rounding of the percentage)
create or replace function app.discount_amount_for(p_type text, p_value numeric, p_list numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case p_type when 'fixed' then p_value when 'percent' then round(p_list * p_value / 100, 2) else 0 end
$$;
create or replace function app.discount_effective_percent(p_type text, p_value numeric, p_list numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case p_type when 'percent' then p_value when 'fixed' then round(p_value * 100 / p_list, 4) else 0 end
$$;
-- 'none' | 'employee' | 'manager' | 'admin'. Compared on products, never on a rounded percentage.
create or replace function app.discount_required_level(p_type text, p_value numeric, p_list numeric) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_type = 'none' or p_value <= 0 then 'none'
    when p_type = 'percent' then case when p_value <= 10 then 'employee' when p_value <= 25 then 'manager' else 'admin' end
    else case when p_value * 100 <= p_list * 10 then 'employee' when p_value * 100 <= p_list * 25 then 'manager' else 'admin' end
  end
$$;
create or replace function app.can_approve_discount(p_company_id uuid, p_level text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.is_active_user() and app.has_company_access(p_company_id)
     and case p_level when 'employee' then true when 'manager' then app.is_company_manager(p_company_id) when 'admin' then app.is_company_admin(p_company_id) else false end
$$;

-- ------------------------------------------------------------------ 2. requests (the immutable record of every discount asked for)
create table public.booking_discount_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  booking_id uuid not null,
  requested_by uuid not null references public.profiles (id) on delete restrict,
  requested_at timestamptz not null default now(),
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  discount_value numeric(10, 2) not null check (discount_value > 0),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  list_price numeric(14, 2) not null check (list_price > 0),
  requested_amount numeric(14, 2) not null check (requested_amount > 0),
  effective_percent numeric(9, 4) not null check (effective_percent >= 0 and effective_percent <= 100),
  required_level text not null check (required_level in ('employee', 'manager', 'admin')),
  previous_final numeric(14, 2) not null,
  calculated_final numeric(14, 2) not null check (calculated_final >= 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.profiles (id) on delete restrict,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  applied_final numeric(14, 2),
  foreign key (booking_id, company_id) references public.workshop_bookings (id, company_id),
  check (requested_amount <= list_price and calculated_final = list_price - requested_amount),
  check ((status = 'pending' and decided_by is null and decided_at is null and applied_final is null)
      or (status = 'approved' and decided_by is not null and decided_at is not null and applied_final = calculated_final)
      or (status = 'rejected' and decided_by is not null and decided_at is not null and applied_final is null and length(btrim(coalesce(decision_note, ''))) >= 3))
);
create unique index booking_discount_one_pending_uq on public.booking_discount_requests (booking_id) where status = 'pending';
create unique index booking_discount_one_approved_uq on public.booking_discount_requests (booking_id) where status = 'approved';
create index booking_discount_company_idx on public.booking_discount_requests (company_id, status, requested_at desc);
alter table public.booking_discount_requests enable row level security;
revoke all on public.booking_discount_requests from public, anon, authenticated;
grant select on public.booking_discount_requests to authenticated;
grant all on public.booking_discount_requests to service_role;
create policy booking_discount_requests_select on public.booking_discount_requests for select to authenticated
  using (app.has_company_access(company_id) and (requested_by = (select auth.uid()) or app.is_company_manager(company_id)));

-- one decision per request, through decide-functions only; nothing else may change and nothing is deleted
create or replace function app.guard_discount_request() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'discount.immutable' using errcode = '42501'; end if;
  if old.status <> 'pending' or new.status = 'pending' or coalesce(current_setting('app.discount_decision', true), '') <> 'on'
     or (new.id, new.company_id, new.booking_id, new.requested_by, new.requested_at, new.discount_type, new.discount_value, new.reason, new.list_price,
         new.requested_amount, new.effective_percent, new.required_level, new.previous_final, new.calculated_final)
        is distinct from
        (old.id, old.company_id, old.booking_id, old.requested_by, old.requested_at, old.discount_type, old.discount_value, old.reason, old.list_price,
         old.requested_amount, old.effective_percent, old.required_level, old.previous_final, old.calculated_final) then
    raise exception 'discount.immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger booking_discount_requests_guard before update or delete on public.booking_discount_requests
  for each row execute function app.guard_discount_request();
create trigger booking_discount_requests_no_truncate before truncate on public.booking_discount_requests
  for each statement execute function app.guard_discount_request();

-- ------------------------------------------------------------------ 3. booking guard: a discount may only appear through an APPROVED request
create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.currency, new.list_price, new.note, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.currency, old.list_price, old.note, old.created_by, old.created_at)
     or old.status <> 'booked' then
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
    if coalesce(current_setting('app.booking_cancel', true), '') <> 'on' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  elsif (new.cancelled_by, new.cancelled_at, new.cancel_reason) is distinct from (old.cancelled_by, old.cancelled_at, old.cancel_reason) then
    raise exception 'booking.immutable' using errcode = '42501';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ 4. create a booking (same signature as 985; the discount now follows the policy)
create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0);
  v_level text; v_damt numeric := 0; v_apply boolean; v_id uuid; v_req_id uuid;
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
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.status = 'booked' and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  if g.capacity is not null and (select count(*) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked') >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_price.price,
          case when v_apply then v_dtype else 'none' end, case when v_apply then v_dval else 0 end, case when v_apply then v_damt else 0 end,
          v_price.price - case when v_apply then v_damt else 0 end, case when v_apply and v_dtype <> 'none' then btrim(p_discount_reason) else null end,
          nullif(btrim(p_note), ''), v_uid)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
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
  return v_id;
end $$;

-- ------------------------------------------------------------------ 5. decide a request
create or replace function public.approve_booking_discount(p_request_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.booking_discount_requests; b public.workshop_bookings; m record;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into r from public.booking_discount_requests where id = p_request_id for update;
  if not found or not app.has_company_access(r.company_id) then raise exception 'discount.not_found' using errcode = 'P0002'; end if;
  select * into b from public.workshop_bookings where id = r.booking_id for update;
  if r.status <> 'pending' or b.status <> 'booked' then raise exception 'discount.invalid_transition' using errcode = '23514'; end if;
  if r.requested_by = v_uid then raise exception 'discount.self_approval' using errcode = '42501'; end if;
  if not app.can_approve_discount(r.company_id, r.required_level) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_note is not null and length(p_note) > 300 then raise exception 'discount.invalid_note' using errcode = '23514'; end if;
  select * into m from app.booking_money(array[b.id]);
  if m.confirmed + m.pending > r.calculated_final then raise exception 'discount.exceeds_payments' using errcode = '23514'; end if;
  perform set_config('app.discount_decision', 'on', true);
  update public.booking_discount_requests set status = 'approved', decided_by = v_uid, decided_at = now(), decision_note = nullif(btrim(p_note), ''), applied_final = calculated_final
   where id = r.id;
  perform set_config('app.discount_decision', '', true);
  perform set_config('app.booking_discount_apply', r.id::text, true);
  update public.workshop_bookings set discount_type = r.discount_type, discount_value = r.discount_value, discount_amount = r.requested_amount,
         final_price = r.calculated_final, discount_reason = r.reason where id = b.id;
  perform set_config('app.booking_discount_apply', '', true);
  perform app.write_audit(r.company_id, 'discount.approved', 'workshop_booking', b.id,
    jsonb_build_object('request_id', r.id, 'requested_by', r.requested_by, 'level', r.required_level, 'effective_percent', r.effective_percent,
                       'previous_final', r.previous_final, 'final', r.calculated_final));
end $$;

-- ------------------------------------------------------------------ 5b. ask for a discount on an EXISTING booking (e.g. after a rejection)
-- Same policy as at creation: up to 10 % applies at once, above waits for a manager / admin. One open request per booking; one approved discount per booking.
create or replace function public.request_booking_discount(p_booking_id uuid, p_type text, p_value numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); b public.workshop_bookings; v_type text := lower(btrim(coalesce(p_type, ''))); v_amt numeric; v_level text; v_apply boolean; v_id uuid; m record;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_booking_id for update;
  if not found or not app.has_company_access(b.company_id) or not (b.created_by = v_uid or app.is_company_manager(b.company_id)) then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;
  if b.status <> 'booked' or b.discount_type <> 'none' then raise exception 'discount.invalid_transition' using errcode = '23514'; end if;
  if exists (select 1 from public.booking_discount_requests r where r.booking_id = b.id and r.status = 'pending') then raise exception 'discount.already_pending' using errcode = '23505'; end if;
  if v_type not in ('fixed', 'percent') or p_value is null or p_value <= 0 or p_value <> round(p_value, 2) or (v_type = 'percent' and p_value > 100) or (v_type = 'fixed' and p_value > b.list_price) then
    raise exception 'booking.invalid_discount' using errcode = '23514';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
  v_amt := app.discount_amount_for(v_type, p_value, b.list_price);
  if v_amt <= 0 then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  v_level := app.discount_required_level(v_type, p_value, b.list_price);
  v_apply := v_level = 'employee';
  if v_apply then
    select * into m from app.booking_money(array[b.id]);
    if m.confirmed + m.pending > b.list_price - v_amt then raise exception 'discount.exceeds_payments' using errcode = '23514'; end if;
  end if;
  insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount,
                                                effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
  values (b.company_id, b.id, v_uid, v_type, p_value, btrim(p_reason), b.list_price, v_amt, app.discount_effective_percent(v_type, p_value, b.list_price), v_level,
          b.final_price, b.list_price - v_amt, case when v_apply then 'approved' else 'pending' end, case when v_apply then v_uid end, case when v_apply then now() end,
          case when v_apply then b.list_price - v_amt end)
  returning id into v_id;
  if v_apply then
    perform set_config('app.booking_discount_apply', v_id::text, true);
    update public.workshop_bookings set discount_type = v_type, discount_value = p_value, discount_amount = v_amt, final_price = b.list_price - v_amt, discount_reason = btrim(p_reason) where id = b.id;
    perform set_config('app.booking_discount_apply', '', true);
  end if;
  perform app.write_audit(b.company_id, 'discount.requested', 'workshop_booking', b.id,
    jsonb_build_object('request_id', v_id, 'type', v_type, 'value', p_value, 'effective_percent', app.discount_effective_percent(v_type, p_value, b.list_price),
                       'required_level', v_level, 'auto_approved', v_apply));
  return v_id;
end $$;

-- The requester may withdraw (reject) their own request; an authorised approver may reject it; a reason is required.
create or replace function public.reject_booking_discount(p_request_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.booking_discount_requests;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into r from public.booking_discount_requests where id = p_request_id for update;
  if not found or not app.has_company_access(r.company_id) then raise exception 'discount.not_found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'discount.invalid_transition' using errcode = '23514'; end if;
  if r.requested_by <> v_uid and not app.can_approve_discount(r.company_id, r.required_level) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 300 then raise exception 'discount.reason_required' using errcode = '23514'; end if;
  perform set_config('app.discount_decision', 'on', true);
  update public.booking_discount_requests set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = btrim(p_reason) where id = r.id;
  perform set_config('app.discount_decision', '', true);
  perform app.write_audit(r.company_id, 'discount.rejected', 'workshop_booking', r.booking_id,
    jsonb_build_object('request_id', r.id, 'requested_by', r.requested_by, 'level', r.required_level, 'reason', btrim(p_reason)));
end $$;

-- cancelling a booking closes its pending discount requests (nothing stays pending on a cancelled booking)
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
  perform set_config('app.discount_decision', 'on', true);
  update public.booking_discount_requests set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = 'booking cancelled'
   where booking_id = b.id and status = 'pending';
  perform set_config('app.discount_decision', '', true);
  perform set_config('app.booking_cancel', 'on', true);
  update public.workshop_bookings set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason) where id = b.id;
  perform set_config('app.booking_cancel', '', true);
  perform app.write_audit(b.company_id, 'booking.cancelled', 'workshop_booking', b.id, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- ------------------------------------------------------------------ 6. reads
drop function public.workshop_stats(uuid);
drop function public.workshop_bookings_list(uuid, uuid);
drop function app.booking_money(uuid[]);

create function app.booking_money(p_booking_ids uuid[])
returns table (booking_id uuid, confirmed numeric, pending numeric, confirmed_egp numeric, rejected_count bigint, rejected numeric)
language sql stable security definer set search_path = '' as $$
  select b.id,
         coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0)::numeric(14, 2),
         coalesce(sum(p.amount) filter (where p.status = 'pending'), 0)::numeric(14, 2),
         coalesce(sum(p.amount_egp) filter (where p.status = 'confirmed'), 0)::numeric(14, 2),
         count(p.id) filter (where p.status = 'rejected'),
         coalesce(sum(p.amount) filter (where p.status = 'rejected'), 0)::numeric(14, 2)
  from public.workshop_bookings b left join public.payments p on p.booking_id = b.id
  where b.id = any (p_booking_ids)
  group by b.id
$$;
revoke all on function app.booking_money(uuid[]) from public, anon, authenticated;
grant execute on function app.booking_money(uuid[]) to service_role;

-- the single source of rows for every booking read: visibility (managers all, others their own) is applied here
create or replace function app.booking_rows(p_company_id uuid, p_offering_id uuid, p_group_id uuid)
returns table (booking_id uuid, company_id uuid, offering_id uuid, offering_name text, contact_id uuid, customer_name text, phone text, email text,
               country text, attendance text, group_id uuid, group_name text, group_starts_on date, booked_at timestamptz, booking_status text, currency text,
               list_price numeric, discount_type text, discount_value numeric, discount_amount numeric, final_price numeric,
               confirmed numeric, pending numeric, rejected numeric, remaining numeric, payment_status text, recorded_by text,
               discount_status text, request_id uuid, requested_type text, requested_value numeric, requested_amount numeric, requested_percent numeric,
               requested_final numeric, required_level text, requested_by_name text, discount_reason text)
language sql stable security definer set search_path = '' as $$
  select b.id, b.company_id, b.offering_id, o.name, b.contact_id, k.full_name, k.phone_e164, k.email, b.country::text, b.attendance, b.group_id, g.name, g.starts_on,
         b.created_at, b.status, b.currency::text, b.list_price, b.discount_type, b.discount_value, b.discount_amount, b.final_price,
         m.confirmed, m.pending, m.rejected, greatest(b.final_price - m.confirmed, 0),
         app.booking_payment_status(b.final_price, m.confirmed, m.pending, m.rejected_count, b.status = 'cancelled'), app.user_display_name(b.created_by),
         case when b.discount_type <> 'none' then 'approved' else coalesce(lr.status, 'none') end,
         lr.id, lr.discount_type, lr.discount_value, lr.requested_amount, lr.effective_percent, lr.calculated_final, lr.required_level,
         case when lr.id is not null then app.user_display_name(lr.requested_by) end, coalesce(b.discount_reason, lr.reason)
  from public.workshop_bookings b
  join public.company_offerings o on o.id = b.offering_id
  join public.contacts k on k.id = b.contact_id
  join public.workshop_groups g on g.id = b.group_id
  join lateral (select * from app.booking_money(array[b.id])) m on true
  left join lateral (select r.* from public.booking_discount_requests r where r.booking_id = b.id order by r.requested_at desc limit 1) lr on true
  where b.company_id = p_company_id and (p_offering_id is null or b.offering_id = p_offering_id) and (p_group_id is null or b.group_id = p_group_id)
    and app.can_see_booking(b)
  order by b.created_at desc
$$;
revoke all on function app.booking_rows(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.booking_rows(uuid, uuid, uuid) to service_role;

create function public.workshop_bookings_list(p_offering_id uuid, p_group_id uuid default null)
returns table (booking_id uuid, contact_id uuid, customer_name text, phone text, email text, country text, attendance text, group_id uuid, group_name text,
               group_starts_on date, booked_at timestamptz, booking_status text, currency text, list_price numeric, discount_type text, discount_value numeric,
               discount_amount numeric, final_price numeric, confirmed numeric, pending numeric, remaining numeric, payment_status text, recorded_by text,
               rejected numeric, discount_status text, request_id uuid, requested_type text, requested_value numeric, requested_amount numeric,
               requested_percent numeric, requested_final numeric, required_level text, requested_by_name text, discount_reason text, offering_id uuid, offering_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.company_offerings where id = p_offering_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
  select r.booking_id, r.contact_id, r.customer_name, r.phone, r.email, r.country, r.attendance, r.group_id, r.group_name, r.group_starts_on, r.booked_at, r.booking_status,
         r.currency, r.list_price, r.discount_type, r.discount_value, r.discount_amount, r.final_price, r.confirmed, r.pending, r.remaining, r.payment_status, r.recorded_by,
         r.rejected, r.discount_status, r.request_id, r.requested_type, r.requested_value, r.requested_amount, r.requested_percent, r.requested_final, r.required_level,
         r.requested_by_name, r.discount_reason, r.offering_id, r.offering_name
  from app.booking_rows(v_company, p_offering_id, p_group_id) r;
end $$;

-- One booking with all its derived figures (same shape as workshop_bookings_list). Nothing for a booking the caller may not see.
create or replace function public.booking_detail(p_booking_id uuid)
returns table (booking_id uuid, contact_id uuid, customer_name text, phone text, email text, country text, attendance text, group_id uuid, group_name text,
               group_starts_on date, booked_at timestamptz, booking_status text, currency text, list_price numeric, discount_type text, discount_value numeric,
               discount_amount numeric, final_price numeric, confirmed numeric, pending numeric, remaining numeric, payment_status text, recorded_by text,
               rejected numeric, discount_status text, request_id uuid, requested_type text, requested_value numeric, requested_amount numeric,
               requested_percent numeric, requested_final numeric, required_level text, requested_by_name text, discount_reason text, offering_id uuid, offering_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid; v_off uuid;
begin
  select b.company_id, b.offering_id into v_company, v_off from public.workshop_bookings b where b.id = p_booking_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'booking.not_found' using errcode = 'P0002'; end if;
  return query
  select r.booking_id, r.contact_id, r.customer_name, r.phone, r.email, r.country, r.attendance, r.group_id, r.group_name, r.group_starts_on, r.booked_at, r.booking_status,
         r.currency, r.list_price, r.discount_type, r.discount_value, r.discount_amount, r.final_price, r.confirmed, r.pending, r.remaining, r.payment_status, r.recorded_by,
         r.rejected, r.discount_status, r.request_id, r.requested_type, r.requested_value, r.requested_amount, r.requested_percent, r.requested_final, r.required_level,
         r.requested_by_name, r.discount_reason, r.offering_id, r.offering_name
  from app.booking_rows(v_company, v_off, null) r where r.booking_id = p_booking_id;
  if not found then raise exception 'booking.not_found' using errcode = 'P0002'; end if;      -- the booking exists but the caller may not see it
end $$;

-- Every payment recorded on a booking (any recorder), for those who may see the booking.
create or replace function public.booking_payments(p_booking_id uuid)
returns table (payment_id uuid, amount numeric, currency text, amount_egp numeric, kind text, paid_on date, status text, note text, review_note text, recorded_by text,
               reviewed_by text, created_at timestamptz, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare b public.workshop_bookings;
begin
  select * into b from public.workshop_bookings where id = p_booking_id;
  if not found or not app.can_see_booking(b) then raise exception 'booking.not_found' using errcode = 'P0002'; end if;
  return query
  select p.id, p.amount, p.currency::text, p.amount_egp, p.kind, p.paid_on, p.status, p.note, p.review_note, app.user_display_name(p.created_by),
         case when p.reviewed_by is not null then app.user_display_name(p.reviewed_by) end, p.created_at, p.reviewed_at
  from public.payments p where p.booking_id = p_booking_id order by p.created_at;
end $$;

-- Customer payments: every booking of a company with its money, filterable. Dates are booking dates in the company time zone.
create or replace function public.customer_payment_rows(p_company_id uuid, p_offering_id uuid default null, p_group_id uuid default null, p_contact_id uuid default null,
                                                        p_status text default null, p_currency text default null, p_from date default null, p_to date default null)
returns table (booking_id uuid, offering_id uuid, offering_name text, contact_id uuid, customer_name text, phone text, group_id uuid, group_name text, country text,
               attendance text, currency text, list_price numeric, discount_amount numeric, final_price numeric, confirmed numeric, pending numeric, rejected numeric,
               remaining numeric, payment_status text, booking_status text, booked_at timestamptz, discount_status text)
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('paid', 'partially_paid', 'unpaid', 'pending_approval', 'rejected', 'cancelled') then raise exception 'filter.invalid' using errcode = '22023'; end if;
  select timezone into v_tz from public.companies where id = p_company_id;
  return query
  select r.booking_id, r.offering_id, r.offering_name, r.contact_id, r.customer_name, r.phone, r.group_id, r.group_name, r.country, r.attendance, r.currency,
         r.list_price, r.discount_amount, r.final_price, r.confirmed, r.pending, r.rejected, r.remaining, r.payment_status, r.booking_status, r.booked_at, r.discount_status
  from app.booking_rows(p_company_id, p_offering_id, p_group_id) r
  where (p_contact_id is null or r.contact_id = p_contact_id) and (p_status is null or r.payment_status = p_status)
    and (p_currency is null or r.currency = upper(btrim(p_currency)))
    and (p_from is null or (r.booked_at at time zone v_tz)::date >= p_from) and (p_to is null or (r.booked_at at time zone v_tz)::date <= p_to);
end $$;

-- Headline numbers of a workshop; every money figure is per currency (never summed across currencies).
create function public.workshop_stats(p_offering_id uuid)
returns table (total_bookings bigint, active_bookings bigint, cancelled_bookings bigint, customers bigint, paid bigint, partially_paid bigint, unpaid bigint,
               pending_approval bigint, rejected bigint, online_participants bigint, offline_participants bigint, discounted_bookings bigint, pending_discounts bigint,
               rejected_discounts bigint, by_currency jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.company_offerings where id = p_offering_id;
  if v_company is null or auth.uid() is null or not app.is_active_user() or not app.has_company_access(v_company) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
  with l as (select * from app.booking_rows(v_company, p_offering_id, null)),
  cur as (select x.currency, sum(x.confirmed) as collected, sum(x.pending) as pending, sum(x.rejected) as rejected,
                 sum(x.final_price - least(x.confirmed, x.final_price)) as outstanding, sum(x.final_price) as total_final, sum(x.list_price) as total_list,
                 sum(x.discount_amount) as discounts
          from l x where x.booking_status = 'booked' group by x.currency)
  select count(*), count(*) filter (where booking_status = 'booked'), count(*) filter (where booking_status = 'cancelled'),
         count(distinct contact_id) filter (where booking_status = 'booked'),
         count(*) filter (where payment_status = 'paid'), count(*) filter (where payment_status = 'partially_paid'), count(*) filter (where payment_status = 'unpaid'),
         count(*) filter (where payment_status = 'pending_approval'), count(*) filter (where payment_status = 'rejected'),
         count(*) filter (where booking_status = 'booked' and attendance = 'online'), count(*) filter (where booking_status = 'booked' and attendance = 'offline'),
         count(*) filter (where booking_status = 'booked' and discount_amount > 0), count(*) filter (where discount_status = 'pending' and booking_status = 'booked'),
         count(*) filter (where discount_status = 'rejected'),
         coalesce((select jsonb_agg(jsonb_build_object('currency', c.currency, 'collected', c.collected, 'pending', c.pending, 'rejected', c.rejected, 'outstanding', c.outstanding,
                                                     'total_final', c.total_final, 'total_list', c.total_list, 'discounts', c.discounts) order by c.currency) from cur c), '[]'::jsonb)
  from l;
end $$;

-- Discount requests the caller may see (managers and admins: the company's; everyone: their own) with whether THEY may decide each one.
create or replace function public.discount_requests_list(p_company_id uuid, p_status text default 'pending')
returns table (request_id uuid, booking_id uuid, customer_name text, offering_name text, group_name text, currency text, list_price numeric, discount_type text, discount_value numeric,
               requested_amount numeric, effective_percent numeric, required_level text, reason text, previous_final numeric, calculated_final numeric, status text,
               requested_by_name text, requested_at timestamptz, decided_by_name text, decided_at timestamptz, decision_note text, can_decide boolean, is_mine boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then raise exception 'filter.invalid' using errcode = '22023'; end if;
  return query
  select r.id, r.booking_id, k.full_name, o.name, g.name, b.currency::text, r.list_price, r.discount_type, r.discount_value, r.requested_amount, r.effective_percent,
         r.required_level, r.reason, r.previous_final, r.calculated_final, r.status, app.user_display_name(r.requested_by), r.requested_at,
         case when r.decided_by is not null then app.user_display_name(r.decided_by) end, r.decided_at, r.decision_note,
         (r.status = 'pending' and r.requested_by <> auth.uid() and app.can_approve_discount(r.company_id, r.required_level) and b.status = 'booked'), (r.requested_by = auth.uid())
  from public.booking_discount_requests r
  join public.workshop_bookings b on b.id = r.booking_id join public.contacts k on k.id = b.contact_id
  join public.company_offerings o on o.id = b.offering_id join public.workshop_groups g on g.id = b.group_id
  where r.company_id = p_company_id and (p_status is null or r.status = p_status)
    and (r.requested_by = auth.uid() or app.is_company_manager(r.company_id))
  order by r.requested_at desc;
end $$;

revoke all on function public.booking_detail(uuid), public.booking_payments(uuid), public.request_booking_discount(uuid, text, numeric, text), public.approve_booking_discount(uuid, text), public.reject_booking_discount(uuid, text), public.workshop_bookings_list(uuid, uuid),
  public.customer_payment_rows(uuid, uuid, uuid, uuid, text, text, date, date), public.workshop_stats(uuid), public.discount_requests_list(uuid, text),
  public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text), public.cancel_workshop_booking(uuid, text),
  app.guard_discount_request(), app.can_approve_discount(uuid, text), app.discount_amount_for(text, numeric, numeric), app.discount_effective_percent(text, numeric, numeric),
  app.discount_required_level(text, numeric, numeric) from public, anon;
grant execute on function public.booking_detail(uuid), public.booking_payments(uuid), public.request_booking_discount(uuid, text, numeric, text), public.approve_booking_discount(uuid, text), public.reject_booking_discount(uuid, text), public.workshop_bookings_list(uuid, uuid),
  public.customer_payment_rows(uuid, uuid, uuid, uuid, text, text, date, date), public.workshop_stats(uuid), public.discount_requests_list(uuid, text),
  public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text), public.cancel_workshop_booking(uuid, text),
  app.can_approve_discount(uuid, text), app.discount_amount_for(text, numeric, numeric), app.discount_effective_percent(text, numeric, numeric),
  app.discount_required_level(text, numeric, numeric) to authenticated, service_role;
