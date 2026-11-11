-- SCRATCH / DISPOSABLE DATABASES ONLY (every file refuses unless current_database() contains 'scratch').
-- Helpers used by the concurrency scripts in this folder: unique-number sequence, caught-error log, randomized-run wrappers (T-LOCK-8),
-- merge/webhook wrappers (T-LOCK-12/13) and the audit triggers behind T-LOCK-17. Apply AFTER the Rev6 migration and the test fixtures.
do $$ begin if current_database() !~ 'scratch' then raise exception 'refusing: not a scratch database'; end if; end $$;
create sequence if not exists public.scratch_ctr start 1000000;

-- ---- from 41_stress_helpers.sql
-- SCRATCH ONLY (database name must contain "scratch"). Helpers for the randomized concurrency runs (T-LOCK-8/11/12/13/15/16).
-- pgbench (this version) has no --continue-on-error, so every action is wrapped in a function that CATCHES errors and logs them;
-- the lock behaviour under test is unaffected (each pgbench transaction is still one top-level statement = one transaction, like an RPC).
do $$ begin if current_database() !~ 'scratch' then raise exception 'refusing: not a scratch database'; end if; end $$;
create table if not exists public.scratch_accts (idx int primary key, id uuid not null, pnid text not null, orig_company uuid not null);
create table if not exists public.scratch_errlog (id bigserial primary key, at timestamptz not null default clock_timestamp(), who text, sqlstate text, msg text);

create or replace function public.scratch_w(p_idx int, p_kind int, p_cust int, p_w bigint) returns text language plpgsql as $$
declare v_pn text; v_ph text; v_r text := 'ok';
begin
  select pnid into v_pn from public.scratch_accts where idx = p_idx;
  v_ph := '2010088' || lpad((p_idx * 10 + p_cust)::text, 8, '0');
  begin
    if p_kind <= 70 then
      perform * from public.ingest_kapso_inbound(v_pn, 'wamid.l8.' || p_idx || '.' || p_w, v_ph, null, null, 'S', 'text', 'hi', null, now());
    elsif p_kind <= 85 then
      perform * from public.ingest_kapso_inbound(v_pn, 'wamid.l8b.' || p_idx || '.' || p_w, null, 'BS-L8-' || p_idx || '-' || p_cust, null, 'S', 'text', 'hi', null, now());
    elsif p_kind <= 95 then
      perform public.apply_kapso_status_v2(v_pn, 'wamid.l8e.' || p_idx || '.' || p_w, 'sent', null, null, v_ph, null, 'business_app', 'text', 'e', null, now(), false);
    else
      perform public.apply_kapso_status_v2(v_pn, 'wamid.l8f.' || p_idx || '.' || p_w, 'delivered', null, null, v_ph, null, 'cloud_api', 'text', 'e', null, now(), true);
    end if;
  exception when others then
    v_r := sqlstate; insert into public.scratch_errlog (who, sqlstate, msg) values ('webhook', sqlstate, left(sqlerrm, 160));
  end;
  return v_r;
end $$;

create or replace function public.scratch_a(p_idx int, p_kind int, p_r int) returns text language plpgsql as $$
declare v_id uuid; v_pn text; v_co uuid; v_res text := 'ok';
begin
  select id, pnid into v_id, v_pn from public.scratch_accts where idx = p_idx;
  select id into v_co from public.companies where slug = case p_r when 1 then 'alpha' when 2 then 'beta' else 'gamma' end;
  begin
    if p_kind <= 50 then
      update public.whatsapp_accounts set default_company_id = v_co where id = v_id;
    elsif p_kind <= 80 then   -- the admin screen's whole-row save: every column re-sent with its CURRENT value
      update public.whatsapp_accounts set default_company_id = default_company_id, display_name = display_name, phone_e164 = phone_e164,
        phone_number_id = phone_number_id, waba_id = waba_id, status = status, provider = provider, environment = environment where id = v_id;
    else
      perform public.touch_kapso_account(v_pn);
    end if;
  exception when others then
    v_res := sqlstate; insert into public.scratch_errlog (who, sqlstate, msg) values ('admin', sqlstate, left(sqlerrm, 160));
  end;
  return v_res;
end $$;

-- ---- from 42_merge_helpers.sql
-- SCRATCH ONLY. Helpers for T-LOCK-12 (contact lock order vs merge_contacts) and T-LOCK-13 (pre-existing merge-vs-lead cycle, decision D9).
do $$ begin if current_database() !~ 'scratch' then raise exception 'refusing: not a scratch database'; end if; end $$;
create table if not exists public.scratch_l12 (id serial primary key, typ char(1) not null, keep uuid, mrg uuid, pnid text, phone text, bsuid text, newphone text);

-- creates p_n pairs of type A (attach: merge-contact has a PHONE conversation, webhook brings a NEW bsuid), B (promotion: merge-contact is
-- bsuid-only, webhook brings a NEW phone) or C (merge-vs-lead: merge-contact has an echo conversation and an open manual lead, no lead on the conversation)
create or replace function public.scratch_l12_setup(p_typ char, p_n int, p_pnid text, p_company uuid) returns int language plpgsql as $$
declare i int; seq bigint; r record; k uuid; m uuid; ph text; php text; bs text; admin uuid := (select id from tests.users where key = 'admin_a');
begin
  for i in 1..p_n loop
    seq := nextval('public.scratch_ctr');
    if p_typ = 'A' then
      select * into r from public.ingest_kapso_inbound(p_pnid, 'wamid.l12a.k.' || seq, null, 'BS-L12A-K-' || seq, null, 'KeepA', 'text', 'hi', null, now());
      select contact_id into k from public.conversations where id = r.o_conversation_id;
      ph := '201001' || lpad(seq::text, 9, '0');
      select * into r from public.ingest_kapso_inbound(p_pnid, 'wamid.l12a.m.' || seq, ph, null, null, 'MergeA', 'text', 'hi', null, now());
      select contact_id into m from public.conversations where id = r.o_conversation_id;
      insert into public.scratch_l12 (typ, keep, mrg, pnid, phone, bsuid) values ('A', k, m, p_pnid, ph, 'BS-L12A-NEW-' || seq);
    elsif p_typ = 'B' then
      ph := '201002' || lpad(seq::text, 9, '0'); php := '201003' || lpad(seq::text, 9, '0'); bs := 'BS-L12B-' || seq;
      select * into r from public.ingest_kapso_inbound(p_pnid, 'wamid.l12b.k.' || seq, ph, null, null, 'KeepB', 'text', 'hi', null, now());
      select contact_id into k from public.conversations where id = r.o_conversation_id;
      select * into r from public.ingest_kapso_inbound(p_pnid, 'wamid.l12b.m.' || seq, null, bs, null, 'MergeB', 'text', 'hi', null, now());
      select contact_id into m from public.conversations where id = r.o_conversation_id;
      insert into public.scratch_l12 (typ, keep, mrg, pnid, bsuid, newphone) values ('B', k, m, p_pnid, bs, php);
    else
      ph := '201004' || lpad(seq::text, 9, '0'); php := '201005' || lpad(seq::text, 9, '0');
      select * into r from public.ingest_kapso_inbound(p_pnid, 'wamid.l13.k.' || seq, null, 'BS-L13-K-' || seq, null, 'KeepC', 'text', 'hi', null, now());   -- keep contact has NO phone, so merge_contacts will not refuse for conflicting phones
      select contact_id into k from public.conversations where id = r.o_conversation_id;
      -- (979) an echo no longer creates a customer: the conversation without a lead (what an echo used to leave behind) is created
      -- directly, then the echo is recorded in it (the known-conversation path).
      insert into public.contacts (full_name, phone_e164) values ('+' || ph, '+' || ph) returning id into m;
      perform app.ensure_contact_link(m, p_company);
      insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, is_simulated)
      select a.id, p_company, m, ph, a.is_simulated from public.whatsapp_accounts a where a.phone_number_id = p_pnid;
      perform public.apply_kapso_status_v2(p_pnid, 'wamid.l13.m.' || seq, 'sent', null, null, ph, null, 'business_app', 'text', 'e', null, now(), false);
      insert into public.leads (company_id, contact_id, title, source, created_by, owner_id) values (p_company, m, 'manual lead ' || seq, 'phone', admin, admin);
      insert into public.scratch_l12 (typ, keep, mrg, pnid, phone) values ('C', k, m, p_pnid, ph);
    end if;
  end loop;
  return p_n;
end $$;

create or replace function public.scratch_merge(p_typ char, p_id int) returns text language plpgsql as $$
declare v_det text; v_ctx text; v_keep uuid; v_mrg uuid; v_res text := 'ok'; v_sub uuid := (select id from tests.users where key = 'super'); v_rowid int;
begin
  select id, keep, mrg into v_rowid, v_keep, v_mrg from public.scratch_l12 where typ = p_typ order by id offset (p_id - 1) limit 1;
  if v_rowid is null then return 'none'; end if;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sub, 'role', 'authenticated')::text, true);
    perform public.merge_contacts(v_keep, v_mrg);
  exception when others then
    get stacked diagnostics v_det = pg_exception_detail, v_ctx = pg_exception_context;
    v_res := sqlstate; insert into public.scratch_errlog (who, sqlstate, msg) values ('merge' || p_typ, sqlstate, case when sqlstate = '40P01' then left(sqlerrm || ' | ' || coalesce(v_det,'') || ' | ' || coalesce(v_ctx,''), 1500) else left(sqlerrm, 120) end);
  end;
  return v_res;
end $$;

create or replace function public.scratch_w12(p_typ char, p_id int) returns text language plpgsql as $$
declare v_det text; v_ctx text; v_row public.scratch_l12; v_res text := 'ok'; v_w bigint := nextval('public.scratch_ctr');
begin
  select * into v_row from public.scratch_l12 where typ = p_typ order by id offset (p_id - 1) limit 1;
  if v_row.id is null then return 'none'; end if;
  begin
    if p_typ = 'A' then
      perform * from public.ingest_kapso_inbound(v_row.pnid, 'wamid.l12.' || v_w, v_row.phone, v_row.bsuid, null, 'MergeA', 'text', 'again', null, now());
    elsif p_typ = 'B' then
      perform * from public.ingest_kapso_inbound(v_row.pnid, 'wamid.l12.' || v_w, v_row.newphone, v_row.bsuid, null, 'MergeB', 'text', 'again', null, now());
    else
      perform * from public.ingest_kapso_inbound(v_row.pnid, 'wamid.l13.' || v_w, v_row.phone, null, null, 'MergeC', 'text', 'customer message', null, now());
    end if;
  exception when others then
    get stacked diagnostics v_det = pg_exception_detail, v_ctx = pg_exception_context;
    v_res := sqlstate; insert into public.scratch_errlog (who, sqlstate, msg) values ('w12' || p_typ, sqlstate, case when sqlstate = '40P01' then left(sqlerrm || ' | ' || coalesce(v_det,'') || ' | ' || coalesce(v_ctx,''), 1500) else left(sqlerrm, 120) end);
  end;
  return v_res;
end $$;

-- ---- from audit_account_updates.sql
-- DRAFT, NEVER EXECUTED. DISPOSABLE SCRATCH DATABASES ONLY (see lock_interleavings.sh for the safety rules).
-- T-LOCK-17 helper: records every UPDATE of whatsapp_accounts together with the session that made it, so that after running
-- the webhook suites (production + the whole 97-check sandbox suite) one can assert that NO webhook transaction updated an
-- account row (no SHARE -> write upgrade). Install it on the scratch database only, AFTER applying the migration.
create table if not exists public.scratch_account_update_log (
  id bigserial primary key, at timestamptz not null default clock_timestamp(),
  application_name text, backend_pid int, xid xid8 default pg_current_xact_id(), account_id uuid, changed_columns text[]);
create or replace function public.scratch_log_account_update() returns trigger language plpgsql as $$
begin
  insert into public.scratch_account_update_log (application_name, backend_pid, account_id, changed_columns)
  values (current_setting('application_name'), pg_backend_pid(), new.id,
          (select array_agg(key) from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key) where n.value is distinct from o.value));
  return null;
end $$;
drop trigger if exists scratch_zz_log_account_update on public.whatsapp_accounts;
create trigger scratch_zz_log_account_update after update on public.whatsapp_accounts
  for each row execute function public.scratch_log_account_update();
-- Run the suites with application_name 'webhook' for every webhook/retry session and 'admin' for the admin session, then:
--   select * from public.scratch_account_update_log where application_name = 'webhook';     -- MUST return zero rows
--   select application_name, changed_columns, count(*) from public.scratch_account_update_log group by 1, 2;   -- informational

-- ---- from 43_audit_query_trigger.sql
-- SCRATCH ONLY. T-LOCK-17 for the rolled-back suites: remember the TOP-LEVEL statement that caused each UPDATE of whatsapp_accounts.
do $$ begin if current_database() !~ 'scratch' then raise exception 'refusing: not a scratch database'; end if; end $$;

create table if not exists public.scratch_account_update_q (id bigserial primary key, query text, account_id uuid);
create or replace function public.scratch_log_account_update_q() returns trigger language plpgsql as $$
begin insert into public.scratch_account_update_q (query, account_id) values (left(current_query(), 400), new.id); return null; end $$;
drop trigger if exists scratch_zz2_log_account_update_q on public.whatsapp_accounts;
create trigger scratch_zz2_log_account_update_q after update on public.whatsapp_accounts for each row execute function public.scratch_log_account_update_q();
