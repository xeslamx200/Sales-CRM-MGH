-- Rollback of 20261104001019_private_group_price: refuses while a group has its own price (that price would be lost).
begin;
do $$ begin
  if exists (select 1 from public.workshop_groups where group_price is not null) then
    raise exception 'rollback refused: groups with their own price exist';
  end if;
end $$;

drop function public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean, numeric, text);

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

revoke all on function public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean) from public, anon;
grant execute on function public.set_workshop_group(uuid, uuid, text, date[], integer, text, boolean) to authenticated, service_role;

create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null,
  p_booked_on date default null, p_booked_by uuid default null,
  p_kind text default 'full', p_session_date date default null, p_confirm_repeat boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0);
  v_level text; v_damt numeric := 0; v_apply boolean; v_id uuid; v_req_id uuid; v_status text; v_name text; r record; v_tz text; v_today date; v_created timestamptz := now(); v_owner uuid; v_recorded uuid;
  v_kind text := lower(btrim(coalesce(p_kind, 'full'))); v_base numeric; v_rep boolean;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  v_owner := v_uid;
  select * into g from public.workshop_groups where id = p_group_id for update;       -- serialises bookings of one group (capacity)
  if not found or not app.has_company_access(g.company_id) then raise exception 'booking.group_not_found' using errcode = 'P0002'; end if;
  select * into v_off from public.company_offerings where id = g.offering_id;
  if not g.is_active then raise exception 'booking.group_inactive' using errcode = '23514'; end if;
  if not v_off.is_active then raise exception 'booking.offering_inactive' using errcode = '23514'; end if;
  if not app.can_see_contact(p_contact_id)
     or not exists (select 1 from public.contacts k where k.id = p_contact_id and k.merged_into_id is null)
     or not exists (select 1 from public.contact_companies cc where cc.contact_id = p_contact_id and cc.company_id = g.company_id) then
    raise exception 'booking.contact_not_found' using errcode = 'P0002';
  end if;
  -- on behalf of an employee (a booking the employee made): only a super admin (any sales person of the company) or a sales manager (herself and the
  -- members of the teams she manages); the employee owns the booking (created_by) and the person who typed it is kept in recorded_by
  if p_booked_by is not null and p_booked_by <> v_uid then
    if not app.can_book_for(g.company_id, p_booked_by) then raise exception 'booking.owner_not_allowed' using errcode = '42501'; end if;
    v_owner := p_booked_by; v_recorded := v_uid;
  end if;
  -- the booking date: today when not given; never in the future, at most 90 days back (the company's own calendar day); a past day is stamped at noon of that day
  select c.timezone into v_tz from public.companies c where c.id = g.company_id;
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  if p_booked_on is not null and p_booked_on <> v_today then
    if p_booked_on > v_today or p_booked_on < v_today - 90 then raise exception 'booking.invalid_date' using errcode = '23514'; end if;
    v_created := (p_booked_on::timestamp + interval '12 hours') at time zone coalesce(v_tz, 'UTC');
  end if;
  if v_country !~ '^[A-Z]{2}$' or v_att not in ('online', 'offline') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if g.attendance is not null and g.attendance <> v_att then raise exception 'booking.attendance_mismatch' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  select * into v_price from public.workshop_prices where offering_id = g.offering_id and country = v_country and attendance = v_att and is_active;
  if not found then raise exception 'booking.price_not_configured' using errcode = '23514'; end if;
  -- the whole workshop (its price) or ONE session of the group (its own price, on the same country / attendance row)
  if v_kind not in ('full', 'session') then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
  if v_kind = 'session' then
    if p_session_date is null or not (p_session_date = any (g.sessions)) then raise exception 'booking.invalid_session' using errcode = '23514'; end if;
    if v_price.session_price is null then raise exception 'booking.session_price_not_configured' using errcode = '23514'; end if;
    v_base := v_price.session_price;
  else
    if p_session_date is not null then raise exception 'booking.invalid_value' using errcode = '23514'; end if;
    v_base := v_price.price;
  end if;

  if v_dtype not in ('none', 'fixed', 'percent') then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  if v_dtype = 'none' then
    v_dval := 0;
  else
    if v_dval <= 0 or v_dval <> round(v_dval, 2) or (v_dtype = 'percent' and v_dval > 100) or (v_dtype = 'fixed' and v_dval > v_base) then
      raise exception 'booking.invalid_discount' using errcode = '23514';
    end if;
    if length(btrim(coalesce(p_discount_reason, ''))) < 3 or length(p_discount_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
    v_damt := app.discount_amount_for(v_dtype, v_dval, v_base);
    if v_damt <= 0 then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  end if;
  v_level := app.discount_required_level(v_dtype, v_dval, v_base);
  v_apply := v_level in ('none', 'employee');          -- above 10 % the booking starts at the FULL price and the discount waits for approval

  -- the same customer may pay more than once for the same group (e.g. a second payment, a second session); the employee must say it is fine
  -- (p_confirm_repeat): the booking form shows what the customer already has in this group first
  select exists (select 1 from public.workshop_bookings b
                 where b.contact_id = p_contact_id and b.group_id = g.id and b.status in ('booked', 'pending_approval')
                   and (v_kind = 'full' or b.booking_kind = 'full' or b.session_date = p_session_date)) into v_rep;
  if v_rep and not coalesce(p_confirm_repeat, false) then raise exception 'booking.repeat_unconfirmed' using errcode = '23514'; end if;
  -- a whole-workshop booking is still refused for a second, unfinished GROUP of the same workshop
  if v_kind = 'full' and exists (select 1 from public.workshop_bookings b join public.workshop_groups bg on bg.id = b.group_id
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.group_id <> g.id and b.booking_kind = 'full'
               and b.status in ('booked', 'pending_approval') and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  -- seats: one per customer of a whole-workshop booking (a repeat payment of the same customer takes no second seat); single sessions take none
  if v_kind = 'full' and g.capacity is not null
     and (select count(distinct b.contact_id) from public.workshop_bookings b
          where b.group_id = g.id and b.status = 'booked' and b.booking_kind = 'full' and b.contact_id <> p_contact_id) >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  -- a company admin's booking is approved by definition; everybody else's waits for a company admin (it counts nowhere until then)
  v_status := case when app.is_company_admin(g.company_id) then 'booked' else 'pending_approval' end;
  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by, status, created_at, recorded_by, booking_kind, session_date)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_base,
          case when v_apply then v_dtype else 'none' end, case when v_apply then v_dval else 0 end, case when v_apply then v_damt else 0 end,
          v_base - case when v_apply then v_damt else 0 end, case when v_apply and v_dtype <> 'none' then btrim(p_discount_reason) else null end,
          nullif(btrim(p_note), ''), v_owner, v_status, v_created, v_recorded, v_kind, p_session_date)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('kind', v_kind, 'session_date', p_session_date, 'repeat_confirmed', v_rep, 'booked_for', v_owner, 'entered_by', v_uid, 'status', v_status, 'booked_on', v_created, 'offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
                       'list_price', v_base, 'discount_type', case when v_apply then v_dtype else 'none' end,
                       'discount_amount', case when v_apply then v_damt else 0 end, 'final_price', v_base - case when v_apply then v_damt else 0 end));
  if v_level <> 'none' then
    insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount,
                                                  effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
    values (g.company_id, v_id, v_uid, v_dtype, v_dval, btrim(p_discount_reason), v_base, v_damt,
            app.discount_effective_percent(v_dtype, v_dval, v_base), v_level, v_base, v_base - v_damt,
            case when v_apply then 'approved' else 'pending' end, case when v_apply then v_uid end, case when v_apply then now() end,
            case when v_apply then v_base - v_damt end)
    returning id into v_req_id;
    perform app.write_audit(g.company_id, 'discount.requested', 'workshop_booking', v_id,
      jsonb_build_object('request_id', v_req_id, 'type', v_dtype, 'value', v_dval, 'effective_percent', app.discount_effective_percent(v_dtype, v_dval, v_base),
                         'required_level', v_level, 'auto_approved', v_apply));
  end if;
  if v_status = 'pending_approval' then
    select k.full_name into v_name from public.contacts k where k.id = p_contact_id;
    for r in select m.user_id from public.company_memberships m where m.company_id = g.company_id and m.role = 'company_admin' and m.is_active loop
      perform app.notify(r.user_id, g.company_id, 'booking_approval', 'حجز بانتظار الاعتماد', coalesce(v_name, '') || ' — ' || v_off.name, 'workshop_booking', v_id);
    end loop;
  end if;
  return v_id;
end $$;

alter table public.workshop_groups drop constraint workshop_groups_own_price_ck, drop column group_price, drop column group_currency;
commit;
