-- 20261104001009 - A workshop group (a course run) can be marked FINISHED, or deleted when nobody booked it.
--
--  * workshop_groups.finished_at: set when an admin marks the group finished. Finishing also pauses it (is_active = false), so it takes no new bookings
--    (the booking function already refuses an inactive group); its bookings, payments and history stay. "Reopen" clears finished_at and reactivates it.
--    The application also shows a group whose last session date has passed as finished by itself (no change stored).
--  * set_workshop_group_finished(group, finished): company admin of the group's company.
--  * delete_workshop_group(group): company admin; refused ('group.has_bookings') while ANY booking points at the group, of any status. Paired companies
--    share one catalogue (998): the copy of the group in the paired company is deleted with it (or the whole delete is refused if that copy has bookings),
--    otherwise the next sync would bring the group back. Audit rows stay.
--  * the sharing trigger now also copies finished_at to the paired company's copy.
-- Rollback: supabase/rollbacks/20261104001009_group_finished_delete.rollback.sql

alter table public.workshop_groups add column finished_at timestamptz;

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
          capacity = new.capacity, attendance = new.attendance, is_active = new.is_active, finished_at = new.finished_at, updated_by = new.updated_by, updated_at = now()
        where company_id = s and shared_key = new.shared_key
          and (name, sessions, capacity, attendance, is_active, finished_at) is distinct from (new.name, new.sessions, new.capacity, new.attendance, new.is_active, new.finished_at);
      else
        select id into v_other from public.workshop_groups where offering_id = v_off and lower(btrim(name)) = lower(btrim(new.name)) limit 1;
        if v_other is not null then
          update public.workshop_groups set shared_key = new.shared_key, name = new.name, sessions = new.sessions, starts_on = new.starts_on, ends_on = new.ends_on,
            capacity = new.capacity, attendance = new.attendance, is_active = new.is_active, finished_at = new.finished_at, updated_by = new.updated_by, updated_at = now() where id = v_other;
        else
          insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance, is_active, finished_at, created_by, updated_by, shared_key)
          values (s, v_off, new.name, new.sessions, new.starts_on, new.ends_on, new.capacity, new.attendance, new.is_active, new.finished_at, new.created_by, new.updated_by, new.shared_key);
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
drop trigger workshop_groups_z_share on public.workshop_groups;
create trigger workshop_groups_z_share after insert or update of name, sessions, capacity, attendance, is_active, finished_at on public.workshop_groups
  for each row execute function app.sync_shared_group();

create or replace function public.set_workshop_group_finished(p_group_id uuid, p_finished boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.workshop_groups;
begin
  select * into g from public.workshop_groups where id = p_group_id for update;
  if not found or auth.uid() is null or not app.is_active_user() or not app.is_company_admin(g.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
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
  if not found or auth.uid() is null or not app.is_active_user() or not app.is_company_admin(g.company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select array_agg(x.id) into v_ids from public.workshop_groups x
  where x.id = p_group_id
     or (g.shared_key is not null and x.shared_key = g.shared_key and x.company_id in (select app.workshop_siblings(g.company_id)));
  if exists (select 1 from public.workshop_bookings b where b.group_id = any (v_ids)) then raise exception 'group.has_bookings' using errcode = '23514'; end if;
  delete from public.workshop_groups where id = any (v_ids);
  get diagnostics v_n = row_count;
  perform app.write_audit(g.company_id, 'workshop_group.deleted', 'workshop_group', p_group_id, jsonb_build_object('name', g.name, 'copies_deleted', v_n));
  return v_n;
end $$;

revoke all on function public.set_workshop_group_finished(uuid, boolean), public.delete_workshop_group(uuid) from public, anon;
grant execute on function public.set_workshop_group_finished(uuid, boolean), public.delete_workshop_group(uuid) to authenticated, service_role;
