-- =============================================================================================================================
-- PROPOSED (separate patch ON TOP OF the Rev6 migration 20261104000970; not applied automatically).
-- Defect found by the post-Rev6 scratch concurrency run (T-LOCK-12A, repeatable): app.kapso_resolve_conversation read the conversation
-- BEFORE taking the contact lock. When merge_contacts finished while the webhook waited for that lock, the conversation had already moved to
-- the surviving contact, but the webhook still used the stale (merged-away) contact: it attached the BSUID identity to the MERGED contact
-- (116-121 anomalous identities per 300-pair run) and, holding the old contact's lock while touching the new one through foreign keys, it
-- could deadlock with a second merge (observed: 40P01 in merge_contacts).
-- Fix: take the lock on the conversation's CURRENT contact and re-read after the lock (new helper app.kapso_lock_conversation_contact);
-- the new-customer branch locks the live (non-merged) contact before it links or stores anything. Same lock order as before (contact ->
-- conversation); no new lock kind. Only this one function is replaced (+ one new helper). Rollback restores the Rev6 body.
-- =============================================================================================================================
-- Returns the contact a conversation belongs to RIGHT NOW, locked FOR NO KEY UPDATE (the same order merge_contacts uses: contact before
-- conversation). merge_contacts moves conversations to the surviving contact; a caller that read the conversation before waiting for the
-- contact lock would otherwise keep working with the merged-away contact. Re-reads after every lock (fresh READ COMMITTED snapshot).
create or replace function app.kapso_lock_conversation_contact(p_conversation_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_ct uuid; v_now uuid; i int;
begin
  select c.contact_id into v_ct from public.conversations c where c.id = p_conversation_id;
  for i in 1..5 loop
    perform 1 from public.contacts k where k.id = v_ct for no key update;
    select c.contact_id into v_now from public.conversations c where c.id = p_conversation_id;
    if v_now = v_ct then return v_ct; end if;
    v_ct := v_now;
  end loop;
  raise exception 'kapso.identity_conflict' using errcode = '40001';   -- the retry job tries again; nothing was guessed
end $$;
revoke all on function app.kapso_lock_conversation_contact(uuid) from public, anon, authenticated;

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
  v_next uuid;
  i int;
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
    v_conv := cp.id;
    -- lock order contact -> conversation (merge_contacts locks contacts first, then updates conversations). The contact is the CURRENT one:
    -- cp was read before the lock, and a merge that finished while we waited moved the conversation to another contact.
    v_contact := app.kapso_lock_conversation_contact(cp.id);
    if p_bsuid is not null and cb.id is null and cp.customer_bsuid is null
       and not exists (select 1 from public.contact_identities i
                       where i.whatsapp_account_id = p_acc.id and i.kind = 'bsuid' and i.value = p_bsuid) then
      update public.conversations set customer_bsuid = p_bsuid where id = cp.id;
      insert into public.contact_identities (contact_id, whatsapp_account_id, kind, value)
      values (v_contact, p_acc.id, 'bsuid', p_bsuid);
    elsif cb.id is not null and cb.id <> cp.id then
      -- two conversations for one customer: keep the phone one, change nothing, leave a trace for a human
      perform app.write_audit(p_acc.default_company_id, 'conversation.identity_conflict', 'conversation', cp.id,
                              jsonb_build_object('other_conversation_id', cb.id));
    end if;
  elsif cb.id is not null then
    v_conv := cb.id;
    v_contact := app.kapso_lock_conversation_contact(cb.id);   -- the CURRENT contact, locked (see above)
    if p_wa_id is not null and cb.customer_wa_id is null then
      select k.id into v_holder from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null;
      if v_holder is null or v_holder = v_contact then
        update public.conversations set customer_wa_id = p_wa_id where id = cb.id;     -- allowed by the revised guard (NULL -> value)
        update public.contacts set phone_e164 = v_phone where id = v_contact and phone_e164 is null;
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
    -- a contact found by phone/identity may have been merged away since the lookup: lock the live one before anything refers to it
    for i in 1..5 loop
      exit when v_contact is null;
      select k.merged_into_id into v_next from public.contacts k where k.id = v_contact for no key update;
      exit when v_next is null;
      v_contact := v_next;
    end loop;
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
