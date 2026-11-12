-- ROLLBACK of 20261104001001: removes the workshop order (the Workshops page falls back to active first, then by name). Run with psql -1.
drop function public.set_offering_order(uuid, uuid[]);
alter table public.company_offerings drop column sort_order;
