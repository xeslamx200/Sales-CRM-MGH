-- ROLLBACK of 20261104001010: forgets which ad each message came from. Run with psql -1.
drop function public.record_message_referral(text, text, jsonb);
drop table public.message_referrals;
