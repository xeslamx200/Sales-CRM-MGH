-- The employee types the price; paid in full or a deposit with a reminder day (migration 1020).
begin;
select tests.logout();

do $$
declare w uuid; g uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Typed W', 'workshop') returning id into w;
  insert into tests.refs values ('tw', w);
  -- NO price rows at all: the price is typed
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'TG1', array[date '2026-12-06', date '2026-12-08'], date '2026-12-06', date '2026-12-08') returning id into g;
  insert into tests.refs values ('tg1', g);
  for i in 1..3 loop
    insert into public.contacts (full_name, phone_e164, email) values ('Typed ' || i, '+2010999' || lpad(i::text, 5, '0'), 'typed' || i || '@example.test') returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('t' || i, c);
  end loop;
end $$;
create or replace function pg_temp.bk(p_user text, p_contact text, p_price numeric, p_cur text, p_kind text default 'full', p_date date default null,
                                      p_mode text default 'full', p_remind date default null)
returns uuid language plpgsql as $$ begin perform tests.login(p_user);
  return public.create_workshop_booking(p_contact_id := tests.ref(p_contact), p_group_id := tests.ref('tg1'), p_country := 'EG', p_attendance := 'online',
    p_kind := p_kind, p_session_date := p_date, p_price := p_price, p_currency := p_cur, p_payment_mode := p_mode, p_remind_on := p_remind); end $$;
create temp table r (a uuid, b uuid, c uuid);
insert into r default values;
grant all on r to public;

-- the typed price: validated, frozen on the booking, no price table needed
select tests.throws($q$select pg_temp.bk('admin_a', 't1', 0, 'EGP')$q$, 'booking.invalid_price', 'zero price refused');
select tests.throws($q$select pg_temp.bk('admin_a', 't1', 100.555, 'EGP')$q$, 'booking.invalid_price', 'two decimals at most');
select tests.throws($q$select pg_temp.bk('admin_a', 't1', 100, 'EG')$q$, 'booking.invalid_price', 'the currency is 3 letters');
select tests.throws($q$select pg_temp.bk('admin_a', 't1', 100, 'EGP', 'session', date '2026-12-07')$q$, 'booking.invalid_session', 'a session must be one of the group dates');
update r set a = pg_temp.bk('admin_a', 't1', 4500, 'egp');
select tests.eq((select list_price || ' ' || currency || ' ' || final_price || ' ' || payment_mode from public.workshop_bookings where id = (select a from r)),
  '4500.00 EGP 4500.00 full', 'the typed price and currency are the booking price; paid in full by default');
update r set b = pg_temp.bk('admin_a', 't2', 700.50, 'QAR', 'session', date '2026-12-08');
select tests.eq((select list_price || ' ' || currency || ' ' || booking_kind from public.workshop_bookings where id = (select b from r)), '700.50 QAR session', 'one session at its own typed price');
select tests.eq((select (metadata->>'typed_price') from public.audit_logs where action = 'booking.created' and entity_id = (select a from r)), 'true', 'the audit log says the price was typed');

-- the old path (no price typed) still needs the price table
select tests.throws($q$select public.create_workshop_booking(p_contact_id := tests.ref('t3'), p_group_id := tests.ref('tg1'), p_country := 'EG', p_attendance := 'online')$q$, 'booking.price_not_configured', 'no price typed and no price row: refused');

-- deposit: needs a reminder day after today, within a year; a full payment has none
select tests.throws($q$select pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'deposit', null)$q$, 'booking.invalid_reminder', 'a deposit needs a reminder day');
select tests.throws($q$select pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'deposit', current_date - 1)$q$, 'booking.invalid_reminder', 'the reminder day cannot be in the past');
select tests.throws($q$select pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'deposit', current_date + 400)$q$, 'booking.invalid_reminder', 'within a year');
select tests.throws($q$select pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'full', current_date + 5)$q$, 'booking.invalid_value', 'a full payment has no reminder day');
select tests.throws($q$select pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'monthly', null)$q$, 'booking.invalid_value', 'unknown payment mode');
update r set c = pg_temp.bk('admin_a', 't3', 3000, 'EGP', 'full', null, 'deposit', current_date + 5);
select tests.eq((select payment_mode || ' ' || (remind_on = current_date + 5)::text from public.workshop_bookings where id = (select c from r)), 'deposit true', 'a deposit keeps its reminder day');

-- immutable
select tests.logout();
select tests.throws($q$update public.workshop_bookings set remind_on = current_date + 9 where id = (select c from r)$q$, 'booking.immutable', 'the reminder day cannot change afterwards');
select tests.throws($q$update public.workshop_bookings set payment_mode = 'full', remind_on = null where id = (select c from r)$q$, 'booking.immutable', 'the payment mode cannot change afterwards');

-- the reminder job: only a deposit whose day has come and who still owes money; once
select tests.login('agent_a1');
select tests.throws($q$select public.generate_deposit_reminders()$q$, 'permission denied', 'users cannot call the reminder job');
select tests.logout();
select tests.eq(public.generate_deposit_reminders(), 0, 'nothing is due before the reminder day');
-- the day comes (a test shortcut: set it directly as the table owner)
alter table public.workshop_bookings disable trigger user;
update public.workshop_bookings set remind_on = current_date - 1 where id = (select c from r);
alter table public.workshop_bookings enable trigger user;
select tests.eq(public.generate_deposit_reminders(), 1, 'the deposit with money owed is reminded');
select tests.eq((select count(*) from public.notifications where type = 'deposit_reminder' and entity_id = (select c from r) and user_id = tests.uid('admin_a')), 1::bigint, 'the employee who owns the booking gets the notification');
select tests.eq(public.generate_deposit_reminders(), 0, 'reminded once');
rollback;
