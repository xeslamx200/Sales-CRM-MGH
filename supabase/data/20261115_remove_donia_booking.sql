-- DATA STEP (Staging): remove ONE booking the owner asked to delete: customer Donia Magdy, company NAHJ, workshop "Claude for Teachers", 750 QAR,
-- recorded 2026-11-15 (booking id ce2903b9-f932-4914-a53b-ef16eeee444b).
-- Refused (nothing changes) unless it is still exactly that: that booking exists, it is the ONLY booking in the database, status 'booked',
-- with no payment and no discount request attached. Bookings are immutable by design (guard trigger refuses DELETE), so the guard is switched off
-- for this transaction only and switched on again before it ends. The audit log is not touched (immutable history).
-- Ends with ROLLBACK by default; the runner replaces the last line with COMMIT only after the dry-run.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare b public.workshop_bookings; n int; p int; d int;
begin
  select * into b from public.workshop_bookings where id = 'ce2903b9-f932-4914-a53b-ef16eeee444b';
  select count(*) into n from public.workshop_bookings;
  select count(*) into p from public.payments where booking_id = 'ce2903b9-f932-4914-a53b-ef16eeee444b';
  select count(*) into d from public.booking_discount_requests where booking_id = 'ce2903b9-f932-4914-a53b-ef16eeee444b';
  if b.id is null or n <> 1 or p <> 0 or d <> 0 or b.status <> 'booked' or b.final_price <> 750 or b.currency <> 'QAR'
     or not exists (select 1 from public.contacts c where c.id = b.contact_id and c.full_name = 'Donia Magdy')
     or not exists (select 1 from public.companies c where c.id = b.company_id and c.slug = 'nahj') then
    raise exception 'refused: the booking is not exactly the one approved (found %, % bookings in total, % payments, % discount requests)', b.id, n, p, d;
  end if;
end $$;

alter table public.workshop_bookings disable trigger workshop_bookings_guard;
delete from public.workshop_bookings where id = 'ce2903b9-f932-4914-a53b-ef16eeee444b';
alter table public.workshop_bookings enable trigger workshop_bookings_guard;

select (select count(*) from public.workshop_bookings) as bookings_left,
       (select count(*) from pg_trigger where tgname = 'workshop_bookings_guard' and tgenabled = 'O') as guard_enabled,
       (select count(*) from public.contacts where full_name = 'Donia Magdy') as customer_still_exists;
rollback;
