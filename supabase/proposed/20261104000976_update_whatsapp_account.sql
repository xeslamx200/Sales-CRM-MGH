-- =============================================================================================================================
-- PROPOSED (not applied automatically): bounded wait for the admin edit of a WhatsApp account.
--
-- Why: with the Rev6 lock protocol every Kapso webhook holds FOR SHARE on its account row until it commits, and PostgreSQL lets new
-- compatible SHARE lockers overtake a waiting writer. Measured on the scratch DB (RESULTS.md F5): 16 overlapping webhook transactions kept an
-- admin UPDATE of the same account waiting 10.15 s. The admin screen must give up with a clear, retryable message instead of hanging.
--
-- How: ONE function that performs exactly the UPDATE the admin action performed, with a FUNCTION-LEVEL `SET lock_timeout = '5s'`.
-- The setting exists only while this function runs (PostgreSQL restores the previous value on exit), so it is not global, it does not
-- affect webhook transactions, and it applies to this one statement only. SECURITY INVOKER: RLS (wa_accounts_write = super admin) and
-- every trigger/guard apply unchanged, so the account-mapping and locking invariants are preserved. No automatic retry anywhere.
-- Timeout choice: 5 s is longer than a webhook batch or a 100-event retry run normally holds a share lock (milliseconds to ~2 s) and
-- shorter than common serverless request limits (10 s), so the user sees a result or a clear "busy" answer within one request.
-- =============================================================================================================================
create or replace function public.update_whatsapp_account(
  p_id uuid, p_default_company_id uuid, p_display_name text, p_phone_e164 text,
  p_phone_number_id text, p_waba_id text, p_status public.wa_account_status
) returns void
language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
begin
  update public.whatsapp_accounts set
    default_company_id = p_default_company_id, display_name = p_display_name, phone_e164 = p_phone_e164,
    phone_number_id = p_phone_number_id, waba_id = p_waba_id, status = p_status
  where id = p_id;
  if not found then
    raise exception 'auth.forbidden' using errcode = '42501';   -- same meaning as .single() finding no visible row
  end if;
exception when lock_not_available then
  raise exception 'whatsapp.account_busy' using errcode = '55P03';   -- retryable; stable key mapped to a localized message by the app
end $$;
revoke all on function public.update_whatsapp_account(uuid, uuid, text, text, text, text, public.wa_account_status) from public, anon;
grant execute on function public.update_whatsapp_account(uuid, uuid, text, text, text, text, public.wa_account_status) to authenticated, service_role;
