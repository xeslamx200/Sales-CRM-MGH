-- A super admin corrects a booking's price / payment mode / reminder day and a payment's amount; reason mandatory; history immutable (migration 1021).
begin;
select tests.logout();

do $$
declare w uuid; g uuid; c uuid;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Edit W', 'workshop') returning id into w;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'EG1', array[date '2026-12-06'], date '2026-12-06', date '2026-12-06') returning id into g;
  insert into tests.refs values ('ew', w), ('eg1', g);
  insert into public.contacts (full_name, phone_e164, email) values ('Edit 1', '+2010666' || '00001', 'edit1@example.test') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
  insert into tests.refs values ('e1', c);
end $$;
create temp table r (b uuid, p uuid, d uuid);
insert into r default values;
grant all on r to public;

select tests.login('admin_a');
update r set b = public.create_workshop_booking(p_contact_id := tests.ref('e1'), p_group_id := tests.ref('eg1'), p_country := 'EG', p_attendance := 'online', p_price := 1000, p_currency := 'EGP');
update r set p = public.record_booking_payment((select b from r), 400);

-- only a super admin edits
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, 'price agreed again')$q$, 'auth.forbidden', 'a company admin cannot edit a booking');
select tests.throws($q$select public.edit_payment_amount((select p from r), 450, 'typo')$q$, 'auth.forbidden', 'a company admin cannot edit a payment');
select tests.login('agent_a1');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, 'price agreed again')$q$, 'auth.forbidden', 'an employee cannot edit a booking');

select tests.login('super');
-- validation
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, '  ')$q$, 'booking.edit_reason_required', 'the reason is mandatory');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 0, 'EGP', 'full', null, 'wrong price')$q$, 'booking.invalid_price', 'zero price refused');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200.555, 'EGP', 'full', null, 'wrong price')$q$, 'booking.invalid_price', 'two decimals at most');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'USD', 'full', null, 'wrong currency')$q$, 'booking.edit_currency_locked', 'the currency is locked once a payment exists');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'deposit', null, 'deposit')$q$, 'booking.invalid_reminder', 'a deposit needs a reminder day');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', current_date + 3, 'x full')$q$, 'booking.invalid_value', 'a full payment has no reminder day');
-- the correction
select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'deposit', current_date + 7, 'price agreed again with the customer');
select tests.eq((select list_price || ' ' || final_price || ' ' || payment_mode || ' ' || (remind_on = current_date + 7)::text from public.workshop_bookings where id = (select b from r)),
  '1200.00 1200.00 deposit true', 'price, mode and reminder day changed');
select tests.eq((select count(*) from public.booking_edit_history((select b from r)) h where h.entity_type = 'booking' and h.reason = 'price agreed again with the customer'), 1::bigint, 'the correction is in the history');
select tests.eq((select count(*) from public.audit_logs where action = 'booking.edited' and entity_id = (select b from r)), 1::bigint, 'and in the audit log');
-- back to a full payment clears the reminder
select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, 'paid in full after all');
select tests.eq((select payment_mode || ' ' || (remind_on is null)::text from public.workshop_bookings where id = (select b from r)), 'full true', 'back to full: no reminder day');

-- a payment amount
select tests.throws($q$select public.edit_payment_amount((select p from r), 450, 'x')$q$, 'booking.edit_reason_required', 'a payment correction needs a reason too');
select tests.throws($q$select public.edit_payment_amount((select p from r), 0, 'typo in the amount')$q$, 'payment.invalid_amount', 'zero refused');
select public.edit_payment_amount((select p from r), 450.50, 'typo: the receipt says 450.50');
select tests.eq((select amount::text from public.payments where id = (select p from r)), '450.50', 'the payment amount changed');
select tests.eq((select (h.old_values->>'amount') || '>' || (h.new_values->>'amount') from public.booking_edit_history((select b from r)) h where h.entity_type = 'payment' and h.entity_id = (select p from r)), '400.00>450.50', 'before and after are kept');
select tests.eq((select count(*) from public.booking_edit_history((select b from r))), 3::bigint, 'the booking page history shows all three corrections');

-- who can read the history
select tests.login('admin_a');
select tests.eq((select count(*) from public.booking_edit_history((select b from r))), 3::bigint, 'the company admin can read the history');
select tests.login('agent_a1');
select tests.throws($q$select * from public.booking_edit_history((select b from r))$q$, 'booking.not_found', 'an employee cannot');

-- everything else stays frozen, and the history cannot be changed
select tests.logout();
select tests.throws($q$update public.workshop_bookings set list_price = 5 where id = (select b from r)$q$, 'booking.immutable', 'a direct update of the price is still refused');
select tests.throws($q$update public.payments set amount = 5 where id = (select p from r)$q$, 'payment.immutable', 'a direct update of the amount is still refused');
select tests.throws($q$update public.finance_edits set reason = 'changed'$q$, 'price.history_immutable', 'the history cannot be updated');
select tests.throws($q$delete from public.finance_edits$q$, 'price.history_immutable', 'or deleted');

-- a cancelled booking is not editable
select tests.login('admin_a');
update r set d = public.create_workshop_booking(p_contact_id := tests.ref('e1'), p_group_id := tests.ref('eg1'), p_country := 'EG', p_attendance := 'online', p_price := 300, p_currency := 'EGP', p_confirm_repeat := true);
select public.cancel_workshop_booking((select d from r), 'test cancel');
select tests.login('super');
select tests.throws($q$select public.edit_workshop_booking((select d from r), 350, 'EGP', 'full', null, 'cancelled one')$q$, 'booking.invalid_transition', 'a cancelled booking cannot be edited');
rollback;
