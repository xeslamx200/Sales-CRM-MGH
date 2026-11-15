-- 20261104001010 - Click-to-WhatsApp ads: remember which ad a customer's first message came from.
--
-- Meta attaches a "referral" (ad id, ad link, headline, text, media type) to a message that starts from a Facebook / Instagram ad. Kapso passes
-- it on in the webhook "when present". The inbound ingest function is NOT changed: after it has stored the message the app calls
-- public.record_message_referral, a separate service-role-only function, and a failure there never affects the message itself.
--  * public.message_referrals: one row per message (message_id is the key), readable by whoever can see the conversation (same rule as messages).
--  * public.record_message_referral(phone_number_id, wamid, referral): finds the message through the account (the caller never names a company or
--    conversation), keeps only known fields, clips every text, accepts only http(s) links, and is idempotent (the first stored value stays).
-- Rollback: supabase/rollbacks/20261104001010_message_referrals.rollback.sql

create table public.message_referrals (
  message_id uuid primary key references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  source_type text check (source_type is null or length(source_type) <= 40),
  source_id text check (source_id is null or length(source_id) <= 200),
  source_url text check (source_url is null or (length(source_url) <= 2000 and source_url ~ '^https?://')),
  headline text check (headline is null or length(headline) <= 500),
  body text check (body is null or length(body) <= 2000),
  media_type text check (media_type is null or length(media_type) <= 40),
  ctwa_clid text check (ctwa_clid is null or length(ctwa_clid) <= 500),
  created_at timestamptz not null default now()
);
create index message_referrals_conversation_idx on public.message_referrals (conversation_id);
alter table public.message_referrals enable row level security;
create policy message_referrals_select on public.message_referrals for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = message_referrals.conversation_id)
);
revoke all on public.message_referrals from public, anon, authenticated;
grant select on public.message_referrals to authenticated;
grant all on public.message_referrals to service_role;

create or replace function public.record_message_referral(p_phone_number_id text, p_wa_message_id text, p_referral jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_acc public.whatsapp_accounts; v_msg uuid; v_conv uuid; v_n int;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_referral is null or jsonb_typeof(p_referral) <> 'object' then return false; end if;
  v_acc := app.kapso_resolve_account(p_phone_number_id);
  select m.id, m.conversation_id into v_msg, v_conv
  from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.wa_message_id = p_wa_message_id and c.whatsapp_account_id = v_acc.id and m.direction = 'inbound';
  if v_msg is null then return false; end if;
  insert into public.message_referrals (message_id, conversation_id, source_type, source_id, source_url, headline, body, media_type, ctwa_clid)
  values (v_msg, v_conv,
    left(nullif(p_referral ->> 'source_type', ''), 40),
    left(nullif(p_referral ->> 'source_id', ''), 200),
    case when p_referral ->> 'source_url' ~ '^https?://' then left(p_referral ->> 'source_url', 2000) end,
    left(nullif(p_referral ->> 'headline', ''), 500),
    left(nullif(p_referral ->> 'body', ''), 2000),
    left(nullif(p_referral ->> 'media_type', ''), 40),
    left(nullif(p_referral ->> 'ctwa_clid', ''), 500))
  on conflict (message_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.record_message_referral(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_message_referral(text, text, jsonb) to service_role;
