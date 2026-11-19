-- The company admin edits bookings / payments like the super admin, and moves a booking to another employee (migration 1023).
begin;
select tests.logout();

do $$
declare w uuid; g uuid; c uuid;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Move W', 'workshop') returning id into w;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'MG1', array[date '2026-12-06'], date '2026-12-06', date '2026-12-06') returning id into g;
  insert into tests.refs values ('mw', w), ('mg1', g);
  insert into public.contacts (full_name, phone_e164, email) values ('Move 1', '+2010777' || '00001', 'move1@example.test') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
  insert into tests.refs values ('m1', c);
end $$;
create temp table r (b uuid, p uuid, d uuid);
insert into r default values;
grant all on r to public;

select tests.login('agent_a1');
update r set b = public.create_workshop_booking(p_contact_id := tests.ref('m1'), p_group_id := tests.ref('mg1'), p_country := 'EG', p_attendance := 'online', p_price := 1000, p_currency := 'EGP');
update r set p = public.record_booking_payment((select b from r), 400);

-- the company admin edits the price and the payment
select tests.login('admin_a');
select public.edit_workshop_booking((select b from r), 1100, 'EGP', 'full', null, 'price agreed again');
select tests.eq((select list_price::text from public.workshop_bookings where id = (select b from r)), '1100.00', 'the company admin edited the price');
select public.edit_payment_amount((select p from r), 450, 'typo in the amount');
select tests.eq((select amount::text from public.payments where id = (select p from r)), '450.00', 'and the payment amount');
-- but not in another company, and not an employee / manager
select tests.login('admin_b');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, 'not mine')$q$, 'auth.forbidden', 'the admin of another company cannot');
select tests.login('mgr_a');
select tests.throws($q$select public.edit_workshop_booking((select b from r), 1200, 'EGP', 'full', null, 'not an admin')$q$, 'auth.forbidden', 'a sales manager cannot');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('agent_a2'), 'moving it')$q$, 'auth.forbidden', 'a sales manager cannot move a booking');
select tests.login('agent_a1');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('agent_a2'), 'moving it')$q$, 'auth.forbidden', 'an employee cannot move a booking');

-- moving the booking
select tests.login('admin_a');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('agent_a2'), ' ')$q$, 'booking.edit_reason_required', 'the reason is mandatory');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('agent_a1'), 'same person')$q$, 'booking.invalid_value', 'the same owner is refused');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('agent_b'), 'other company')$q$, 'booking.owner_not_allowed', 'an employee of another company is refused');
select tests.throws($q$select public.reassign_booking_owner((select b from r), tests.uid('admin_a'), 'an admin is not a sales person')$q$, 'booking.owner_not_allowed', 'a company admin cannot be the owner');
select public.reassign_booking_owner((select b from r), tests.uid('agent_a2'), 'the sale was Maha''s');
select tests.eq((select created_by from public.workshop_bookings where id = (select b from r)), tests.uid('agent_a2'), 'the booking now belongs to the other employee');
select tests.eq((select created_by from public.payments where id = (select p from r)), tests.uid('agent_a2'), 'and its payment is credited to her');
select tests.eq((select count(*) from public.booking_edit_history((select b from r)) h where h.reason = 'the sale was Maha''s'), 2::bigint, 'one history row for the booking and one for the payment');
select tests.eq((select count(*) from public.audit_logs where action = 'booking.owner_changed' and entity_id = (select b from r)), 1::bigint, 'and an audit row');
select tests.login('agent_a1');
select tests.eq((select count(*) from public.workshop_bookings where id = (select b from r)), 0::bigint, 'the previous owner no longer sees it');

-- everything else stays frozen, and a cancelled booking cannot move
select tests.logout();
select tests.throws($q$update public.workshop_bookings set created_by = (select id from public.profiles limit 1) where id = (select b from r)$q$, 'booking.immutable', 'a direct change of owner is still refused');
select tests.login('admin_a');
update r set d = public.create_workshop_booking(p_contact_id := tests.ref('m1'), p_group_id := tests.ref('mg1'), p_country := 'EG', p_attendance := 'online', p_price := 300, p_currency := 'EGP', p_confirm_repeat := true);
select public.cancel_workshop_booking((select d from r), 'test cancel');
select tests.throws($q$select public.reassign_booking_owner((select d from r), tests.uid('agent_a2'), 'cancelled one')$q$, 'booking.invalid_transition', 'a cancelled booking cannot move');
select tests.eq((select count(*) from public.booking_reassign_options(tests.ref('alpha'))), 4::bigint, 'the dialog lists the company''s sales people');
rollback;
