-- ROLLBACK of 20261104000991. Refuses while any settings row exists (it is the admin's configuration). Run with psql -1.
do $$ begin
  if exists (select 1 from public.company_ui_settings) then raise exception 'rollback refused: company UI settings exist (delete them on purpose first)'; end if;
end $$;
drop function public.set_company_ui_settings(uuid, text[], text);
drop table public.company_ui_settings;
