-- ROLLBACK of 20261104001009: groups lose the finished state (a finished group stays paused); the delete / finish functions go. Run with psql -1.
drop function public.set_workshop_group_finished(uuid, boolean);
drop function public.delete_workshop_group(uuid);
drop trigger workshop_groups_z_share on public.workshop_groups;
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
alter table public.workshop_groups drop column finished_at;
