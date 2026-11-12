-- 20261104001001 - a company admin chooses the ORDER in which the workshops are listed (Workshops page).
--
-- Additive only: one nullable column and one function. company_offerings.sort_order is per company (it is NOT part of the shared catalogue:
-- the sharing triggers watch name, kind, keywords and is_active only, so ordering a workshop in one company never moves it in the other).
-- NULL = not placed yet: those workshops are listed after the placed ones, by name. The function takes the workshop ids in the wanted order,
-- checks that every one belongs to the company (and that the caller is its admin), and renumbers them 1..n; workshops not in the list get NULL.
-- Rollback: supabase/rollbacks/20261104001001_workshop_order.rollback.sql

alter table public.company_offerings add column sort_order integer check (sort_order is null or sort_order between 1 and 100000);

create or replace function public.set_offering_order(p_company_id uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) > 2000 or exists (select 1 from unnest(p_ids) i group by i having count(*) > 1) then
    raise exception 'offering.invalid_order' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(p_ids) i where not exists (select 1 from public.company_offerings o where o.id = i and o.company_id = p_company_id)) then
    raise exception 'offering.invalid_order' using errcode = '23514';
  end if;
  update public.company_offerings o set sort_order = x.n
  from (select i, n::integer from unnest(p_ids) with ordinality as t(i, n)) x
  where o.id = x.i and o.company_id = p_company_id and o.sort_order is distinct from x.n;
  update public.company_offerings o set sort_order = null
  where o.company_id = p_company_id and o.sort_order is not null and not (o.id = any (p_ids));
  select count(*) into v_n from public.company_offerings where company_id = p_company_id and sort_order is not null;
  return v_n;
end $$;
revoke all on function public.set_offering_order(uuid, uuid[]) from public, anon;
grant execute on function public.set_offering_order(uuid, uuid[]) to authenticated, service_role;
