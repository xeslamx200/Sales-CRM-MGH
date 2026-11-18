-- 20261104001021 - A super admin can correct a booking's price / payment mode / reminder day and a payment's amount, with a mandatory reason and a
-- before / after history that nobody can change.
--
--  * public.finance_edits: one immutable row per correction (who, when, why, old and new values). Read through booking_edit_history only.
--  * public.edit_workshop_booking(booking, price, currency, payment mode, reminder day, reason): super admin only, open bookings only. The discount choice
--    stays; its amount is recomputed on the new price. The currency cannot change once a payment exists. A pending discount request blocks the edit.
--    A changed reminder day (or mode) re-arms the reminder. Audited.
--  * public.edit_payment_amount(payment, amount, reason): super admin only, pending or confirmed payments (not rejected). Audited.
--  * app.guard_booking / app.guard_payment let exactly those changes through when the function's own transaction flag is on.
-- Rollback: supabase/rollbacks/20261104001021_finance_edits.rollback.sql (refuses while a correction exists).

create table public.finance_edits (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete restrict,
  entity_type text not null check (entity_type in ('booking', 'payment')),
  entity_id uuid not null,
  booking_id uuid references public.workshop_bookings (id) on delete restrict,
  edited_by uuid not null references public.profiles (id) on delete restrict,
  edited_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  old_values jsonb not null,
  new_values jsonb not null
);
create index finance_edits_booking_idx on public.finance_edits (booking_id, edited_at desc);
alter table public.finance_edits enable row level security;
revoke all on public.finance_edits from public, anon, authenticated;
grant all on public.finance_edits to service_role;
create trigger finance_edits_no_update before update or delete on public.finance_edits
  for each row execute function app.block_price_history_mutation();
create trigger finance_edits_no_truncate before truncate on public.finance_edits
  for each statement execute function app.block_price_history_mutation();

create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
  -- a super admin's correction (edit_workshop_booking sets the flag in its own transaction): only the price, currency, discount amount, final price,
  -- payment mode and reminder day of an OPEN booking; everything else (who, what, when, status, the discount choice) stays frozen
  if coalesce(current_setting('app.booking_edit', true), '') = 'on' and old.status in ('booked', 'pending_approval') and new.status = old.status
     and (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.note, new.created_by, new.created_at, new.booking_kind, new.session_date,
          new.discount_type, new.discount_value, new.discount_reason, new.cancelled_by, new.cancelled_at, new.cancel_reason)
         is not distinct from
         (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.note, old.created_by, old.created_at, old.booking_kind, old.session_date,
          old.discount_type, old.discount_value, old.discount_reason, old.cancelled_by, old.cancelled_at, old.cancel_reason) then
    return new;
  end if;
  if (new.company_id, new.contact_id, new.offering_id, new.group_id, new.country, new.attendance, new.currency, new.list_price, new.note, new.created_by, new.created_at, new.booking_kind, new.session_date, new.payment_mode, new.remind_on)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.group_id, old.country, old.attendance, old.currency, old.list_price, old.note, old.created_by, old.created_at, old.booking_kind, old.session_date, old.payment_mode, old.remind_on)
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

create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'payment.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.currency, new.fx_rate_to_egp, new.fx_source, new.fx_fetched_at,
      new.kind, new.paid_on, new.note, new.created_by, new.created_at, new.booking_id)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.currency, old.fx_rate_to_egp, old.fx_source, old.fx_fetched_at,
      old.kind, old.paid_on, old.note, old.created_by, old.created_at, old.booking_id) then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  -- the amount changes only through edit_payment_amount (a super admin's correction, flag set in its own transaction)
  if new.amount is distinct from old.amount and coalesce(current_setting('app.payment_edit', true), '') <> 'on' then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('app.payment_review', true), '') <> 'on' and coalesce(current_setting('app.payment_edit', true), '') <> 'on' then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.edit_workshop_booking(p_id uuid, p_price numeric, p_currency text, p_payment_mode text, p_remind_on date, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  b public.workshop_bookings; v_uid uuid := auth.uid(); v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_mode text := lower(btrim(coalesce(p_payment_mode, 'full'))); v_reason text := btrim(coalesce(p_reason, ''));
  v_tz text; v_today date; v_damt numeric := 0; v_final numeric;
begin
  if v_uid is null or not app.is_active_user() or not app.is_super_admin() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_id for update;
  if not found then raise exception 'booking.not_found' using errcode = 'P0002'; end if;
  if b.status not in ('booked', 'pending_approval') then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if length(v_reason) < 3 or length(v_reason) > 300 then raise exception 'booking.edit_reason_required' using errcode = '23514'; end if;
  if p_price is null or p_price <= 0 or p_price > 1000000000 or p_price <> round(p_price, 2) or v_cur !~ '^[A-Z]{3}$' then raise exception 'booking.invalid_price' using errcode = '23514'; end if;
  if v_mode not in ('full', 'deposit') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  select c.timezone into v_tz from public.companies c where c.id = b.company_id;
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  if v_mode = 'deposit' then
    if p_remind_on is null or (p_remind_on is distinct from b.remind_on and (p_remind_on <= v_today or p_remind_on > v_today + 365)) then
      raise exception 'booking.invalid_reminder' using errcode = '23514';
    end if;
  elsif p_remind_on is not null then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if v_cur <> b.currency and exists (select 1 from public.payments p where p.booking_id = b.id and p.status <> 'rejected') then
    raise exception 'booking.edit_currency_locked' using errcode = '23514';
  end if;
  if exists (select 1 from public.booking_discount_requests r where r.booking_id = b.id and r.status = 'pending') then
    raise exception 'booking.edit_pending_discount' using errcode = '23514';
  end if;
  if b.discount_type <> 'none' then
    v_damt := app.discount_amount_for(b.discount_type, b.discount_value, p_price);
    if v_damt <= 0 or v_damt >= p_price then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  end if;
  v_final := p_price - v_damt;
  perform set_config('app.booking_edit', 'on', true);
  update public.workshop_bookings set currency = v_cur, list_price = p_price, discount_amount = v_damt, final_price = v_final, payment_mode = v_mode,
    remind_on = case when v_mode = 'deposit' then p_remind_on end,
    reminder_sent_at = case when v_mode = 'deposit' and p_remind_on is not distinct from b.remind_on then b.reminder_sent_at end
  where id = b.id;
  perform set_config('app.booking_edit', '', true);
  insert into public.finance_edits (company_id, entity_type, entity_id, booking_id, edited_by, reason, old_values, new_values)
  values (b.company_id, 'booking', b.id, b.id, v_uid, v_reason,
          jsonb_build_object('list_price', b.list_price, 'final_price', b.final_price, 'currency', b.currency, 'payment_mode', b.payment_mode, 'remind_on', b.remind_on),
          jsonb_build_object('list_price', p_price, 'final_price', v_final, 'currency', v_cur, 'payment_mode', v_mode, 'remind_on', case when v_mode = 'deposit' then p_remind_on end));
  perform app.write_audit(b.company_id, 'booking.edited', 'workshop_booking', b.id,
    jsonb_build_object('reason', v_reason, 'old_final_price', b.final_price, 'new_final_price', v_final, 'old_currency', b.currency, 'new_currency', v_cur,
                       'old_payment_mode', b.payment_mode, 'new_payment_mode', v_mode, 'new_remind_on', case when v_mode = 'deposit' then p_remind_on end));
end $$;

create or replace function public.edit_payment_amount(p_payment_id uuid, p_amount numeric, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payments; v_uid uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason, '')); v_new_egp numeric;
begin
  if v_uid is null or not app.is_active_user() or not app.is_super_admin() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment.not_found' using errcode = 'P0002'; end if;
  if p.status not in ('pending', 'confirmed') then raise exception 'payment.edit_not_allowed' using errcode = '23514'; end if;
  if length(v_reason) < 3 or length(v_reason) > 300 then raise exception 'booking.edit_reason_required' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount, 2) then raise exception 'payment.invalid_amount' using errcode = '23514'; end if;
  perform set_config('app.payment_edit', 'on', true);
  update public.payments set amount = p_amount where id = p.id returning amount_egp into v_new_egp;
  perform set_config('app.payment_edit', '', true);
  insert into public.finance_edits (company_id, entity_type, entity_id, booking_id, edited_by, reason, old_values, new_values)
  values (p.company_id, 'payment', p.id, p.booking_id, v_uid, v_reason,
          jsonb_build_object('amount', p.amount, 'amount_egp', p.amount_egp, 'currency', p.currency, 'status', p.status),
          jsonb_build_object('amount', p_amount, 'amount_egp', v_new_egp, 'currency', p.currency, 'status', p.status));
  perform app.write_audit(p.company_id, 'payment.edited', 'payment', p.id,
    jsonb_build_object('reason', v_reason, 'old_amount', p.amount, 'new_amount', p_amount, 'booking_id', p.booking_id));
end $$;

-- The corrections of one booking (the booking itself and its payments), newest first: super admins and the company's admins.
create or replace function public.booking_edit_history(p_booking_id uuid)
returns table (id bigint, entity_type text, entity_id uuid, edited_at timestamptz, edited_by_name text, reason text, old_values jsonb, new_values jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare b public.workshop_bookings;
begin
  select * into b from public.workshop_bookings where workshop_bookings.id = p_booking_id;
  if not found or not app.can_see_booking(b) or not (app.is_super_admin() or app.is_company_admin(b.company_id)) then raise exception 'booking.not_found' using errcode = 'P0002'; end if;
  return query
  select f.id, f.entity_type, f.entity_id, f.edited_at, app.user_display_name(f.edited_by), f.reason, f.old_values, f.new_values
  from public.finance_edits f where f.booking_id = p_booking_id order by f.edited_at desc, f.id desc;
end $$;

revoke all on function public.edit_workshop_booking(uuid, numeric, text, text, date, text), public.edit_payment_amount(uuid, numeric, text),
  public.booking_edit_history(uuid) from public, anon;
grant execute on function public.edit_workshop_booking(uuid, numeric, text, text, date, text), public.edit_payment_amount(uuid, numeric, text),
  public.booking_edit_history(uuid) to authenticated, service_role;
