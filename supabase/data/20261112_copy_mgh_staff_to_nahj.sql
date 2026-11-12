-- DATA STEP (Staging): the staff of MGH also work in NAHJ, with the same roles; the people who may use the MGH UAE number (Marketing Growth
-- Hub) may use the NAHJ number too. Adds only what is missing (nobody is removed or changed). Refuses unless both companies and both numbers
-- exist. One transaction; ends with ROLLBACK by default, change the last line to COMMIT to apply.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
begin
  if (select count(*) from public.companies where slug in ('mgh', 'nahj')) <> 2 then raise exception 'refusing: companies mgh and nahj are not both present'; end if;
  if (select count(*) from public.whatsapp_accounts where phone_number_id in ('804174526102877', '1089236484272496')) <> 2 then raise exception 'refusing: the Marketing Growth Hub and NAHJ numbers are not both present'; end if;
end $$;

-- 1. members of mgh (active, active account) who are not yet members of nahj -> same role
with added as (
  insert into public.company_memberships (company_id, user_id, role)
  select (select id from public.companies where slug = 'nahj'), m.user_id, m.role
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id and p.is_active
  where m.company_id = (select id from public.companies where slug = 'mgh') and m.is_active
    and not exists (select 1 from public.company_memberships x where x.company_id = (select id from public.companies where slug = 'nahj') and x.user_id = m.user_id)
  returning user_id, role
)
select 'membership added' as what, p.full_name, a.role::text as role from added a join public.profiles p on p.id = a.user_id order by 2;

-- 2. who may use the Marketing Growth Hub number may use the NAHJ number (same reply right); existing grants stay as they are
with g as (
  insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply)
  select (select id from public.whatsapp_accounts where phone_number_id = '1089236484272496'), s.user_id, s.can_reply
  from public.whatsapp_account_access s
  where s.whatsapp_account_id = (select id from public.whatsapp_accounts where phone_number_id = '804174526102877')
    and exists (select 1 from public.company_memberships x where x.company_id = (select id from public.companies where slug = 'nahj') and x.user_id = s.user_id and x.is_active)
  on conflict (whatsapp_account_id, user_id) do nothing
  returning user_id
)
select 'number access added' as what, count(*) as people from g;

-- the result: both companies with the same people and roles
select c.slug, p.full_name, m.role::text
from public.company_memberships m join public.companies c on c.id = m.company_id join public.profiles p on p.id = m.user_id
where c.slug in ('mgh', 'nahj') and m.is_active order by p.full_name, c.slug;

rollback;   -- change to COMMIT to apply
