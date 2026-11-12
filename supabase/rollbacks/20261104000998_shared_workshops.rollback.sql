-- ROLLBACK of 20261104000998. Refuses while a pair of companies shares its catalogue (unpair on purpose first: delete from public.company_workshop_sharing).
-- Each company keeps its own copies of the workshops, prices and groups; only the link between the copies (shared_key) is dropped. Run with psql -1.
do $$ begin
  if exists (select 1 from public.company_workshop_sharing) then raise exception 'rollback refused: companies share their workshops (delete the pair on purpose first)'; end if;
end $$;
drop trigger company_offerings_z_share on public.company_offerings;
drop trigger workshop_prices_z_share on public.workshop_prices;
drop trigger workshop_groups_z_share on public.workshop_groups;
drop trigger company_offerings_a_shared_key on public.company_offerings;
drop trigger workshop_groups_a_shared_key on public.workshop_groups;
drop function app.sync_shared_offering(), app.sync_shared_price(), app.sync_shared_group(), app.assign_shared_key(), app.share_workshops(uuid, uuid), app.workshop_siblings(uuid);
drop index public.company_offerings_shared_key_uidx, public.workshop_groups_shared_key_uidx;
alter table public.company_offerings drop column shared_key;
alter table public.workshop_groups drop column shared_key;
drop table public.company_workshop_sharing;
