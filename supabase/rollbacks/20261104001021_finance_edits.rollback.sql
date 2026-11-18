-- Rollback of 20261104001021_finance_edits: refuses while a correction exists (its history would be lost).
do $$ begin
  if exists (select 1 from public.finance_edits) then raise exception 'rollback refused: corrections exist'; end if;
end $$;
drop function public.booking_edit_history(uuid);
drop function public.edit_payment_amount(uuid, numeric, text);
drop function public.edit_workshop_booking(uuid, numeric, text, text, date, text);
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
create or replace function app.guard_booking() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'booking.immutable' using errcode = '42501'; end if;
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
drop table public.finance_edits;
