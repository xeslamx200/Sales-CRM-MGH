-- Rollback of 20261104000976_update_whatsapp_account.sql. The admin action falls back to the plain table update when the function is absent.
drop function if exists public.update_whatsapp_account(uuid, uuid, text, text, text, text, public.wa_account_status);
