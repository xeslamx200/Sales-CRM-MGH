-- DATA STEP (Staging): remove the TEST bookings and payments entered on 8-10 Nov 2026 (the owner said they were only for testing).
-- Scope, checked below and refused if different (so nothing real entered later can be deleted by accident):
--   5 workshop_bookings, 7 payments, 1 booking_discount_requests, 6 attachments of entity_type 'payment' - all of company Marketing Growth Hub (mgh).
-- Bookings and payments are immutable by design (guard triggers refuse DELETE), so this one-off step switches those triggers off for its own
-- transaction only and switches them on again before it ends. The audit log is NOT touched (it is immutable history and holds no foreign keys to these rows).
-- The proof image FILES in Storage (bucket attachments) are removed separately by the runner after the commit.
-- Ends with ROLLBACK by default; the runner replaces the last line with COMMIT only after the approved dry-run.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare v_mgh uuid; b int; p int; d int; a int; other int;
begin
  select id into v_mgh from public.companies where slug = 'mgh';
  if v_mgh is null then raise exception 'company mgh not found'; end if;
  select count(*) into b from public.workshop_bookings;
  select count(*) into p from public.payments;
  select count(*) into d from public.booking_discount_requests;
  select count(*) into a from public.attachments where entity_type = 'payment';
  select (select count(*) from public.workshop_bookings where company_id <> v_mgh) + (select count(*) from public.payments where company_id <> v_mgh) into other;
  if b <> 5 or p <> 7 or d <> 1 or a <> 6 or other <> 0 then
    raise exception 'refused: found % bookings, % payments, % discount requests, % proofs, % rows outside mgh (expected 5/7/1/6/0)', b, p, d, a, other;
  end if;
end $$;

-- the paths of the proof files, kept for the runner (printed, then the files are removed from Storage)
select storage_path from public.attachments where entity_type = 'payment' order by storage_path;

alter table public.payments disable trigger payments_guard;
alter table public.workshop_bookings disable trigger workshop_bookings_guard;
alter table public.booking_discount_requests disable trigger booking_discount_requests_guard;
alter table public.attachments disable trigger user;   -- delete guard of attachments, if any

delete from public.attachments where entity_type = 'payment';
delete from public.payments;
delete from public.booking_discount_requests;
delete from public.workshop_bookings;

alter table public.attachments enable trigger user;
alter table public.booking_discount_requests enable trigger booking_discount_requests_guard;
alter table public.workshop_bookings enable trigger workshop_bookings_guard;
alter table public.payments enable trigger payments_guard;

select (select count(*) from public.workshop_bookings) as bookings_left, (select count(*) from public.payments) as payments_left,
       (select count(*) from public.booking_discount_requests) as discount_requests_left, (select count(*) from public.attachments where entity_type = 'payment') as proofs_left,
       (select count(*) from pg_trigger where tgname in ('payments_guard', 'workshop_bookings_guard', 'booking_discount_requests_guard') and tgenabled = 'O') as guards_enabled;
rollback;
