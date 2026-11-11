-- ROLLBACK of 20261104000982: drops the three read-only report functions. No data is touched. Run with psql -1.
drop function if exists public.report_waiting_now(uuid);
drop function if exists public.report_response_speed(uuid, date, date);
drop function if exists public.report_leads_per_day(uuid, date, date);
