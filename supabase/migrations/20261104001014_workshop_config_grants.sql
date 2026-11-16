-- 20261104001014 - A role that was given the SERVICES area (migration 1011, admin_offerings) can now also manage the prices and groups of a workshop.
--
-- 1011 opened the Services page and the writes to company_offerings, but the four database functions behind the prices and groups of a workshop still
-- asked for a company admin, so a sales manager with the services grant saw the page and was refused when saving a price or a group.
-- set_workshop_price, set_workshop_group, set_workshop_group_finished and delete_workshop_group are replaced with the same bodies; the only change is
-- app.is_company_admin(company) -> app.can_admin_area(company, 'offerings') (company admin / super admin as before, OR a role granted 'offerings').
-- Nothing else changes; a role without the grant is refused exactly as before. Grants of the functions are unchanged (create or replace keeps them).
-- Rollback: supabase/rollbacks/20261104001014_workshop_config_grants.rollback.sql

create or replace function public.set_workshop_price(p_offering_id uuid, p_country text, p_attendance text, p_currency text, p_price numeric)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_off public.company_offerings; v_country text := upper(btrim(coalesce(p_country, ''))); v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_att text := lower(btrim(coalesce(p_attendance, ''))); old public.workshop_prices; v_id uuid;
begin
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.can_admin_area(v_off.company_id, 'offerings') then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') or v_cur !~ '^[A-Z]{3}$' then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  if p_price is not null and (p_price <= 0 or p_price > 1000000000 or p_price <> round(p_price, 2)) then raise exception 'price.invalid_value' using errcode = '23514'; end if;
  select * into old from public.workshop_prices where offering_id = p_offering_id and country = v_country and attendance = v_att for update;
  if p_price is null then
    if not found then raise exception 'price.not_found' using errcode = 'P0002'; end if;
    if not old.is_active then return old.id; end if;
    update public.workshop_prices set is_active = false, updated_by = auth.uid(), updated_at = now() where id = old.id;
    insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, old_price, old_currency, old_active, new_price, new_currency, new_active, changed_by)
    values (old.id, old.company_id, old.offering_id, old.country, old.attendance, old.price, old.currency, true, old.price, old.currency, false, auth.uid());
    v_id := old.id;
  elsif not found then
    insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price, created_by, updated_by)
    values (v_off.company_id, p_offering_id, v_country, v_att, v_cur, p_price, auth.uid(), auth.uid()) returning id into v_id;
    insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, new_price, new_currency, new_active, changed_by)
    values (v_id, v_off.company_id, p_offering_id, v_country, v_att, p_price, v_cur, true, auth.uid());
  else
    v_id := old.id;
    if (old.price, old.currency, old.is_active) is distinct from (p_price, v_cur, true) then
      update public.workshop_prices set price = p_price, currency = v_cur, is_active = true, updated_by = auth.uid(), updated_at = now() where id = old.id;
      insert into public.workshop_price_history (price_id, company_id, offering_id, country, attendance, old_price, old_currency, old_active, new_price, new_currency, new_active, changed_by)
      values (old.id, old.company_id, old.offering_id, old.country, old.attendance, old.price, old.currency, old.is_active, p_price, v_cur, true, auth.uid());
    end if;
  end if;
  perform app.write_audit(v_off.company_id, 'workshop.price_set', 'company_offering', p_offering_id,
    jsonb_build_object('country', v_country, 'attendance', v_att, 'currency', v_cur, 'price', p_price));
  return v_id;
end $$;

create or replace function public.set_workshop_group(p_group_id uuid, p_offering_id uuid, p_name text, p_sessions date[], p_capacity integer,
                                                      p_attendance text, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_off public.company_offerings; v_sessions date[]; v_id uuid; v_att text := nullif(lower(btrim(coalesce(p_attendance, ''))), ''); g public.workshop_groups;
begin
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or auth.uid() is null or not app.is_active_user() or not app.can_admin_area(v_off.company_id, 'offerings') then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select array_agg(distinct d order by d) into v_sessions from unnest(p_sessions) d where d is not null;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or v_sessions is null or cardinality(v_sessions) > 60
     or (p_capacity is not null and p_capacity not between 1 and 10000) or (v_att is not null and v_att not in ('online', 'offline')) then
    raise exception 'group.invalid_value' using errcode = '23514';
  end if;
  if p_group_id is null then
    insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance, is_active, created_by, updated_by)
    values (v_off.company_id, p_offering_id, btrim(p_name), v_sessions, v_sessions[1], v_sessions[cardinality(v_sessions)], p_capacity, v_att, coalesce(p_active, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    select * into g from public.workshop_groups where id = p_group_id and company_id = v_off.company_id and offering_id = p_offering_id for update;
    if not found then raise exception 'group.not_found' using errcode = 'P0002'; end if;
    update public.workshop_groups set name = btrim(p_name), sessions = v_sessions, starts_on = v_sessions[1], ends_on = v_sessions[cardinality(v_sessions)],
      capacity = p_capacity, attendance = v_att, is_active = coalesce(p_active, true), updated_by = auth.uid(), updated_at = now() where id = p_group_id;
    v_id := p_group_id;
  end if;
  perform app.write_audit(v_off.company_id, 'workshop.group_set', 'company_offering', p_offering_id,
    jsonb_build_object('group_id', v_id, 'name', btrim(p_name), 'sessions', to_jsonb(v_sessions), 'capacity', p_capacity, 'active', coalesce(p_active, true)));
  return v_id;
end $$;

create or replace function public.set_workshop_group_finished(p_group_id uuid, p_finished boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.workshop_groups;
begin
  select * into g from public.workshop_groups where id = p_group_id for update;
  if not found or auth.uid() is null or not app.is_active_user() or not app.can_admin_area(g.company_id, 'offerings') then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  update public.workshop_groups set
    finished_at = case when p_finished then coalesce(g.finished_at, now()) else null end,
    is_active = not p_finished,   -- finished = paused (no new bookings); reopened = active again
    updated_by = auth.uid(), updated_at = now()
  where id = p_group_id;
  perform app.write_audit(g.company_id, case when p_finished then 'workshop_group.finished' else 'workshop_group.reopened' end, 'workshop_group', p_group_id,
    jsonb_build_object('name', g.name));
end $$;

create or replace function public.delete_workshop_group(p_group_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.workshop_groups; v_ids uuid[]; v_n integer;
begin
  select * into g from public.workshop_groups where id = p_group_id for update;
  if not found or auth.uid() is null or not app.is_active_user() or not app.can_admin_area(g.company_id, 'offerings') then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select array_agg(x.id) into v_ids from public.workshop_groups x
  where x.id = p_group_id
     or (g.shared_key is not null and x.shared_key = g.shared_key and x.company_id in (select app.workshop_siblings(g.company_id)));
  if exists (select 1 from public.workshop_bookings b where b.group_id = any (v_ids)) then raise exception 'group.has_bookings' using errcode = '23514'; end if;
  delete from public.workshop_groups where id = any (v_ids);
  get diagnostics v_n = row_count;
  perform app.write_audit(g.company_id, 'workshop_group.deleted', 'workshop_group', p_group_id, jsonb_build_object('name', g.name, 'copies_deleted', v_n));
  return v_n;
end $$;
