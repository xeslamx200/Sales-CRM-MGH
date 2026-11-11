-- ROLLBACK of 20261104000992. Refuses while any branding row exists (it is the admin's configuration and logo). Run with psql -1.
do $$ begin
  if exists (select 1 from public.company_branding) then raise exception 'rollback refused: company branding exists (reset it on purpose first)'; end if;
end $$;
drop function public.company_logo(uuid);
drop function public.reset_company_branding(uuid);
drop function public.set_company_logo(uuid, bytea, text);
drop function public.set_company_branding(uuid, text, text, text, boolean);
drop table public.company_branding;
