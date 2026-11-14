-- ROLLBACK of 20261104001006: removes custom roles. People keep the built-in role they have (membership.role was kept equal to the base role). Run with psql -1.
drop trigger memberships_a_custom_role on public.company_memberships;
drop function public.save_company_role(uuid, uuid, text, public.app_role, text[], jsonb);
drop function public.delete_company_role(uuid);
drop function app.sync_membership_custom_role();
alter table public.company_memberships drop column custom_role_id;
drop table public.company_roles;
