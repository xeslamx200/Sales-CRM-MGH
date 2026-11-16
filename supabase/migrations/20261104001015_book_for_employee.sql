-- 20261104001015 - "This booking belongs to employee X": a super admin, or a sales manager for herself and her team, can book on behalf of an employee.
--
--  * workshop_bookings.recorded_by (nullable): who typed the booking when it belongs to somebody else (created_by is the employee it belongs to). NULL = the
--    person who made it is the owner, exactly as before.
--  * app.can_book_for(company, employee): the caller is a super admin (any active sales_agent / sales_manager of the company) or a sales manager of the
--    company (herself, or an active member of an active team she manages, who is an active sales_agent / sales_manager of the company).
--  * public.booking_owner_options(company): the people the caller may choose from (empty for everybody else: the form then shows no choice).
--  * create_workshop_booking gains p_booked_by (uuid, last argument; the 9-argument function is dropped). Refused with booking.owner_not_allowed unless
--    app.can_book_for. Everything else is unchanged (approval status follows the person who typed it, capacity, duplicates, date, discount rules).
--  * record_booking_payment: a payment on a booking that belongs to an employee (recorded_by set) is credited to that employee (payments.created_by), so
--    it counts in THEIR collection and commission; the audit log keeps who entered it. Bookings without recorded_by behave exactly as before.
-- Rollback: supabase/rollbacks/20261104001015_book_for_employee.rollback.sql (refuses while a booking has recorded_by set).

alter table public.workshop_bookings add column recorded_by uuid references public.profiles (id) on delete set null;

create or replace function app.can_book_for(p_company_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.is_active_user()
    and exists (select 1 from public.company_memberships m join public.profiles p on p.id = m.user_id and p.is_active
                where m.company_id = p_company_id and m.user_id = p_user_id and m.is_active and m.role in ('sales_agent', 'sales_manager'))
    and (app.is_super_admin()
         or (app.company_role(p_company_id) = 'sales_manager'
             and (p_user_id = auth.uid()
                  or exists (select 1 from public.teams t join public.team_memberships tm on tm.team_id = t.id
                             where t.company_id = p_company_id and t.is_active and t.manager_id = auth.uid() and tm.user_id = p_user_id))))
$$;

create or replace function public.booking_owner_options(p_company_id uuid) returns table (user_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, p.full_name
  from public.company_memberships m join public.profiles p on p.id = m.user_id
  where m.company_id = p_company_id and m.is_active and p.is_active and app.can_book_for(p_company_id, m.user_id)
  order by p.full_name
$$;
revoke all on function app.can_book_for(uuid, uuid), public.booking_owner_options(uuid) from public, anon;
grant execute on function app.can_book_for(uuid, uuid), public.booking_owner_options(uuid) to authenticated, service_role;

drop function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date);

create or replace function public.create_workshop_booking(
  p_contact_id uuid, p_group_id uuid, p_country text, p_attendance text,
  p_discount_type text default 'none', p_discount_value numeric default 0, p_discount_reason text default null, p_note text default null,
  p_booked_on date default null, p_booked_by uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); g public.workshop_groups; v_off public.company_offerings; v_price public.workshop_prices;
  v_country text := upper(btrim(coalesce(p_country, ''))); v_att text := lower(btrim(coalesce(p_attendance, '')));
  v_dtype text := lower(btrim(coalesce(p_discount_type, 'none'))); v_dval numeric := coalesce(p_discount_value, 0);
  v_level text; v_damt numeric := 0; v_apply boolean; v_id uuid; v_req_id uuid; v_status text; v_name text; r record; v_tz text; v_today date; v_created timestamptz := now(); v_owner uuid; v_recorded uuid;
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

  if v_dtype not in ('none', 'fixed', 'percent') then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  if v_dtype = 'none' then
    v_dval := 0;
  else
    if v_dval <= 0 or v_dval <> round(v_dval, 2) or (v_dtype = 'percent' and v_dval > 100) or (v_dtype = 'fixed' and v_dval > v_price.price) then
      raise exception 'booking.invalid_discount' using errcode = '23514';
    end if;
    if length(btrim(coalesce(p_discount_reason, ''))) < 3 or length(p_discount_reason) > 300 then raise exception 'booking.discount_reason_required' using errcode = '23514'; end if;
    v_damt := app.discount_amount_for(v_dtype, v_dval, v_price.price);
    if v_damt <= 0 then raise exception 'booking.invalid_discount' using errcode = '23514'; end if;
  end if;
  v_level := app.discount_required_level(v_dtype, v_dval, v_price.price);
  v_apply := v_level in ('none', 'employee');          -- above 10 % the booking starts at the FULL price and the discount waits for approval

  if exists (select 1 from public.workshop_bookings b join public.workshop_groups bg on bg.id = b.group_id
             where b.contact_id = p_contact_id and b.offering_id = g.offering_id and b.status in ('booked', 'pending_approval') and bg.ends_on >= current_date) then
    raise exception 'booking.duplicate' using errcode = '23505';
  end if;
  if g.capacity is not null and (select count(*) from public.workshop_bookings b where b.group_id = g.id and b.status = 'booked') >= g.capacity then
    raise exception 'booking.group_full' using errcode = '23514';
  end if;

  -- a company admin's booking is approved by definition; everybody else's waits for a company admin (it counts nowhere until then)
  v_status := case when app.is_company_admin(g.company_id) then 'booked' else 'pending_approval' end;
  insert into public.workshop_bookings (company_id, contact_id, offering_id, group_id, country, attendance, currency, list_price,
                                        discount_type, discount_value, discount_amount, final_price, discount_reason, note, created_by, status, created_at, recorded_by)
  values (g.company_id, p_contact_id, g.offering_id, g.id, v_country, v_att, v_price.currency, v_price.price,
          case when v_apply then v_dtype else 'none' end, case when v_apply then v_dval else 0 end, case when v_apply then v_damt else 0 end,
          v_price.price - case when v_apply then v_damt else 0 end, case when v_apply and v_dtype <> 'none' then btrim(p_discount_reason) else null end,
          nullif(btrim(p_note), ''), v_owner, v_status, v_created, v_recorded)
  returning id into v_id;
  perform app.write_audit(g.company_id, 'booking.created', 'workshop_booking', v_id,
    jsonb_build_object('booked_for', v_owner, 'entered_by', v_uid, 'status', v_status, 'booked_on', v_created, 'offering_id', g.offering_id, 'group_id', g.id, 'country', v_country, 'attendance', v_att, 'currency', v_price.currency,
                       'list_price', v_price.price, 'discount_type', case when v_apply then v_dtype else 'none' end,
                       'discount_amount', case when v_apply then v_damt else 0 end, 'final_price', v_price.price - case when v_apply then v_damt else 0 end));
  if v_level <> 'none' then
    insert into public.booking_discount_requests (company_id, booking_id, requested_by, discount_type, discount_value, reason, list_price, requested_amount,
                                                  effective_percent, required_level, previous_final, calculated_final, status, decided_by, decided_at, applied_final)
    values (g.company_id, v_id, v_uid, v_dtype, v_dval, btrim(p_discount_reason), v_price.price, v_damt,
            app.discount_effective_percent(v_dtype, v_dval, v_price.price), v_level, v_price.price, v_price.price - v_damt,
            case when v_apply then 'approved' else 'pending' end, case when v_apply then v_uid end, case when v_apply then now() end,
            case when v_apply then v_price.price - v_damt end)
    returning id into v_req_id;
    perform app.write_audit(g.company_id, 'discount.requested', 'workshop_booking', v_id,
      jsonb_build_object('request_id', v_req_id, 'type', v_dtype, 'value', v_dval, 'effective_percent', app.discount_effective_percent(v_dtype, v_dval, v_price.price),
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

create or replace function public.record_booking_payment(p_booking_id uuid, p_amount numeric, p_paid_on date default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); b public.workshop_bookings; m record; v_remaining numeric; v_rate numeric; v_fetched timestamptz; v_id uuid; v_kind text;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into b from public.workshop_bookings where id = p_booking_id for update;
  if not found or not app.has_company_access(b.company_id) or not (b.created_by = v_uid or app.is_company_manager(b.company_id)) then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;
  if b.status = 'pending_approval' then raise exception 'booking.awaiting_approval' using errcode = '23514'; end if;
  if b.status <> 'booked' then raise exception 'booking.invalid_transition' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount, 2) then raise exception 'payment.invalid_amount' using errcode = '23514'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'payment.invalid_date' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  select * into m from app.booking_money(array[b.id]);
  v_remaining := b.final_price - m.confirmed - m.pending;
  if p_amount > v_remaining then raise exception 'booking.overpayment' using errcode = '23514'; end if;
  v_kind := case when p_amount = v_remaining then 'full' else 'partial' end;
  if b.currency = 'EGP' then
    v_rate := 1; v_fetched := null;
  else
    select r.rate_to_egp, r.fetched_at into v_rate, v_fetched from public.fx_rates r where r.currency = b.currency;
    if v_rate is null then raise exception 'payment.rate_unavailable' using errcode = '23514'; end if;
    if v_fetched < now() - interval '48 hours' then raise exception 'payment.rate_stale' using errcode = '23514'; end if;
  end if;
  insert into public.payments (company_id, contact_id, offering_id, booking_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, note, created_by)
  values (b.company_id, b.contact_id, b.offering_id, b.id, p_amount, b.currency, v_rate, case when b.currency = 'EGP' then 'egp' else 'auto' end, v_fetched,
          v_kind, coalesce(p_paid_on, current_date), nullif(btrim(p_note), ''), case when b.recorded_by is not null then b.created_by else v_uid end)
  returning id into v_id;
  perform app.write_audit(b.company_id, 'payment.recorded', 'payment', v_id,
    jsonb_build_object('credited_to', case when b.recorded_by is not null then b.created_by else v_uid end, 'entered_by', v_uid, 'currency', b.currency, 'offering_id', b.offering_id, 'kind', v_kind, 'booking_id', b.id));
  return v_id;
end $$;

revoke all on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date, uuid) from public, anon;
grant execute on function public.create_workshop_booking(uuid, uuid, text, text, text, numeric, text, text, date, uuid) to authenticated, service_role;
