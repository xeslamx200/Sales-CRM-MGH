-- DATA STEP (Staging): pair Mindset Growth Hub (mgh, the source of truth) with NAHJ (nahj) so they keep ONE workshop catalogue
-- (workshops, prices, groups) from now on, in both directions (migration 998). Run once, after 998. Idempotent: running it again changes nothing.
-- Refuses (changes nothing) unless both companies exist. Ends with ROLLBACK by default; change the last line to COMMIT to apply.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table share_before on commit drop as select
  (select count(*) from public.company_offerings o join public.companies c on c.id = o.company_id where c.slug = 'mgh') as mgh_offerings,
  (select count(*) from public.company_offerings o join public.companies c on c.id = o.company_id where c.slug = 'nahj') as nahj_offerings,
  (select count(*) from public.workshop_bookings) as bookings, (select count(*) from public.payments) as payments,
  (select count(*) from public.leads) as leads;

do $$
begin
  if (select count(*) from public.companies where slug in ('mgh', 'nahj')) <> 2 then raise exception 'refusing: companies mgh and nahj are not both present'; end if;
  perform app.share_workshops((select id from public.companies where slug = 'mgh'), (select id from public.companies where slug = 'nahj'));
end $$;

-- expected: both companies with the same number of workshops (the 29 of mgh plus any nahj-only one), prices and groups; bookings / payments / leads unchanged
select 'workshops' as what, (select count(*) from public.company_offerings o join public.companies c on c.id = o.company_id where c.slug = 'mgh') as mgh,
  (select count(*) from public.company_offerings o join public.companies c on c.id = o.company_id where c.slug = 'nahj') as nahj,
  (select mgh_offerings from share_before) as mgh_before, (select nahj_offerings from share_before) as nahj_before
union all select 'prices', (select count(*) from public.workshop_prices p join public.companies c on c.id = p.company_id where c.slug = 'mgh'),
  (select count(*) from public.workshop_prices p join public.companies c on c.id = p.company_id where c.slug = 'nahj'), null, null
union all select 'groups', (select count(*) from public.workshop_groups g join public.companies c on c.id = g.company_id where c.slug = 'mgh'),
  (select count(*) from public.workshop_groups g join public.companies c on c.id = g.company_id where c.slug = 'nahj'), null, null;

select (select count(*) from public.workshop_bookings) - (select bookings from share_before) as bookings_changed,
  (select count(*) from public.payments) - (select payments from share_before) as payments_changed,
  (select count(*) from public.leads) - (select leads from share_before) as leads_changed;   -- must be 0 | 0 | 0

rollback;   -- change to COMMIT to apply
