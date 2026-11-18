-- A payment is credited to the owner of the booking, whoever typed it; payments credited to somebody else are corrected once (migration 1022).
begin;
select tests.logout();

do $$
declare w uuid; g uuid; c uuid;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Credit W', 'workshop') returning id into w;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'CG1', array[date '2026-12-06'], date '2026-12-06', date '2026-12-06') returning id into g;
  insert into tests.refs values ('cw', w), ('cg1', g);
  insert into public.contacts (full_name, phone_e164, email) values ('Credit 1', '+2010555' || '00001', 'credit1@example.test') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
  insert into tests.refs values ('cc1', c);
end $$;
create temp table r (b uuid, p1 uuid, p2 uuid, p3 uuid);
insert into r default values;
grant all on r to public;

-- the booking belongs to the employee who made it
select tests.login('agent_a1');
update r set b = public.create_workshop_booking(p_contact_id := tests.ref('cc1'), p_group_id := tests.ref('cg1'), p_country := 'EG', p_attendance := 'online', p_price := 1000, p_currency := 'EGP');
update r set p1 = public.record_booking_payment((select b from r), 100);
select tests.eq((select created_by from public.payments where id = (select p1 from r)), tests.uid('agent_a1'), 'the owner typing the payment: credited to the owner');

-- a manager and the company admin type payments on the employee's booking: still credited to the employee
select tests.login('mgr_a');
update r set p2 = public.record_booking_payment((select b from r), 200);
select tests.login('admin_a');
update r set p3 = public.record_booking_payment((select b from r), 300);
select tests.eq((select created_by from public.payments where id = (select p2 from r)), tests.uid('agent_a1'), 'a manager types it: credited to the booking owner');
select tests.eq((select created_by from public.payments where id = (select p3 from r)), tests.uid('agent_a1'), 'the company admin types it: credited to the booking owner');
select tests.eq((select (metadata->>'entered_by') from public.audit_logs where action = 'payment.recorded' and entity_id = (select p3 from r)), tests.uid('admin_a')::text, 'the audit log still says who typed it');

-- one-time correction of a payment that was credited to somebody else (how the old rule left them)
select tests.logout();
alter table public.payments disable trigger user;
update public.payments set created_by = tests.uid('admin_a') where id = (select p3 from r);
alter table public.payments enable trigger user;
select tests.eq((select created_by from public.payments where id = (select p3 from r)), tests.uid('admin_a'), 'setup: one payment is credited to somebody else');
select tests.throws($q$update public.payments set created_by = (select created_by from public.payments where id = (select p1 from r)) where id = (select p3 from r)$q$, 'payment.immutable', 'the credit cannot be changed by hand');
select tests.eq(app.credit_payments_to_booking_owners(), 1, 'exactly the mismatched payment is corrected');
select tests.eq((select created_by from public.payments where id = (select p3 from r)), tests.uid('agent_a1'), 'and now credited to the booking owner');
select tests.eq((select count(*) from public.finance_edits where entity_id = (select p3 from r) and reason = 'نسبة الدفعة لصاحب الحجز (قاعدة جديدة)'), 1::bigint, 'the correction is in the history');
select tests.eq((select count(*) from public.audit_logs where action = 'payment.credit_corrected' and entity_id = (select p3 from r)), 1::bigint, 'and in the audit log');
select tests.eq(app.credit_payments_to_booking_owners(), 0, 'run again: nothing left to correct');
rollback;
