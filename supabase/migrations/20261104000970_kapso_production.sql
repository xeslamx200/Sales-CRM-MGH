-- =============================================================================
-- PROPOSED REVISION 6 (NOT APPLIED, NOT EXECUTED ANYWHERE): Kapso Production accounts
-- Rev 6 changes vs rev 5: D8 approved and implemented — provider and environment of an account can never be changed after
-- creation (guard_account_sandbox); the write-side lock block now only concerns the company; rev 5 changes below stay.
-- Rev 5 changes vs rev 4 (account-row lock protocol, see 03_IMPLEMENTATION_PLAN_rev5.md section 2):
--   (1) app.kapso_resolve_account is VOLATILE and takes FOR SHARE on the account row (the company is read under the lock);
--   (2) NEW trigger conversations_a_account_lock (BEFORE INSERT on conversations): every creation path, ours or not, takes the
--       same share lock and, for Kapso production, refuses a company different from the locked account mapping;
--   (3) guard_account_sandbox takes the account row write lock explicitly (and fails closed outside READ COMMITTED) before it
--       looks for conversations; (4) the in-transaction telemetry UPDATE of the account row is removed from ingest_kapso_inbound
--       (share -> update upgrade = deadlock between two webhooks) and replaced by the standalone touch_kapso_account();
--   (5) the helper locks the contact row (NO KEY UPDATE) before it updates a conversation (same order as merge_contacts).
-- Rev 3 changes vs rev 2: (1) cross-account duplicate-wamid fallback in ingest_kapso_inbound and in the echo path of
-- apply_kapso_status_v2; (2) quarantined events are excluded from the retry query (and the expiry call cannot abort a run).
-- Rev 4 changes vs rev 3: (1) candidate-attach path of apply_kapso_status_v2 verifies who holds the wamid before applying a
-- status; (2) conversations of a Kapso production account can never change company (guard_conversation + helper
-- app.is_kapso_production_account); (3) a Kapso production account with conversations keeps its default_company_id.
-- This file approves nothing: no live migration, no outbound enablement.
-- Suggested file name: supabase/migrations/20261104000970_kapso_production.sql
--
-- Assembled by _build/build.mjs from this hand-written template plus three function bodies that are
-- taken verbatim from the live local schema (pg_get_functiondef, read-only) and modified only by exact,
-- asserted string replacements: app.guard_conversation, public.merge_contacts, public.process_webhook_retries.
--
-- NOT validated by execution. It must be run on a scratch database first (see 04_SQL_REVIEW_FINDINGS.md,
-- section "Only discoverable by execution").
--
-- Objects changed by CREATE OR REPLACE (same signature, same grants), every one restored byte-for-byte by the rollback:
--   app.guard_account_sandbox()   (0960)              + environment/phone_number_id/outbound rules
--   app.guard_conversation()      (0860 body, live)   + NULL -> value promotion of customer_wa_id / customer_bsuid
--   public.merge_contacts(uuid,uuid)  (live)          + moves contact_identities
--   public.process_webhook_retries(integer,integer) (0960) + 3 branches, unconfirmed-send expiry
-- Objects NOT touched: app.kapso_account, ingest_kapso_message / ingest_kapso_echo / apply_kapso_status, all report
-- functions, queue_outbound, record_outbound_result, apply_whatsapp_status, ingest_whatsapp_*, claim/finish_webhook_event.
--
-- check-migrations.mjs: the single UPDATE below carries a destructive-ok justification.
-- =============================================================================

-- ------------------------------------------------------------------ 1. columns
-- environment is added with a CONSTANT default so existing rows get 'production' without any row update
-- (no triggers fire, updated_at of Meta rows is untouched); the default is dropped again below so that
-- new inserts get NULL and the derive trigger can decide (keeps the current admin code working).
alter table public.whatsapp_accounts
  add column environment text not null default 'production',
  add column connection_mode text,
  add column outbound_enabled boolean not null default false,
  add column connection_state text not null default 'unknown',
  add column connection_state_at timestamptz,
  add column last_inbound_event_at timestamptz;

-- destructive-ok: backfill of the two NEW columns only, for existing Kapso (sandbox) rows; no existing column value is changed (updated_at of those rows is bumped by the existing set_updated_at trigger)
update public.whatsapp_accounts
set environment = 'sandbox', connection_mode = 'sandbox'
where provider = 'kapso';

alter table public.whatsapp_accounts alter column environment drop default;

-- ---------------------------------------------------------------- 2. constraints
alter table public.whatsapp_accounts drop constraint whatsapp_accounts_sandbox_chk;

alter table public.whatsapp_accounts
  add constraint wa_accounts_environment_chk check (environment in ('sandbox', 'production')),
  add constraint wa_accounts_mode_chk check (connection_mode is null or connection_mode in ('cloud_api', 'coexistence', 'sandbox')),
  add constraint wa_accounts_state_chk check (connection_state in ('unknown', 'connected', 'degraded', 'disconnected')),
  add constraint wa_accounts_is_sandbox_env_chk check (is_sandbox = (environment = 'sandbox')),
  add constraint wa_accounts_provider_env_chk check (provider = 'kapso' or environment = 'production'),
  add constraint wa_accounts_mode_env_chk check (
    (environment = 'sandbox' and connection_mode = 'sandbox')
    or (environment = 'production' and connection_mode is distinct from 'sandbox'
        and (provider = 'meta' or connection_mode is not null))
  ),
  add constraint wa_accounts_outbound_chk check (not outbound_enabled or (provider = 'kapso' and environment = 'production')),
  -- a production Kapso number is always real: is_simulated would make sendOutbound skip the API silently
  add constraint wa_accounts_prod_not_simulated_chk check (not (provider = 'kapso' and environment = 'production' and is_simulated)),
  add constraint wa_accounts_pnid_shape_chk check (phone_number_id is null or phone_number_id ~ '^[A-Za-z0-9._:-]{1,128}$') not valid;
alter table public.whatsapp_accounts validate constraint wa_accounts_pnid_shape_chk;

-- ------------------------------------------------------- 3. derive + guard triggers
-- Fires before whatsapp_accounts_sandbox_guard (trigger names fire in alphabetical order: "a_" < "s").
create or replace function app.derive_account_environment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.environment is null then
    new.environment := case when new.is_sandbox then 'sandbox' else 'production' end;
  end if;
  new.is_sandbox := (new.environment = 'sandbox');
  if new.connection_mode is null and new.provider = 'kapso' and new.environment = 'sandbox' then
    new.connection_mode := 'sandbox';
  end if;
  return new;
end $$;
create trigger whatsapp_accounts_a_derive_env before insert or update on public.whatsapp_accounts
  for each row execute function app.derive_account_environment();

create or replace function app.guard_account_sandbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- D8 (rev 6, approved policy): provider and environment are the IDENTITY of an account. They are chosen at creation and can
  -- never be changed afterwards, whether or not conversations exist (this replaces 0960's "immutable once it has
  -- conversations"). The old error code is kept so existing expectations ('whatsapp.provider_immutable') still hold.
  -- Keyed on an actual CHANGE: a whole-row save that sends the same values passes. is_sandbox is a derived mirror of
  -- environment (trigger whatsapp_accounts_a_derive_env fires before this one), so it can only differ if environment does.
  -- connection_mode is NOT part of the identity: cloud_api <-> coexistence stays editable; the CHECK
  -- wa_accounts_mode_env_chk still ties it to the environment. A wrongly created account is corrected by retiring it and
  -- creating a new one (plan section 1), never by editing these two values.
  -- Consequence for the lock protocol: the provider/environment seen by the unlocked peek in the conversation trigger can no
  -- longer change under it, so only the company needs the write-side lock below.
  if tg_op = 'UPDATE' and (new.provider is distinct from old.provider
                           or new.environment is distinct from old.environment
                           or new.is_sandbox is distinct from old.is_sandbox) then
    raise exception 'whatsapp.provider_immutable' using errcode = '23514';
  end if;
  -- Account-row lock protocol, WRITER side (plan section 2): whoever changes the company of a Kapso account must
  -- (a) run under READ COMMITTED, because the EXISTS over conversations below relies on a fresh snapshot per statement (under
  -- REPEATABLE READ/SERIALIZABLE it would use the transaction's OLD snapshot and could miss a conversation committed while we
  -- waited -> fail closed), and (b) hold the account row's write lock BEFORE looking for conversations. The UPDATE already
  -- took that lock when it fetched the old tuple for this BEFORE trigger; the explicit statement makes the protocol
  -- independent of that executor detail. It conflicts with the FOR SHARE every conversation creator holds, so either the
  -- creator's conversation is committed (and visible to the EXISTS below) or we hold the lock and the creator waits and
  -- re-reads the NEW company. (provider is immutable here, so old.provider = new.provider.)
  if tg_op = 'UPDATE' and old.provider = 'kapso'
     and new.default_company_id is distinct from old.default_company_id then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'whatsapp.isolation_unsupported' using errcode = '55000';
    end if;
    perform 1 from public.whatsapp_accounts a where a.id = old.id for no key update;
  end if;
  if new.is_sandbox is distinct from app.company_is_sandbox(new.default_company_id) then
    raise exception 'whatsapp.sandbox_company_mismatch' using errcode = '23514';
  end if;
  -- the trusted phone_number_id -> company mapping of a Kapso production account is frozen once it has conversations.
  if tg_op = 'UPDATE' and new.provider = 'kapso' and new.environment = 'production'
     and new.phone_number_id is distinct from old.phone_number_id
     and exists (select 1 from public.conversations c where c.whatsapp_account_id = new.id) then
    raise exception 'whatsapp.phone_number_id_immutable' using errcode = '23514';
  end if;
  -- (rev 4) a Kapso production account keeps its company once it has conversations. Keyed on an actual CHANGE
  -- (saveWhatsappAccount sends the whole row on every edit, so an unchanged value must pass). SECURITY DEFINER, so the EXISTS
  -- sees every conversation regardless of the caller's RLS. Without conversations the account may still be re-pointed to
  -- another REAL company by a super admin (RLS wa_accounts_write); the sandbox/company match check above still applies.
  if tg_op = 'UPDATE' and old.provider = 'kapso' and old.environment = 'production'
     and new.default_company_id is distinct from old.default_company_id
     and exists (select 1 from public.conversations c where c.whatsapp_account_id = new.id) then
    raise exception 'whatsapp.default_company_immutable' using errcode = '42501';
  end if;
  -- outbound can only be switched ON for an active account (re-checked at send time).
  if new.outbound_enabled and (tg_op = 'INSERT' or not old.outbound_enabled) and new.status <> 'active' then
    raise exception 'whatsapp.outbound_requires_active' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------- 4. account resolution (new)
-- app.kapso_account(text) (sandbox only) is untouched. The company always comes from the account row.
-- Rev 5: VOLATILE (a locking SELECT is not allowed in a STABLE function) and FOR SHARE: READER/creator side of the
-- account-row lock protocol. FOR SHARE (not KEY SHARE) is required: only SHARE conflicts with the NO KEY UPDATE lock an
-- ordinary UPDATE of default_company_id takes. Shares are mutually compatible, so concurrent webhooks of the same
-- account never block each other; only an account writer waits (and is waited for). In READ COMMITTED the row returned
-- after a wait is the LATEST committed version, so the company read here is the final mapping while the share is held.
-- The lock is held to the end of the transaction. RULE (checked by the verifier, C7): no function that calls this
-- one may UPDATE whatsapp_accounts afterwards (share -> update upgrade = deadlock between two concurrent callers).
create or replace function app.kapso_resolve_account(p_phone_number_id text) returns public.whatsapp_accounts
language plpgsql volatile security definer set search_path = '' as $$
declare v public.whatsapp_accounts;
begin
  select * into v from public.whatsapp_accounts a where a.phone_number_id = p_phone_number_id and a.provider = 'kapso' for share;
  if not found or v.status not in ('test', 'active') then
    raise exception 'kapso.unknown_account' using errcode = 'P0002';
  end if;
  if v.environment = 'sandbox' and not app.company_is_sandbox(v.default_company_id) then
    raise exception 'kapso.account_not_sandbox' using errcode = '42501';
  end if;
  if v.environment = 'production' and app.company_is_sandbox(v.default_company_id) then
    raise exception 'kapso.account_not_production' using errcode = '42501';
  end if;
  return v;
end $$;

-- Used by the (invoker, RLS-subject) conversation guard: it must see the account row even when the caller cannot,
-- hence SECURITY DEFINER. Reads provider/environment from the account row; never infers anything from is_simulated.
create or replace function app.is_kapso_production_account(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.whatsapp_accounts a
                 where a.id = p_account_id and a.provider = 'kapso' and a.environment = 'production')
$$;

-- Rev 5 — account-row lock protocol, TABLE-LEVEL creator side. EVERY INSERT into conversations (ours, the Meta wrappers,
-- the 0960 sandbox wrappers, fixtures, any future path) passes here. For a Kapso account it takes FOR SHARE on the account
-- row (a no-op when the caller already holds it from kapso_resolve_account) and, for a PRODUCTION account, refuses a
-- company other than the LOCKED account mapping. So the trusted phone_number_id -> company mapping holds even for a path that
-- read the account without a lock (e.g. a Meta-signed webhook naming a Kapso phone_number_id). Fires before
-- conversations_sandbox_flag (trigger names fire alphabetically: "conversations_a_" < "conversations_s").
-- Meta accounts are not locked and nothing changes for them. The provider peek is unlocked but cannot be stale: since rev 6
-- (D8) provider and environment never change after the account is created (guard_account_sandbox).
create or replace function app.lock_account_for_conversation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_provider text; v_env text; v_company uuid;
begin
  select a.provider into v_provider from public.whatsapp_accounts a where a.id = new.whatsapp_account_id;
  if v_provider = 'kapso' then
    select a.environment, a.default_company_id into v_env, v_company
    from public.whatsapp_accounts a where a.id = new.whatsapp_account_id for share;
    if v_env = 'production' and new.company_id is distinct from v_company then
      raise exception 'conversation.account_company_mismatch' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger conversations_a_account_lock before insert on public.conversations
  for each row execute function app.lock_account_for_conversation();

-- ------------------------------------------------ 5. messages: origin + send guard
alter table public.messages
  add column provider_origin text
  check (provider_origin is null or provider_origin in ('cloud_api', 'business_app', 'other_app', 'meta_business_agent'));
-- history_sync is intentionally NOT storable: such events never create a message.

-- Defence in depth ONLY. The real pre-API gate is queue_outbound -> this INSERT (the row is inserted, and therefore
-- this trigger runs, BEFORE any request to Kapso; see 03_PLAN.md section 4a).
create or replace function app.block_kapso_unready_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.whatsapp_accounts; v_company uuid;
begin
  if new.direction <> 'outbound' or new.sent_by is null then return new; end if;
  select c.company_id into v_company from public.conversations c where c.id = new.conversation_id;
  select wa.* into a from public.whatsapp_accounts wa
    join public.conversations c on c.whatsapp_account_id = wa.id where c.id = new.conversation_id;
  if found and a.provider = 'kapso' and a.environment = 'production' then
    if not a.outbound_enabled or a.status <> 'active' then
      raise exception 'whatsapp.outbound_disabled' using errcode = '23514';
    end if;
    if v_company is distinct from a.default_company_id then
      raise exception 'whatsapp.account_company_mismatch' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger messages_kapso_send_guard before insert on public.messages
  for each row execute function app.block_kapso_unready_send();

-- ------------------------------------------------------------ 6. BSUID identities
create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  whatsapp_account_id uuid not null references public.whatsapp_accounts (id) on delete restrict,
  kind text not null default 'bsuid' check (kind = 'bsuid'),
  value text not null check (value ~ '^[^[:space:]]{1,128}$'),
  created_at timestamptz not null default now(),
  unique (whatsapp_account_id, kind, value)
);
create index contact_identities_contact_idx on public.contact_identities (contact_id);
alter table public.contact_identities enable row level security;
create policy contact_identities_select on public.contact_identities for select to authenticated
  using (app.is_super_admin() or whatsapp_account_id in (
    select a.id from public.whatsapp_accounts a
    where a.default_company_id in (select t.id from app.accessible_company_ids() as t(id))));
revoke all on public.contact_identities from public, anon, authenticated;
grant select on public.contact_identities to authenticated;
grant all on public.contact_identities to service_role;

alter table public.conversations
  alter column customer_wa_id drop not null,
  add column customer_bsuid text check (customer_bsuid is null or customer_bsuid ~ '^[^[:space:]]{1,128}$'),
  add constraint conversations_customer_identity_chk check (customer_wa_id is not null or customer_bsuid is not null);
create unique index conversations_account_bsuid_uidx on public.conversations (whatsapp_account_id, customer_bsuid)
  where customer_bsuid is not null;

-- ------------------------------------------------ 6b. conversation guard (replaced, live body + promotion rule)
CREATE OR REPLACE FUNCTION app.guard_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_service boolean := app.is_service_context() or app.in_system_op();
begin
  if (new.whatsapp_account_id, new.is_simulated, new.created_at)
     is distinct from (old.whatsapp_account_id, old.is_simulated, old.created_at) then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  -- Kapso BSUID support: an identity column may go from NULL to a value (promotion / attaching a BSUID), only in
  -- service context; it can never be changed or cleared afterwards. For every pre-existing path (customer_wa_id is
  -- set at insert and never updated) this is exactly the previous behaviour.
  if new.customer_wa_id is distinct from old.customer_wa_id
     and not (old.customer_wa_id is null and new.customer_wa_id is not null and v_service) then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if new.customer_bsuid is distinct from old.customer_bsuid
     and not (old.customer_bsuid is null and new.customer_bsuid is not null and v_service) then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  -- Rev 4: a conversation of a Kapso PRODUCTION account (provider/environment read from the account row through a
  -- SECURITY DEFINER helper, because this function is an invoker and its caller may not be allowed to see the account)
  -- can never change company. This sits BEFORE the service-context bypass below, so it also holds for the service role
  -- and for app.system_op. There is deliberately no bypass: an exceptional move would need its own approved migration.
  -- Meta and Sandbox conversations are unaffected (the helper returns false); owner reassignment does not touch company_id.
  if new.company_id is distinct from old.company_id and app.is_kapso_production_account(old.whatsapp_account_id) then
    raise exception 'conversation.kapso_production_company_locked' using errcode = '42501';
  end if;
  if v_service then return new; end if;

  if new.contact_id is distinct from old.contact_id
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if (new.last_message_at, new.last_inbound_at, new.last_outbound_at)
     is distinct from (old.last_message_at, old.last_inbound_at, old.last_outbound_at) then
    raise exception 'conversation.system_field' using errcode = '42501';
  end if;
  if new.unread_count is distinct from old.unread_count and new.unread_count <> 0 then
    raise exception 'conversation.unread_can_only_be_cleared' using errcode = '42501';
  end if;
  if new.company_id is distinct from old.company_id
     and not (app.is_company_manager(old.company_id) and app.is_company_manager(new.company_id)) then
    raise exception 'conversation.company_change_forbidden' using errcode = '42501';
  end if;
  if new.owner_id is distinct from old.owner_id then
    if new.owner_id is not null and not (
      app.is_company_member(new.company_id, new.owner_id)
      and app.user_has_wa_access(new.whatsapp_account_id, new.owner_id)
    ) then
      raise exception 'conversation.owner_needs_number_access' using errcode = '23514';
    end if;
    if not (
      app.is_company_manager(new.company_id)
      or (old.owner_id is null and new.owner_id = auth.uid() and exists (
        select 1 from public.whatsapp_account_access a
        where a.whatsapp_account_id = new.whatsapp_account_id and a.user_id = auth.uid() and a.can_reply))
      or (old.owner_id = auth.uid() and new.owner_id is null)
    ) then
      raise exception 'conversation.assign_forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $function$;

-- ------------------------------------------------ 6c. merge_contacts (replaced, live body + identities follow the survivor)
CREATE OR REPLACE FUNCTION public.merge_contacts(p_keep_id uuid, p_merge_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_keep public.contacts;
  v_merge public.contacts;
  v_companies uuid[];
begin
  if auth.uid() is null or not app.is_active_user() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_keep_id = p_merge_id then
    raise exception 'contact.merge_same' using errcode = '23514';
  end if;
  select * into v_keep from public.contacts where id = p_keep_id for update;
  select * into v_merge from public.contacts where id = p_merge_id for update;
  if v_keep.id is null or v_merge.id is null or v_keep.merged_into_id is not null or v_merge.merged_into_id is not null
     or not app.can_see_contact(p_keep_id) or not app.can_see_contact(p_merge_id) then
    raise exception 'contact.not_found' using errcode = 'P0002';
  end if;

  -- Every company whose data references either contact.
  select array_agg(distinct x.company_id) into v_companies from (
    select company_id from public.contact_companies where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.leads where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.deals where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.tasks where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.activities where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.conversations where contact_id in (p_keep_id, p_merge_id)
  ) x;

  if not app.is_super_admin() then
    if v_companies is null then
      -- No company footprint: only the person who created both may merge.
      if v_keep.created_by is distinct from auth.uid() or v_merge.created_by is distinct from auth.uid() then
        raise exception 'contact.merge_forbidden' using errcode = '42501';
      end if;
    elsif exists (select 1 from unnest(v_companies) c(id) where not app.is_company_admin(c.id)) then
      raise exception 'contact.merge_forbidden' using errcode = '42501';
    end if;
  end if;
  if v_keep.phone_e164 is not null and v_merge.phone_e164 is not null and v_keep.phone_e164 <> v_merge.phone_e164 then
    raise exception 'contact.merge_conflicting_phones' using errcode = '23514';
  end if;

  perform set_config('app.merging_contacts', 'on', true);

  update public.contacts set merged_into_id = p_keep_id where id = p_merge_id;
  update public.contacts set
    phone_e164 = coalesce(phone_e164, v_merge.phone_e164),
    email = coalesce(email, v_merge.email)
  where id = p_keep_id;

  update public.leads set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.deals set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.tasks set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.activities set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.conversations set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.contact_identities set contact_id = p_keep_id where contact_id = p_merge_id;

  update public.contact_companies cc set contact_id = p_keep_id
  where cc.contact_id = p_merge_id
    and not exists (select 1 from public.contact_companies k
                    where k.contact_id = p_keep_id and k.company_id = cc.company_id);
  delete from public.contact_companies where contact_id = p_merge_id;

  update public.contact_duplicate_reviews set status = 'merged', resolved_by = auth.uid(), resolved_at = now()
  where status = 'pending' and (contact_a_id in (p_keep_id, p_merge_id) or contact_b_id in (p_keep_id, p_merge_id));

  perform set_config('app.merging_contacts', '', true);

  perform app.write_audit(null, 'contact.merged', 'contact', p_keep_id,
    jsonb_build_object('merged_contact_id', p_merge_id));
end $function$;

-- ------------------------------------------------ 7. identity -> conversation helper
-- Production/BSUID intake only. Service context only (every caller asserts it; the function is not granted to anyone else).
-- No app.system_op is used: the updates below are legal in service context, so there is no flag to restore.
-- Rules: phone wins; a BSUID is attached to the phone conversation when free; a BSUID-only conversation is promoted
-- when its phone becomes known and that phone is free (or already the same contact's); conflicts never merge
-- automatically (audit row, human decides). A BSUID is only ever looked up inside ONE whatsapp account.
create or replace function app.kapso_resolve_conversation(
  p_acc public.whatsapp_accounts, p_wa_id text, p_bsuid text, p_name text
) returns table (o_contact_id uuid, o_conversation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_phone text := case when p_wa_id is not null then '+' || p_wa_id end;
  cp public.conversations;      -- conversation found by phone
  cb public.conversations;      -- conversation found by BSUID
  v_contact uuid;
  v_conv uuid;
  v_holder uuid;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_wa_id is null and p_bsuid is null then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  -- fixed lock order (phone, then BSUID) so concurrent deliveries cannot deadlock; both rows are re-read AFTER the locks
  if p_wa_id is not null then perform pg_advisory_xact_lock(hashtextextended('kapso:id:' || p_acc.id || ':p:' || p_wa_id, 0)); end if;
  if p_bsuid is not null then perform pg_advisory_xact_lock(hashtextextended('kapso:id:' || p_acc.id || ':b:' || p_bsuid, 0)); end if;

  if p_wa_id is not null then
    select * into cp from public.conversations c where c.whatsapp_account_id = p_acc.id and c.customer_wa_id = p_wa_id;
  end if;
  if p_bsuid is not null then
    select * into cb from public.conversations c where c.whatsapp_account_id = p_acc.id and c.customer_bsuid = p_bsuid;
  end if;

  if cp.id is not null then
    v_conv := cp.id; v_contact := cp.contact_id;
    if p_bsuid is not null and cb.id is null and cp.customer_bsuid is null
       and not exists (select 1 from public.contact_identities i
                       where i.whatsapp_account_id = p_acc.id and i.kind = 'bsuid' and i.value = p_bsuid) then
      -- lock order contact -> conversation (merge_contacts locks contacts first, then updates conversations)
      perform 1 from public.contacts k where k.id = cp.contact_id for no key update;
      update public.conversations set customer_bsuid = p_bsuid where id = cp.id;
      insert into public.contact_identities (contact_id, whatsapp_account_id, kind, value)
      values (cp.contact_id, p_acc.id, 'bsuid', p_bsuid);
    elsif cb.id is not null and cb.id <> cp.id then
      -- two conversations for one customer: keep the phone one, change nothing, leave a trace for a human
      perform app.write_audit(p_acc.default_company_id, 'conversation.identity_conflict', 'conversation', cp.id,
                              jsonb_build_object('other_conversation_id', cb.id));
    end if;
  elsif cb.id is not null then
    v_conv := cb.id; v_contact := cb.contact_id;
    if p_wa_id is not null and cb.customer_wa_id is null then
      select k.id into v_holder from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null;
      if v_holder is null or v_holder = cb.contact_id then
        perform 1 from public.contacts k where k.id = cb.contact_id for no key update;   -- contact before conversation (see above)
        update public.conversations set customer_wa_id = p_wa_id where id = cb.id;     -- allowed by the revised guard (NULL -> value)
        update public.contacts set phone_e164 = v_phone where id = cb.contact_id and phone_e164 is null;
      else
        perform app.write_audit(p_acc.default_company_id, 'conversation.identity_conflict', 'conversation', cb.id,
                                jsonb_build_object('phone_belongs_to_contact_id', v_holder));
      end if;
    end if;
  else
    -- brand new customer for this account
    if p_wa_id is not null then
      select k.id into v_contact from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null;
    else
      select i.contact_id into v_contact from public.contact_identities i
      where i.whatsapp_account_id = p_acc.id and i.kind = 'bsuid' and i.value = p_bsuid;
      -- defensive: follow a merge (merge_contacts moves identities, so this is normally a no-op)
      select coalesce(k.merged_into_id, k.id) into v_contact from public.contacts k where k.id = v_contact;
    end if;
    if v_contact is null then
      insert into public.contacts (full_name, phone_e164)
      values (coalesce(nullif(btrim(left(p_name, 200)), ''), coalesce(v_phone, 'WhatsApp')), v_phone)
      on conflict (phone_e164) where merged_into_id is null and phone_e164 is not null do nothing
      returning id into v_contact;
      if v_contact is null and v_phone is not null then      -- lost a race with another account's intake of the same phone
        select k.id into v_contact from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null;
      end if;
    end if;
    if p_bsuid is not null then
      insert into public.contact_identities (contact_id, whatsapp_account_id, kind, value)
      values (v_contact, p_acc.id, 'bsuid', p_bsuid)
      on conflict (whatsapp_account_id, kind, value) do nothing;
    end if;
    perform app.ensure_contact_link(v_contact, p_acc.default_company_id);
    insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, customer_bsuid, is_simulated)
    values (p_acc.id, p_acc.default_company_id, v_contact, p_wa_id, p_bsuid, p_acc.is_simulated)
    on conflict do nothing
    returning id into v_conv;
    if v_conv is null then
      raise exception 'kapso.identity_conflict' using errcode = '23505';   -- the retry job tries again; nothing was guessed
    end if;
    if p_acc.environment = 'sandbox' then   -- display hint only (same rule as 0960's mark_new_sandbox_contact)
      update public.contacts set is_sandbox = true
      where id = v_contact and not is_sandbox
        and not exists (select 1 from public.contact_companies cc where cc.contact_id = v_contact and not app.company_is_sandbox(cc.company_id));
    end if;
  end if;
  perform app.ensure_contact_link(v_contact, p_acc.default_company_id);
  return query select v_contact, v_conv;
end $$;

-- ------------------------------------------------------ 8. intake wrappers (new)
-- Customer message. origin NULL or 'cloud_api' only. Sandbox + phone delegates to the UNCHANGED 0960 wrapper.
create or replace function public.ingest_kapso_inbound(
  p_phone_number_id text, p_wa_message_id text, p_from_wa_id text, p_from_bsuid text, p_origin text,
  p_profile_name text, p_message_type text, p_body text, p_media jsonb, p_sent_at timestamptz
) returns table (o_message_id uuid, o_conversation_id uuid, o_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts; v_msg uuid; v_conv uuid; v_exist_conv uuid; r record;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_origin is not null and p_origin <> 'cloud_api' then
    raise exception 'kapso.origin_not_ingestable' using errcode = '22023';
  end if;
  if p_wa_message_id is null or (p_from_wa_id is null and p_from_bsuid is null)
     or (p_from_wa_id is not null and p_from_wa_id !~ '^[1-9][0-9]{6,14}$')
     or (p_from_bsuid is not null and p_from_bsuid !~ '^[^[:space:]]{1,128}$') then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  v_acc := app.kapso_resolve_account(p_phone_number_id);

  if v_acc.environment = 'sandbox' and p_from_wa_id is not null and p_from_bsuid is null then
    return query select k.message_id, k.conversation_id, k.duplicate
      from public.ingest_kapso_message(p_phone_number_id, p_wa_message_id, p_from_wa_id, p_profile_name,
                                       p_message_type, p_body, p_media, p_sent_at) k;
    return;
  end if;

  select m.id, m.conversation_id into v_msg, v_conv from public.messages m where m.wa_message_id = p_wa_message_id;
  if found then
    if not exists (select 1 from public.conversations c where c.id = v_conv and c.whatsapp_account_id = v_acc.id) then
      raise exception 'kapso.message_account_mismatch' using errcode = '42501';
    end if;
    return query select v_msg, v_conv, true;
    return;
  end if;

  select * into r from app.kapso_resolve_conversation(v_acc, p_from_wa_id, p_from_bsuid, p_profile_name);
  v_conv := r.o_conversation_id;
  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status, sent_at,
                               is_simulated, provider_origin)
  values (v_conv, 'inbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096), p_media,
          'received', coalesce(p_sent_at, now()), v_acc.is_simulated, p_origin)
  on conflict (wa_message_id) do nothing
  returning id into v_msg;
  if v_msg is null then
    -- Lost a race: a row with this wamid exists. Read its ACTUAL conversation, never reuse the locally resolved v_conv
    -- (that one belongs to THIS account; the winner may belong to another). Only a verified owner gets an answer, and the
    -- answer pairs the message id with its own conversation id. A mismatch raises, which rolls back everything this call
    -- created (contact, identity, conversation) because the whole function is one transaction.
    select m.id, m.conversation_id into v_msg, v_exist_conv from public.messages m where m.wa_message_id = p_wa_message_id;
    if v_msg is null or not exists (select 1 from public.conversations c
                                    where c.id = v_exist_conv and c.whatsapp_account_id = v_acc.id) then
      raise exception 'kapso.message_account_mismatch' using errcode = '42501';
    end if;
    return query select v_msg, v_exist_conv, true;
    return;
  end if;
  -- (rev 5) no UPDATE of whatsapp_accounts here: this transaction holds FOR SHARE on that row (kapso_resolve_account); two
  -- concurrent webhooks that each tried to upgrade share -> update would deadlock. Telemetry: touch_kapso_account() below.
  perform app.ensure_whatsapp_lead(v_conv, p_body);
  return query select v_msg, v_conv, false;
end $$;

-- Status of an outbound message, and echoes of messages the CRM did not create. Returns false = "cannot be applied yet".
-- p_origin: 'cloud_api' | 'business_app' | 'other_app' | 'meta_business_agent' | NULL (= 'cloud_api').
-- p_is_retry: false from the webhook handler, true from process_webhook_retries.
-- Unknown wamid, origin cloud_api:
--   exactly 1 CRM message in that conversation still waiting for its wamid (same type + body, <= 15 min)  -> attach (no new row);
--   2 or more                                                                                           -> false (never guess);
--   0 and first delivery (not a retry)                                                                  -> false (the API response may still be in flight);
--   0 on a retry                                                                                        -> echo, sent_by NULL.
-- Unknown wamid, origin business_app / other_app / meta_business_agent -> echo, sent_by NULL, immediately.
create or replace function public.apply_kapso_status_v2(
  p_phone_number_id text, p_wa_message_id text, p_status text, p_error_code text, p_error_message text,
  p_to_wa_id text, p_to_bsuid text, p_origin text, p_message_type text, p_body text, p_media jsonb, p_sent_at timestamptz,
  p_is_retry boolean default false
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts; v_owner uuid; v_org text := coalesce(p_origin, 'cloud_api');
  r record; v_cands uuid[];
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if v_org not in ('cloud_api', 'business_app', 'other_app', 'meta_business_agent') then
    raise exception 'kapso.origin_not_ingestable' using errcode = '22023';
  end if;
  if (p_to_wa_id is not null and p_to_wa_id !~ '^[1-9][0-9]{6,14}$')
     or (p_to_bsuid is not null and p_to_bsuid !~ '^[^[:space:]]{1,128}$') then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  v_acc := app.kapso_resolve_account(p_phone_number_id);

  if v_acc.environment = 'sandbox' then   -- 0960 behaviour, unchanged
    return public.apply_kapso_status(p_phone_number_id, p_wa_message_id, p_status, p_error_code, p_error_message,
                                     p_to_wa_id, p_message_type, p_body, p_media, p_sent_at);
  end if;

  select c.whatsapp_account_id into v_owner
  from public.messages m join public.conversations c on c.id = m.conversation_id where m.wa_message_id = p_wa_message_id;
  if found then
    if v_owner is distinct from v_acc.id then raise exception 'kapso.message_account_mismatch' using errcode = '42501'; end if;
    return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
  end if;

  if p_to_wa_id is null and p_to_bsuid is null then return false; end if;   -- customer unknown: never guess

  if v_org = 'cloud_api' then
    select array_agg(m.id) into v_cands
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.whatsapp_account_id = v_acc.id and m.direction = 'outbound' and m.wa_message_id is null and m.sent_by is not null
      and m.status = 'queued' and m.created_at > now() - interval '15 minutes'
      and m.message_type = left(coalesce(p_message_type, 'text'), 40) and m.body is not distinct from left(p_body, 4096)
      and ((p_to_wa_id is not null and c.customer_wa_id = p_to_wa_id)
           or (p_to_bsuid is not null and c.customer_bsuid = p_to_bsuid));
    if coalesce(array_length(v_cands, 1), 0) = 1 then
      begin
        update public.messages set wa_message_id = p_wa_message_id where id = v_cands[1] and wa_message_id is null;
      exception when unique_violation then
        null;   -- another row (possibly another account's) carries this wamid: decided by the ownership check below
      end;
      -- The UPDATE may have matched zero rows (the candidate got its wamid or changed concurrently) or been refused by the
      -- unique index. Never apply a status before verifying WHO holds the wamid NOW. Safe between check and apply because
      -- messages.wa_message_id, messages.conversation_id (guard_message_update) and conversations.whatsapp_account_id
      -- (guard_conversation) are immutable once set.
      select c.whatsapp_account_id into v_owner
      from public.messages m join public.conversations c on c.id = m.conversation_id where m.wa_message_id = p_wa_message_id;
      if not found then return false; end if;      -- nobody holds it (candidate changed concurrently): retry-safe, nothing applied
      if v_owner is distinct from v_acc.id then raise exception 'kapso.message_account_mismatch' using errcode = '42501'; end if;
      return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
    end if;
    if coalesce(array_length(v_cands, 1), 0) > 1 then return false; end if;
    if not p_is_retry then return false; end if;
  end if;

  select * into r from app.kapso_resolve_conversation(v_acc, p_to_wa_id, p_to_bsuid, null);
  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status, sent_by, sent_at,
                               is_simulated, provider_origin)
  values (r.o_conversation_id, 'outbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096), p_media,
          'sent', null, coalesce(p_sent_at, now()), v_acc.is_simulated, v_org)
  on conflict (wa_message_id) do nothing;
  -- Same class of race as in ingest_kapso_inbound: apply_whatsapp_status looks only at the wamid, so before applying a
  -- status make sure the row that now carries this wamid belongs to THIS account (a concurrent delivery for another
  -- account may have inserted it first).
  if not exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                 where m.wa_message_id = p_wa_message_id and c.whatsapp_account_id = v_acc.id) then
    raise exception 'kapso.message_account_mismatch' using errcode = '42501';
  end if;
  return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
end $$;

-- Optional telemetry, called by the server AFTER a delivery was processed, in its OWN transaction (never from a function that
-- holds the account share lock). A plain single-row UPDATE: it waits only for in-flight shares of that one account and holds
-- nothing else, so it cannot be part of a wait cycle. The guard sees no change of company/environment/provider.
create or replace function public.touch_kapso_account(p_phone_number_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  update public.whatsapp_accounts set last_inbound_event_at = now(), connection_state = 'connected', connection_state_at = now()
  where phone_number_id = p_phone_number_id and provider = 'kapso'
    and (last_inbound_event_at is null or last_inbound_event_at < now() - interval '1 minute');
end $$;

-- ------------------------------------------------- 9. ambiguous outbound handling
-- Called by the server when a Kapso request ended without a definite answer (timeout, network error, 5xx, 2xx without id).
-- The message stays 'queued' and is NEVER resent automatically.
create or replace function public.record_outbound_unconfirmed(p_message_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  update public.messages set error_code = 'send.unconfirmed', error_message = null
  where id = p_message_id and direction = 'outbound' and status = 'queued' and wa_message_id is null;
end $$;

-- An unconfirmed message nobody confirmed within p_minutes becomes 'failed' so a human can decide to resend.
create or replace function public.expire_unconfirmed_outbound(p_minutes integer default 15) returns integer
language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  update public.messages set status = 'failed', error_code = 'send.unconfirmed_expired', status_updated_at = now()
  where direction = 'outbound' and status = 'queued' and wa_message_id is null and error_code = 'send.unconfirmed'
    and created_at < now() - make_interval(mins => greatest(p_minutes, 1));
  get diagnostics v = row_count;
  return v;
end $$;

-- ------------------------------------------------ 9b. retries (replaced: live/0960 body + 3 branches + expiry)
CREATE OR REPLACE FUNCTION public.process_webhook_retries(p_limit integer DEFAULT 100, p_max_attempts integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e record;
  p jsonb;
  v_ok boolean;
  v_processed int := 0;
  v_failed int := 0;
  v_ignored int := 0;
  v_expired int := 0;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  for e in
    select w.event_key, w.payload from public.whatsapp_webhook_events w
    where w.status = 'failed' and w.attempts < p_max_attempts
      and coalesce(w.payload ->> 'kind', '') <> 'kapso_quarantined'   -- quarantined events are never retry work: not selected, not counted, not touched
    order by w.received_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    p := e.payload;
    update public.whatsapp_webhook_events set attempts = attempts + 1 where event_key = e.event_key;
    begin
      case p ->> 'kind'
        when 'message' then
          perform public.ingest_whatsapp_message(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId',
            p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'echo' then
          perform public.ingest_whatsapp_echo(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'toWaId',
            p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'status' then
          v_ok := public.apply_whatsapp_status(p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode', p ->> 'errorMessage');
        when 'kapso_message' then
          perform public.ingest_kapso_message(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId',
            p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'kapso_status' then
          v_ok := public.apply_kapso_status(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode',
            p ->> 'errorMessage', p ->> 'toWaId', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb),
            (p ->> 'sentAt')::timestamptz);
        when 'kapso_inbound_v2' then
          perform public.ingest_kapso_inbound(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId', p ->> 'fromBsuid',
            p ->> 'origin', p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb),
            (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'kapso_status_v2' then
          v_ok := public.apply_kapso_status_v2(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode',
            p ->> 'errorMessage', p ->> 'toWaId', p ->> 'toBsuid', p ->> 'origin', p ->> 'messageType', p ->> 'body',
            nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz, true);
        when 'kapso_quarantined' then
          continue;   -- unreachable: excluded by the query above. Kept so that, if the exclusion is ever removed, the payload is NOT wiped by the ELSE branch
        else
          perform public.finish_webhook_event(e.event_key, 'ignored');
          v_ignored := v_ignored + 1;
          continue;
      end case;
      if v_ok then
        perform public.finish_webhook_event(e.event_key, 'processed');
        v_processed := v_processed + 1;
      else
        perform public.finish_webhook_event(e.event_key, 'failed', 'status.message_not_found');
        v_failed := v_failed + 1;
      end if;
    exception when others then
      perform public.finish_webhook_event(e.event_key, 'failed', app.safe_error(sqlerrm));
      v_failed := v_failed + 1;
    end;
  end loop;
  begin   -- the expiry must never undo the retries done above (the whole function is one transaction)
    v_expired := public.expire_unconfirmed_outbound();
  exception when others then
    v_expired := -1;
  end;
  return jsonb_build_object('processed', v_processed, 'failed', v_failed, 'ignored', v_ignored, 'unconfirmed_expired', v_expired);
end $function$;

-- ------------------------------------------------------------------ 10. grants
revoke all on function app.is_kapso_production_account(uuid) from public, anon;
grant execute on function app.is_kapso_production_account(uuid) to authenticated, service_role;   -- called from the invoker conversation guard
revoke all on function app.kapso_resolve_account(text) from public, anon, authenticated;
revoke all on function app.kapso_resolve_conversation(public.whatsapp_accounts, text, text, text) from public, anon, authenticated;
revoke all on function app.derive_account_environment(), app.block_kapso_unready_send(), app.lock_account_for_conversation() from public, anon, authenticated;
revoke all on function
  public.ingest_kapso_inbound(text, text, text, text, text, text, text, text, jsonb, timestamptz),
  public.apply_kapso_status_v2(text, text, text, text, text, text, text, text, text, text, jsonb, timestamptz, boolean),
  public.record_outbound_unconfirmed(uuid),
  public.expire_unconfirmed_outbound(integer),
  public.touch_kapso_account(text)
from public, anon, authenticated;
grant execute on function
  public.ingest_kapso_inbound(text, text, text, text, text, text, text, text, jsonb, timestamptz),
  public.apply_kapso_status_v2(text, text, text, text, text, text, text, text, text, text, jsonb, timestamptz, boolean),
  public.record_outbound_unconfirmed(uuid),
  public.expire_unconfirmed_outbound(integer),
  public.touch_kapso_account(text)
to service_role;
