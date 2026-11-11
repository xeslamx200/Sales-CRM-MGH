-- ROLLBACK of 20261104000984. Refuses while any price, price history or group exists (that would delete the owner's configuration and its audit trail).
-- To discard on purpose, the owner must first decide what to do with those rows. Run with psql -1.
do $$ begin
  if exists (select 1 from public.workshop_prices) or exists (select 1 from public.workshop_price_history) or exists (select 1 from public.workshop_groups) then
    raise exception 'rollback refused: workshop prices / history / groups exist';
  end if;
end $$;
drop function public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean);
drop function public.workshop_price_gaps(uuid, text[]);
drop function public.workshop_price_for(uuid, text, text);
drop function public.set_workshop_price(uuid, text, text, text, numeric);
drop table public.workshop_groups;
drop table public.workshop_price_history;
drop table public.workshop_prices;
drop function app.block_price_history_mutation();
