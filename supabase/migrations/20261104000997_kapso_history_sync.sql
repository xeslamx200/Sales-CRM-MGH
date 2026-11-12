-- 20261104000997 - Kapso history sync: store the messages of a Kapso number that the CRM does not have yet (missed while the webhook was
-- unreachable, or older history), from the super admin's "Check and complete messages" button.
--
-- public.kapso_import_history(phone_number_id, rows): SERVICE ROLE ONLY (the app calls it after checking that the caller is a super admin).
--  * The account and its company come from the phone_number_id (app.kapso_resolve_account), never from the caller.
--  * Each row is one Kapso message: { id (wamid), d ('i' inbound / 'o' outbound), ts (unix seconds), ph (customer phone digits) or bs (BSUID),
--    nm (contact name), ty (type), b (text), st (status) }. Rows without a phone and without a BSUID are refused by the resolver and counted.
--  * A message that already exists (same wamid) is never touched: running the sync again is safe and changes nothing.
--  * The conversation is found or created exactly like an inbound webhook (app.kapso_resolve_conversation), so the contact / company rules
--    and the identity checks are the same. Like the history import of 12 Nov, it creates no lead and no notification by itself, and it does
--    NOT change what staff see as unread: every conversation it touches keeps its unread counter (a new one starts read). The conversation
--    still moves to its latest message time, so it appears in the right place in the inbox.
--  * Up to 5,000 rows per call. Returns {"inserted": n, "duplicate": n, "failed": n, "failed_codes": {code: n}}.
-- Rollback: supabase/rollbacks/20261104000997_kapso_history_sync.rollback.sql (drops the function; messages it stored are ordinary messages).

create or replace function public.kapso_import_history(p_phone_number_id text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts; r record; c record; v_ins int;
  v_inserted int := 0; v_duplicate int := 0; v_failed int := 0; v_codes jsonb := '{}'::jsonb;
  v_unread jsonb := '{}'::jsonb;   -- conversation id -> unread counter before this call
  v_code text; k text;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'kapso.invalid_history_rows' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'kapso.history_batch_too_large' using errcode = '22023'; end if;
  v_acc := app.kapso_resolve_account(p_phone_number_id);
  if v_acc.environment <> 'production' then raise exception 'kapso.account_not_production' using errcode = '42501'; end if;

  for r in
    select * from jsonb_to_recordset(p_rows) as x(id text, d text, ts bigint, ph text, bs text, nm text, ty text, b text, st text)
    order by ts, id
  loop
    begin
      if r.id is null or r.id !~ '^[A-Za-z0-9._=+/-]{1,200}$' or r.d not in ('i', 'o') or r.ts is null then
        raise exception 'kapso.invalid_history_row' using errcode = '22023';
      end if;
      if exists (select 1 from public.messages m where m.wa_message_id = r.id) then
        v_duplicate := v_duplicate + 1;
        continue;
      end if;
      select * into c from app.kapso_resolve_conversation(v_acc, nullif(r.ph, ''), nullif(r.bs, ''), nullif(r.nm, ''));
      if not (v_unread ? c.o_conversation_id::text) then
        v_unread := v_unread || jsonb_build_object(c.o_conversation_id::text,
          coalesce((select cv.unread_count from public.conversations cv where cv.id = c.o_conversation_id), 0));
      end if;
      insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, status, sent_by, sent_at, is_simulated, provider_origin)
      values (c.o_conversation_id, case r.d when 'i' then 'inbound' else 'outbound' end::public.message_direction, r.id,
              left(coalesce(nullif(r.ty, ''), 'unknown'), 40), left(coalesce(nullif(r.b, ''), '[' || coalesce(r.ty, 'message') || ']'), 4096),
              (case when r.d = 'i' then 'received' when r.st in ('sent', 'delivered', 'read', 'failed') then r.st else 'sent' end)::public.message_status,
              null, to_timestamp(r.ts), v_acc.is_simulated, null)
      on conflict (wa_message_id) do nothing;
      get diagnostics v_ins = row_count;
      if v_ins = 1 then v_inserted := v_inserted + 1; else v_duplicate := v_duplicate + 1; end if;
    exception when others then
      v_failed := v_failed + 1;
      v_code := case when sqlerrm ~ '^[a-z_]+(\.[a-z_]+)+$' then sqlerrm else 'other' end;
      v_codes := jsonb_set(v_codes, array[v_code], to_jsonb(coalesce((v_codes ->> v_code)::int, 0) + 1));
    end;
  end loop;

  -- history must not change what staff see as unread
  for k in select jsonb_object_keys(v_unread) loop
    update public.conversations cv set unread_count = (v_unread ->> k)::int
    where cv.id = k::uuid and cv.unread_count <> (v_unread ->> k)::int;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'duplicate', v_duplicate, 'failed', v_failed, 'failed_codes', v_codes);
end $$;

revoke all on function public.kapso_import_history(text, jsonb) from public, anon, authenticated;
grant execute on function public.kapso_import_history(text, jsonb) to service_role;
