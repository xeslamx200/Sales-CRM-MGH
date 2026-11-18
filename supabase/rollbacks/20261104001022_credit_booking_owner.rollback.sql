-- Rollback of 20261104001022_credit_booking_owner: the old attribution rule and the old guard come back.
-- Payments already corrected stay credited to the booking owner (their before / after history stays in finance_edits).
drop function app.credit_payments_to_booking_owners();
create or replace function public.record_booking_payment(p_booking_id uuid, p_amount numeric, p_paid_on date default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); b public.workshop_bookings; m record; v_remaining numeric; v_rate numeric; v_fetched timestamptz; v_id uuid; v_kind text; v_over numeric; v_note text;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_booking_id for update;
  if not found or not app.has_company_access(b.company_id) or not (b.created_by = v_uid or app.is_company_manager(b.company_id)) then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;
  -- a booking that waits for approval may already receive its payment (the amount typed and the receipt are kept); the payment itself stays pending and cannot
  -- be confirmed before the booking is approved (review_payment)
  if b.status not in ('booked', 'pending_approval') then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount, 2) then raise exception 'payment.invalid_amount' using errcode = '23514'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'payment.invalid_date' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  select * into m from app.booking_money(array[b.id]);
  v_remaining := b.final_price - m.confirmed - m.pending;
  -- more than what is left is ACCEPTED (the customer did pay it) and marked: the note of the payment says by how much, so everybody who reads it knows
  v_over := greatest(p_amount - greatest(v_remaining, 0), 0);
  v_note := nullif(btrim(p_note), '');
  if v_over > 0 then
    v_note := left('[زيادة عن سعر الحجز بمقدار ' || trim(to_char(v_over, 'FM999999999990.00')) || ' ' || b.currency || '] ' || coalesce(v_note, ''), 1000);
  end if;
  v_kind := case when p_amount >= v_remaining then 'full' else 'partial' end;
  if b.currency = 'EGP' then
    v_rate := 1; v_fetched := null;
  else
    select r.rate_to_egp, r.fetched_at into v_rate, v_fetched from public.fx_rates r where r.currency = b.currency;
    if v_rate is null then raise exception 'payment.rate_unavailable' using errcode = '23514'; end if;
    if v_fetched < now() - interval '48 hours' then raise exception 'payment.rate_stale' using errcode = '23514'; end if;
  end if;
  insert into public.payments (company_id, contact_id, offering_id, booking_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, note, created_by)
  values (b.company_id, b.contact_id, b.offering_id, b.id, p_amount, b.currency, v_rate, case when b.currency = 'EGP' then 'egp' else 'auto' end, v_fetched,
          v_kind, coalesce(p_paid_on, current_date), v_note, case when b.recorded_by is not null then b.created_by else v_uid end)
  returning id into v_id;
  perform app.write_audit(b.company_id, 'payment.recorded', 'payment', v_id,
    jsonb_build_object('credited_to', case when b.recorded_by is not null then b.created_by else v_uid end, 'entered_by', v_uid, 'currency', b.currency, 'offering_id', b.offering_id, 'kind', v_kind, 'overpaid_by', v_over, 'booking_id', b.id));
  return v_id;
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
