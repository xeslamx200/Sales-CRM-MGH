-- ROLLBACK of 20261104001011: only company admins (and super admins) can change services and pipelines again; grants stored in role permissions are
-- ignored (the keys can stay). Run with psql -1.
drop policy pipelines_write on public.pipelines;
create policy pipelines_write on public.pipelines for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));
drop policy stages_write on public.pipeline_stages;
create policy stages_write on public.pipeline_stages for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));
drop policy offerings_insert on public.company_offerings;
create policy offerings_insert on public.company_offerings for insert to authenticated with check (app.is_company_admin(company_id));
drop policy offerings_update on public.company_offerings;
create policy offerings_update on public.company_offerings for update to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));
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

create or replace function public.save_company_role(p_id uuid, p_company_id uuid, p_name text, p_base_role public.app_role, p_hidden_nav text[], p_permissions jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_name text := btrim(coalesce(p_name, ''));
  v_nav text[] := coalesce((select array_agg(distinct x order by x) from unnest(coalesce(p_hidden_nav, '{}')) x), '{}');
  v_allowed_nav text[] := array['/inbox', '/leads', '/contacts', '/bookings', '/workshops', '/performance', '/tasks', '/reports'];
  v_allowed_perm text[] := array['send_messages', 'create_leads', 'import_leads', 'create_bookings', 'record_payments', 'export_data'];
  v_perm jsonb := '{}'::jsonb; k text; v jsonb;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 60 or p_base_role is null or p_base_role = 'company_admin' then raise exception 'role.invalid' using errcode = '23514'; end if;
  if exists (select 1 from unnest(v_nav) x where x <> all (v_allowed_nav)) then raise exception 'role.invalid' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_permissions, '{}'::jsonb)) <> 'object' then raise exception 'role.invalid' using errcode = '23514'; end if;
  for k, v in select * from jsonb_each(coalesce(p_permissions, '{}'::jsonb)) loop
    if k <> all (v_allowed_perm) or jsonb_typeof(v) <> 'boolean' then raise exception 'role.invalid' using errcode = '23514'; end if;
    if v = 'false'::jsonb then v_perm := v_perm || jsonb_build_object(k, false); end if;   -- only the denials are stored
  end loop;
  if p_id is null then
    insert into public.company_roles (company_id, name, base_role, hidden_nav, permissions, created_by)
    values (p_company_id, v_name, p_base_role, v_nav, v_perm, auth.uid()) returning id into v_id;
  else
    update public.company_roles set name = v_name, base_role = p_base_role, hidden_nav = v_nav, permissions = v_perm, updated_at = now()
    where id = p_id and company_id = p_company_id returning id into v_id;
    if v_id is null then raise exception 'role.not_found' using errcode = 'P0002'; end if;
    -- people with this role follow its base role
    update public.company_memberships set role = p_base_role where custom_role_id = v_id and role <> p_base_role;
  end if;
  perform app.write_audit(p_company_id, 'role.saved', 'company_role', v_id,
    jsonb_build_object('name', v_name, 'base_role', p_base_role, 'hidden_nav', v_nav, 'denied', v_perm));
  return v_id;
exception when unique_violation then
  raise exception 'role.name_taken' using errcode = '23505';
end $$;

create or replace function public.save_builtin_role(p_company_id uuid, p_role public.app_role, p_hidden_nav text[], p_permissions jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_nav text[] := coalesce((select array_agg(distinct x order by x) from unnest(coalesce(p_hidden_nav, '{}')) x), '{}');
  v_allowed_nav text[] := array['/inbox', '/leads', '/contacts', '/bookings', '/workshops', '/performance', '/tasks', '/reports'];
  v_allowed_perm text[] := array['send_messages', 'create_leads', 'import_leads', 'create_bookings', 'record_payments', 'export_data'];
  v_perm jsonb := '{}'::jsonb; k text; v jsonb;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_role is null or p_role = 'company_admin' then raise exception 'role.invalid' using errcode = '23514'; end if;
  if exists (select 1 from unnest(v_nav) x where x <> all (v_allowed_nav)) then raise exception 'role.invalid' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_permissions, '{}'::jsonb)) <> 'object' then raise exception 'role.invalid' using errcode = '23514'; end if;
  for k, v in select * from jsonb_each(coalesce(p_permissions, '{}'::jsonb)) loop
    if k <> all (v_allowed_perm) or jsonb_typeof(v) <> 'boolean' then raise exception 'role.invalid' using errcode = '23514'; end if;
    if v = 'false'::jsonb then v_perm := v_perm || jsonb_build_object(k, false); end if;   -- only the denials are stored
  end loop;
  if cardinality(v_nav) = 0 and v_perm = '{}'::jsonb then
    delete from public.company_builtin_roles where company_id = p_company_id and role = p_role;   -- back to "nothing restricted"
  else
    insert into public.company_builtin_roles (company_id, role, hidden_nav, permissions, updated_by)
    values (p_company_id, p_role, v_nav, v_perm, auth.uid())
    on conflict (company_id, role) do update set hidden_nav = excluded.hidden_nav, permissions = excluded.permissions, updated_by = auth.uid(), updated_at = now();
  end if;
  perform app.write_audit(p_company_id, 'role.builtin_saved', 'company_builtin_role', null,
    jsonb_build_object('role', p_role, 'hidden_nav', v_nav, 'denied', v_perm));
end $$;
drop function app.can_admin_area(uuid, text);
drop function app.has_admin_grant(uuid, text);
