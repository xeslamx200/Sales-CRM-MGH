-- 20261104001017 - The payment typed while booking is kept even when the booking still waits for approval.
--
-- Bookings made by anybody but a company admin wait for approval (migration 1012) and the booking form used to DROP the amount and the receipt typed with
-- them: the payment was only attempted for approved bookings, so after approval the booking showed "not paid". Now:
--  * record_booking_payment accepts a booking that waits for approval (booked or pending_approval): the payment is recorded as usual, status 'pending'.
--  * review_payment refuses to CONFIRM a payment of a booking that still waits for approval (payment.booking_awaiting_approval); rejecting is allowed.
--    So nothing is counted before the booking is approved (only confirmed payments count), exactly as before; the amount and the receipt are simply no
--    longer lost.
-- Rollback: supabase/rollbacks/20261104001017_payment_on_pending_booking.rollback.sql (restores the 1016 / 983 functions; payments already recorded stay).

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

create or replace function public.review_payment(p_id uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); p public.payments; v_restricted boolean;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_decision not in ('confirmed', 'rejected') then raise exception 'payment.invalid_decision' using errcode = '23514'; end if;
  select * into p from public.payments where id = p_id for update;
  if not found then raise exception 'payment.not_found' using errcode = 'P0002'; end if;
  if p_decision = 'confirmed' and p.booking_id is not null
     and exists (select 1 from public.workshop_bookings wb where wb.id = p.booking_id and wb.status = 'pending_approval') then
    raise exception 'payment.booking_awaiting_approval' using errcode = '23514';
  end if;
  v_restricted := exists (select 1 from public.payment_approval_policy pol where pol.company_id = p.company_id);
  if v_restricted then
    if not app.can_review_payments(p.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  elsif not app.is_company_manager(p.company_id) then
    raise exception 'payment.not_found' using errcode = 'P0002';
  end if;
  if p.created_by = v_uid and not app.is_company_admin(p.company_id) then raise exception 'payment.cannot_review_own' using errcode = '42501'; end if;
  if p.status = 'rejected'
     or (p.status = 'confirmed' and (p_decision <> 'rejected' or not (v_restricted or app.is_company_admin(p.company_id)))) then
    raise exception 'payment.invalid_transition' using errcode = '23514';
  end if;
  if p_decision = 'rejected' and (p_note is null or btrim(p_note) = '') then raise exception 'payment.reason_required' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  perform set_config('app.payment_review', 'on', true);
  update public.payments set status = p_decision, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '') where id = p_id;
  perform set_config('app.payment_review', '', true);
  perform app.write_audit(p.company_id, 'payment.' || p_decision, 'payment', p.id, jsonb_build_object('from', p.status, 'restricted_policy', v_restricted));
end $$;
