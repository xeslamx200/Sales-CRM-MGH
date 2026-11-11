-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval, run with psql -1 (single transaction).
-- 20261104000980 - Workshop payments: price per workshop, multi-currency payments with a frozen EGP total, manager confirmation, proof image.
--
--  * company_offerings.price_egp          price of a workshop / course in EGP (nullable until an admin sets it).
--  * public.fx_rates                      latest exchange rates to EGP, written ONLY by the server (service role) from an external rate source.
--  * public.payments                      one row per payment: customer (contact) + workshop (offering) + amount in ANY currency. The
--                                         rate used is read by the database itself from fx_rates (never taken from the caller) and
--                                         FROZEN in the row; amount_egp = round(amount * rate, 2) is computed by the database.
--                                         Status: pending -> confirmed | rejected (a manager decides). Only confirmed rows count.
--  * public.record_payment / review_payment   the only write paths (no direct INSERT/UPDATE/DELETE for users).
--  * public.payment_balance               price + confirmed/pending EGP totals of a customer for one workshop (aggregates over all payments).
--  * attachments                          entity_type 'payment' is allowed, so the existing private proof-image upload is reused.
--
-- Visibility: a user sees the payments they recorded; company managers / admins / super admins see every payment of their company.
-- Rollback: supabase/proposed/rollbacks/20261104000980_payments.rollback.sql (refuses while payments exist).

-- ------------------------------------------------------------------ 1. workshop price
alter table public.company_offerings
  add column price_egp numeric(14, 2) check (price_egp is null or price_egp >= 0);

-- ------------------------------------------------------------------ 2. exchange rates
create table public.fx_rates (
  currency char(3) primary key check (currency ~ '^[A-Z]{3}$' and currency <> 'EGP'),
  rate_to_egp numeric(18, 8) not null check (rate_to_egp > 0),
  fetched_at timestamptz not null,
  source text not null check (length(source) between 1 and 80)
);
alter table public.fx_rates enable row level security;
revoke all on public.fx_rates from public, anon, authenticated;
grant select on public.fx_rates to authenticated;
grant all on public.fx_rates to service_role;
create policy fx_rates_select on public.fx_rates for select to authenticated using (true);

-- Server only (service role): replace the rates for the given currencies. p_rates = {"USD": 48.5, "EUR": 52.1, ...} (1 unit = N EGP).
create or replace function public.upsert_fx_rates(p_rates jsonb, p_source text) returns integer
language plpgsql security definer set search_path = '' as $$
declare k text; v numeric; n int := 0;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_rates) <> 'object' or p_source is null or btrim(p_source) = '' then
    raise exception 'payment.invalid_rates' using errcode = '22023';
  end if;
  for k, v in select key, (value #>> '{}')::numeric from jsonb_each(p_rates) loop
    if k !~ '^[A-Z]{3}$' or k = 'EGP' or v is null or v <= 0 or v > 1000000 then
      raise exception 'payment.invalid_rates' using errcode = '22023';
    end if;
    insert into public.fx_rates (currency, rate_to_egp, fetched_at, source) values (k, v, now(), left(p_source, 80))
    on conflict (currency) do update set rate_to_egp = excluded.rate_to_egp, fetched_at = excluded.fetched_at, source = excluded.source;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.upsert_fx_rates(jsonb, text) from public, anon, authenticated;
grant execute on function public.upsert_fx_rates(jsonb, text) to service_role;

-- ------------------------------------------------------------------ 3. payments
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  offering_id uuid not null,
  amount numeric(14, 2) not null check (amount > 0 and amount <= 1000000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  fx_rate_to_egp numeric(18, 8) not null check (fx_rate_to_egp > 0),
  fx_source text not null check (fx_source in ('egp', 'auto')),
  fx_fetched_at timestamptz,
  amount_egp numeric(14, 2) generated always as (round(amount * fx_rate_to_egp, 2)) stored,
  kind text not null check (kind in ('partial', 'full')),
  paid_on date not null default current_date,
  note text check (note is null or length(note) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 1000),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (offering_id, company_id) references public.company_offerings (id, company_id),
  check ((currency = 'EGP' and fx_rate_to_egp = 1 and fx_source = 'egp') or (currency <> 'EGP' and fx_source = 'auto' and fx_fetched_at is not null)),
  check ((status = 'pending' and reviewed_by is null and reviewed_at is null) or (status <> 'pending' and reviewed_at is not null))
);
create index payments_company_idx on public.payments (company_id, status, created_at desc);
create index payments_contact_idx on public.payments (contact_id);
create index payments_offering_idx on public.payments (offering_id);
create index payments_creator_idx on public.payments (created_by);

-- Immutable except through review_payment (which sets the app flag in its own transaction).
create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'payment.immutable' using errcode = '42501'; end if;
  if (new.company_id, new.contact_id, new.offering_id, new.amount, new.currency, new.fx_rate_to_egp, new.fx_source, new.fx_fetched_at,
      new.kind, new.paid_on, new.note, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.contact_id, old.offering_id, old.amount, old.currency, old.fx_rate_to_egp, old.fx_source, old.fx_fetched_at,
      old.kind, old.paid_on, old.note, old.created_by, old.created_at) then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('app.payment_review', true), '') <> 'on' then
    raise exception 'payment.immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payments_guard before update or delete on public.payments
  for each row execute function app.guard_payment();

alter table public.payments enable row level security;
revoke all on public.payments from public, anon, authenticated;
grant select on public.payments to authenticated;
grant all on public.payments to service_role;
create policy payments_select on public.payments for select to authenticated
  using (app.has_company_access(company_id)
         and (created_by = (select auth.uid()) or app.is_company_manager(company_id)));

-- ------------------------------------------------------------------ 4. record a payment
create or replace function public.record_payment(
  p_contact_id uuid, p_offering_id uuid, p_amount numeric, p_currency text, p_kind text, p_paid_on date default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_off public.company_offerings;
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_rate numeric; v_fetched timestamptz; v_id uuid;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or not app.has_company_access(v_off.company_id) then raise exception 'payment.offering_not_found' using errcode = 'P0002'; end if;
  if not v_off.is_active then raise exception 'payment.offering_inactive' using errcode = '23514'; end if;
  -- the customer must be visible to the caller AND belong to the workshop's company (a payment never crosses companies)
  if not app.can_see_contact(p_contact_id)
     or not exists (select 1 from public.contacts k where k.id = p_contact_id and k.merged_into_id is null)
     or not exists (select 1 from public.contact_companies cc where cc.contact_id = p_contact_id and cc.company_id = v_off.company_id) then
    raise exception 'payment.contact_not_found' using errcode = 'P0002';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'payment.invalid_amount' using errcode = '23514';
  end if;
  if p_kind not in ('partial', 'full') then raise exception 'payment.invalid_kind' using errcode = '23514'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'payment.invalid_date' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;

  if v_cur = 'EGP' then
    v_rate := 1; v_fetched := null;
  else
    -- the rate is read HERE, never taken from the caller
    select r.rate_to_egp, r.fetched_at into v_rate, v_fetched from public.fx_rates r where r.currency = v_cur;
    if v_rate is null then raise exception 'payment.rate_unavailable' using errcode = '23514'; end if;
    if v_fetched < now() - interval '48 hours' then raise exception 'payment.rate_stale' using errcode = '23514'; end if;
  end if;

  insert into public.payments (company_id, contact_id, offering_id, amount, currency, fx_rate_to_egp, fx_source, fx_fetched_at, kind, paid_on, note, created_by)
  values (v_off.company_id, p_contact_id, p_offering_id, p_amount, v_cur, v_rate, case when v_cur = 'EGP' then 'egp' else 'auto' end, v_fetched,
          p_kind, coalesce(p_paid_on, current_date), nullif(btrim(p_note), ''), v_uid)
  returning id into v_id;
  perform app.write_audit(v_off.company_id, 'payment.recorded', 'payment', v_id,
    jsonb_build_object('currency', v_cur, 'offering_id', p_offering_id, 'kind', p_kind));
  return v_id;
end $$;

-- ------------------------------------------------------------------ 5. manager decision
-- pending -> confirmed | rejected (managers). confirmed -> rejected (company admins / super admin only, reason required).
-- Nobody but an admin reviews a payment they recorded themselves.
create or replace function public.review_payment(p_id uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); p public.payments;
begin
  if v_uid is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_decision not in ('confirmed', 'rejected') then raise exception 'payment.invalid_decision' using errcode = '23514'; end if;
  select * into p from public.payments where id = p_id for update;
  if not found or not app.is_company_manager(p.company_id) then raise exception 'payment.not_found' using errcode = 'P0002'; end if;
  if p.created_by = v_uid and not app.is_company_admin(p.company_id) then raise exception 'payment.cannot_review_own' using errcode = '42501'; end if;
  if p.status = 'rejected' or (p.status = 'confirmed' and (p_decision <> 'rejected' or not app.is_company_admin(p.company_id))) then
    raise exception 'payment.invalid_transition' using errcode = '23514';
  end if;
  if p_decision = 'rejected' and (p_note is null or btrim(p_note) = '') then raise exception 'payment.reason_required' using errcode = '23514'; end if;
  if p_note is not null and length(p_note) > 1000 then raise exception 'payment.invalid_note' using errcode = '23514'; end if;
  perform set_config('app.payment_review', 'on', true);
  update public.payments set status = p_decision, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '') where id = p_id;
  perform set_config('app.payment_review', '', true);
  perform app.write_audit(p.company_id, 'payment.' || p_decision, 'payment', p.id, jsonb_build_object('from', p.status));
end $$;

-- Balance of a customer for one workshop: the price and the CONFIRMED / PENDING totals in EGP over ALL payments of that pair, whoever recorded
-- them (an agent only sees their own payment rows, but needs the real remaining amount). Aggregates only; the caller must see both the
-- workshop's company and the customer.
create or replace function public.payment_balance(p_contact_id uuid, p_offering_id uuid)
returns table (price_egp numeric, confirmed_egp numeric, pending_egp numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_off public.company_offerings;
begin
  if auth.uid() is null or not app.is_active_user() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into v_off from public.company_offerings where id = p_offering_id;
  if not found or not app.has_company_access(v_off.company_id) then raise exception 'payment.offering_not_found' using errcode = 'P0002'; end if;
  if not app.can_see_contact(p_contact_id) then raise exception 'payment.contact_not_found' using errcode = 'P0002'; end if;
  return query
    select v_off.price_egp,
           coalesce(sum(p.amount_egp) filter (where p.status = 'confirmed'), 0)::numeric,
           coalesce(sum(p.amount_egp) filter (where p.status = 'pending'), 0)::numeric
    from public.payments p where p.contact_id = p_contact_id and p.offering_id = p_offering_id;
end $$;
revoke all on function public.payment_balance(uuid, uuid) from public, anon;
grant execute on function public.payment_balance(uuid, uuid) to authenticated, service_role;

revoke all on function public.record_payment(uuid, uuid, numeric, text, text, date, text), public.review_payment(uuid, text, text),
  app.guard_payment() from public, anon;
grant execute on function public.record_payment(uuid, uuid, numeric, text, text, date, text), public.review_payment(uuid, text, text)
  to authenticated, service_role;

-- ------------------------------------------------------------------ 6. proof images reuse the attachments system
alter table public.attachments drop constraint attachments_entity_type_check;
alter table public.attachments add constraint attachments_entity_type_check
  check (entity_type in ('lead', 'deal', 'contact', 'task', 'conversation', 'payment'));

-- 0920 body + the payment branch
create or replace function app.guard_attachment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'attachment.immutable' using errcode = '42501';
  end if;
  new.uploaded_by := coalesce(app.actor_id(), new.uploaded_by);
  new.created_at := now();

  if new.entity_type = 'contact' then
    if not exists (select 1 from public.contact_companies cc where cc.contact_id = new.entity_id and cc.company_id = new.company_id) then
      raise exception 'attachment.company_mismatch' using errcode = '42501';
    end if;
  else
    v_company := case new.entity_type
      when 'lead' then (select company_id from public.leads where id = new.entity_id)
      when 'deal' then (select company_id from public.deals where id = new.entity_id)
      when 'task' then (select company_id from public.tasks where id = new.entity_id)
      when 'conversation' then (select company_id from public.conversations where id = new.entity_id)
      when 'payment' then (select company_id from public.payments where id = new.entity_id)
    end;
    if v_company is distinct from new.company_id then
      raise exception 'attachment.company_mismatch' using errcode = '42501';
    end if;
  end if;

  if new.storage_path !~ ('^' || new.company_id || '/' || new.entity_type || '/' || new.entity_id || '/[0-9a-f]{24}(\.[a-z0-9]{1,8})?$') then
    raise exception 'attachment.invalid_path' using errcode = '22023';
  end if;
  if new.mime_type not in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation') then
    raise exception 'attachment.unsupported_type' using errcode = '22023';
  end if;
  return new;
end $$;

-- 0200 body + the payment branch (same rule as the payments SELECT policy; this function bypasses RLS, so the rule is repeated)
create or replace function app.can_access_entity(p_entity_type text, p_entity_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_entity_type
    when 'lead' then app.can_access_lead(p_entity_id)
    when 'deal' then app.can_access_deal(p_entity_id)
    when 'contact' then app.can_see_contact(p_entity_id)
    when 'conversation' then app.can_access_conversation(p_entity_id)
    when 'task' then coalesce((
      select app.can_see_task(t.company_id, t.assigned_to, t.created_by)
      from public.tasks t where t.id = p_entity_id), false)
    when 'payment' then coalesce((
      select app.has_company_access(p.company_id) and (p.created_by = auth.uid() or app.is_company_manager(p.company_id))
      from public.payments p where p.id = p_entity_id), false)
    else false
  end
$$;
