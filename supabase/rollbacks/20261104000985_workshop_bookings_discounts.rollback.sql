-- ROLLBACK of 20261104000985. Refuses while any booking exists or any payment is linked to a booking. Restores guard_payment as in migration 980.
-- Run with psql -1.
do $$ begin
  if exists (select 1 from public.workshop_bookings) or exists (select 1 from public.payments where booking_id is not null) then
    raise exception 'rollback refused: bookings or booking payments exist';
  end if;
end $$;
drop function public.workshop_group_stats(uuid);
drop function public.workshop_stats(uuid);
drop function public.workshop_bookings_list(uuid, uuid);
drop function public.record_booking_payment(uuid, numeric, date, text);
drop function public.cancel_workshop_booking(uuid, text);
drop function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text);
drop function app.can_see_booking(public.workshop_bookings);
drop function app.booking_money(uuid[]);
drop function app.booking_payment_status(numeric, numeric, numeric, bigint, boolean);
-- guard_payment as in migration 980 (without booking_id)
create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'payment.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.amount, new.currency, new.fx_rate_to_egp, new.fx_source, new.fx_fetched_at,
      new.kind, new.paid_on, new.note, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.amount, old.currency, old.fx_rate_to_egp, old.fx_source, old.fx_fetched_at,
      old.kind, old.paid_on, old.note, old.created_by, old.created_at) then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('app.payment_review', true), '') <> 'on' then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop index public.payments_booking_idx;
alter table public.payments drop column booking_id;
drop table public.workshop_bookings;
drop function app.guard_booking();
