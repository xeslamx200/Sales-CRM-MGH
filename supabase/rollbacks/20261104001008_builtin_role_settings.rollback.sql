-- ROLLBACK of 20261104001008: removes the per-company settings of the built-in roles (nothing is restricted again). Run with psql -1.
drop function public.save_builtin_role(uuid, public.app_role, text[], jsonb);
drop table public.company_builtin_roles;
