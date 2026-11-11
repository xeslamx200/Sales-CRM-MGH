-- ROLLBACK of 20261104000996. Refuses while any company has hidden dashboard sections (it is the admin's configuration). Run with psql -1.
do $$ begin
  if exists (select 1 from public.company_ui_settings where cardinality(hidden_widgets) > 0) then raise exception 'rollback refused: companies have hidden dashboard sections (reset them on purpose first)'; end if;
end $$;
drop function public.set_company_ui_settings_v2(uuid, text[], text, text[]);
alter table public.company_ui_settings drop column hidden_widgets;
