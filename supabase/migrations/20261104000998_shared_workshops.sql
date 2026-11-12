-- 20261104000998 - Shared workshops: two companies of the same owner can keep ONE workshop catalogue (workshops, their prices and their groups).
--
-- Purely additive. Nothing changes until a super admin pairs two companies with app.share_workshops (a data step, run once per pair).
-- Every company keeps its OWN rows (its own ids): bookings, payments, leads, customers, reports and commission never cross companies, and
-- row-level security is untouched (a member of one company still cannot read the other company's rows). What is shared is only the CATALOGUE:
-- once two companies are paired, anything created or changed in one of them (company_offerings: name, kind, keywords, active;
-- workshop_prices: price, currency, active; workshop_groups: name, sessions, capacity, attendance, active) is copied to the other by
-- triggers, in both directions, whichever way the change was made (screen, function or SQL).
--  * shared_key (company_offerings, workshop_groups): the same value in the two copies; one copy per company (unique index).
--  * A price is matched by (workshop, country, attendance); its history row is written for the copy too.
--  * Pairing (app.share_workshops(a, b)) is idempotent and adopts a workshop that already exists in both companies under the same name;
--    where both sides have a value for the same thing, company `a` (the source of truth) wins.
--  * Capacity of a shared group is copied as a number; each company counts only its own bookings against it.
--  * A rename that would collide with another workshop of the other company is refused with 'workshop.sharing_name_conflict'.
--  * Recursion is prevented by the session setting app.sharing_sync (set only inside the sync functions).
-- Rollback: supabase/rollbacks/20261104000998_shared_workshops.rollback.sql (refuses while a pair exists).

create table public.company_workshop_sharing (
  company_a uuid not null references public.companies (id) on delete cascade,
  company_b uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (company_a, company_b),
  check (company_a < company_b)
);
alter table public.company_workshop_sharing enable row level security;
revoke all on public.company_workshop_sharing from public, anon, authenticated;
grant select on public.company_workshop_sharing to authenticated;
grant all on public.company_workshop_sharing to service_role;
create policy company_workshop_sharing_select on public.company_workshop_sharing for select to authenticated using (app.is_super_admin());

alter table public.company_offerings add column shared_key uuid;
alter table public.workshop_groups add column shared_key uuid;
create unique index company_offerings_shared_key_uidx on public.company_offerings (company_id, shared_key) where shared_key is not null;
create unique index workshop_groups_shared_key_uidx on public.workshop_groups (company_id, shared_key) where shared_key is not null;

create or replace function app.workshop_siblings(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select company_b from public.company_workshop_sharing where company_a = p_company
  union select company_a from public.company_workshop_sharing where company_b = p_company
$$;

create or replace function app.assign_shared_key() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.shared_key := coalesce(new.shared_key, gen_random_uuid());
  return new;
end $$;
create trigger company_offerings_a_shared_key before insert on public.company_offerings for each row execute function app.assign_shared_key();
create trigger workshop_groups_a_shared_key before insert on public.workshop_groups for each row execute function app.assign_shared_key();

-- ----------------------------------------------------------------------------------------------------------- workshops
create or replace function app.sync_shared_offering() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s uuid; v_other uuid;
begin
  if coalesce(current_setting('app.sharing_sync', true), '') = 'on' then return null; end if;
  if not exists (select 1 from app.workshop_siblings(new.company_id)) then return null; end if;
  perform set_config('app.sharing_sync', 'on', true);
  begin
    for s in select app.workshop_siblings(new.company_id) loop
      if exists (select 1 from public.company_offerings where company_id = s and shared_key = new.shared_key) then
        update public.company_offerings set name = new.name, kind = new.kind, keywords = new.keywords, is_active = new.is_active
        where company_id = s and shared_key = new.shared_key and (name, kind, keywords, is_active) is distinct from (new.name, new.kind, new.keywords, new.is_active);
      else
        select id into v_other from public.company_offerings where company_id = s and lower(btrim(name)) = lower(btrim(new.name)) limit 1;
        if v_other is not null then   -- the same workshop already exists there under the same name: link it
          update public.company_offerings set shared_key = new.shared_key, name = new.name, kind = new.kind, keywords = new.keywords, is_active = new.is_active where id = v_other;
        else
          insert into public.company_offerings (company_id, name, kind, keywords, is_active, shared_key) values (s, new.name, new.kind, new.keywords, new.is_active, new.shared_key);
        end if;
      end if;
    end loop;
  exception when unique_violation then
    perform set_config('app.sharing_sync', 'off', true);
    raise exception 'workshop.sharing_name_conflict' using errcode = '23505';
  end;
  perform set_config('app.sharing_sync', 'off', true);
  return null;
end $$;
create trigger company_offerings_z_share after insert or update of name, kind, keywords, is_active on public.company_offerings
  for each row execute function app.sync_shared_offering();

-- ----------------------------------------------------------------------------------------------------------- prices
create or replace function app.sync_shared_price() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s uuid; v_key uuid; v_off uuid; o public.workshop_prices; v_id uuid;
begin
  if coalesce(current_setting('app.sharing_sync', true), '') = 'on' then return null; end if;
  if not exists (select 1 from app.workshop_siblings(new.company_id)) then return null; end if;
  select shared_key into v_key from public.company_offerings where id = new.offering_id;
  perform set_config('app.sharing_sync', 'on', true);
  for s in select app.workshop_siblings(new.company_id) loop
    select id into v_off from public.company_offerings where company_id = s and shared_key = v_key;
    if v_off is null then continue; end if;
    select * into o from public.workshop_prices where offering_id = v_off and country = new.country and attendance = new.attendance for update;
    if not found then
      insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price, is_active, created_by, updated_by)
      values (s, v_off, new.country, new.attendance, new.currency, new.price, new.is_active, new.created_by, new.updated_by) returning id into v_id;
      insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, new_price, new_currency, new_active, changed_by)
      values (v_id, s, v_off, new.country, new.attendance, new.price, new.currency, new.is_active, new.updated_by);
    elsif (o.price, o.currency, o.is_active) is distinct from (new.price, new.currency, new.is_active) then
      update public.workshop_prices set price = new.price, currency = new.currency, is_active = new.is_active, updated_by = new.updated_by, updated_at = now() where id = o.id;
      insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, old_price, old_currency, old_active, new_price, new_currency, new_active, changed_by)
      values (o.id, s, v_off, new.country, new.attendance, o.price, o.currency, o.is_active, new.price, new.currency, new.is_active, new.updated_by);
    end if;
  end loop;
  perform set_config('app.sharing_sync', 'off', true);
  return null;
end $$;
create trigger workshop_prices_z_share after insert or update of price, currency, is_active on public.workshop_prices
  for each row execute function app.sync_shared_price();

-- ----------------------------------------------------------------------------------------------------------- groups
create or replace function app.sync_shared_group() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s uuid; v_key uuid; v_off uuid; v_other uuid;
begin
  if coalesce(current_setting('app.sharing_sync', true), '') = 'on' then return null; end if;
  if not exists (select 1 from app.workshop_siblings(new.company_id)) then return null; end if;
  select shared_key into v_key from public.company_offerings where id = new.offering_id;
  perform set_config('app.sharing_sync', 'on', true);
  begin
    for s in select app.workshop_siblings(new.company_id) loop
      select id into v_off from public.company_offerings where company_id = s and shared_key = v_key;
      if v_off is null then continue; end if;
      if exists (select 1 from public.workshop_groups where company_id = s and shared_key = new.shared_key) then
        update public.workshop_groups set offering_id = v_off, name = new.name, sessions = new.sessions, starts_on = new.starts_on, ends_on = new.ends_on,
          capacity = new.capacity, attendance = new.attendance, is_active = new.is_active, updated_by = new.updated_by, updated_at = now()
        where company_id = s and shared_key = new.shared_key
          and (name, sessions, capacity, attendance, is_active) is distinct from (new.name, new.sessions, new.capacity, new.attendance, new.is_active);
      else
        select id into v_other from public.workshop_groups where offering_id = v_off and lower(btrim(name)) = lower(btrim(new.name)) limit 1;
        if v_other is not null then
          update public.workshop_groups set shared_key = new.shared_key, name = new.name, sessions = new.sessions, starts_on = new.starts_on, ends_on = new.ends_on,
            capacity = new.capacity, attendance = new.attendance, is_active = new.is_active, updated_by = new.updated_by, updated_at = now() where id = v_other;
        else
          insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance, is_active, created_by, updated_by, shared_key)
          values (s, v_off, new.name, new.sessions, new.starts_on, new.ends_on, new.capacity, new.attendance, new.is_active, new.created_by, new.updated_by, new.shared_key);
        end if;
      end if;
    end loop;
  exception when unique_violation then
    perform set_config('app.sharing_sync', 'off', true);
    raise exception 'workshop.sharing_name_conflict' using errcode = '23505';
  end;
  perform set_config('app.sharing_sync', 'off', true);
  return null;
end $$;
create trigger workshop_groups_z_share after insert or update of name, sessions, capacity, attendance, is_active on public.workshop_groups
  for each row execute function app.sync_shared_group();

-- ----------------------------------------------------------------------------------------------------------- pairing
-- Pairs two companies and brings their catalogues together (service role / postgres only). Idempotent. Company p_source wins where both
-- sides have a value for the same thing. Returns how many workshops, prices and groups each company has afterwards.
create or replace function app.share_workshops(p_source uuid, p_other uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := least(p_source, p_other); b uuid := greatest(p_source, p_other);
begin
  if p_source = p_other or not exists (select 1 from public.companies where id = p_source) or not exists (select 1 from public.companies where id = p_other) then
    raise exception 'workshop.sharing_invalid_pair' using errcode = '22023';
  end if;
  insert into public.company_workshop_sharing (company_a, company_b) values (a, b) on conflict do nothing;
  update public.company_offerings set shared_key = gen_random_uuid() where company_id in (p_source, p_other) and shared_key is null;
  update public.workshop_groups set shared_key = gen_random_uuid() where company_id in (p_source, p_other) and shared_key is null;
  -- the SOURCE first, then the other company: the source's rows are copied over the other's (so its values win where both have one),
  -- then the other company's own rows are copied to the source (what only the other company had)
  update public.company_offerings set name = name where company_id = p_source;
  update public.company_offerings set name = name where company_id = p_other;
  update public.workshop_prices set price = price where company_id = p_source;
  update public.workshop_prices set price = price where company_id = p_other;
  update public.workshop_groups set name = name where company_id = p_source;
  update public.workshop_groups set name = name where company_id = p_other;
  return jsonb_build_object(
    'offerings', jsonb_build_object('source', (select count(*) from public.company_offerings where company_id = p_source), 'other', (select count(*) from public.company_offerings where company_id = p_other)),
    'prices', jsonb_build_object('source', (select count(*) from public.workshop_prices where company_id = p_source), 'other', (select count(*) from public.workshop_prices where company_id = p_other)),
    'groups', jsonb_build_object('source', (select count(*) from public.workshop_groups where company_id = p_source), 'other', (select count(*) from public.workshop_groups where company_id = p_other)));
end $$;

revoke all on function app.share_workshops(uuid, uuid), app.workshop_siblings(uuid), app.sync_shared_offering(), app.sync_shared_price(), app.sync_shared_group(), app.assign_shared_key() from public, anon, authenticated;
