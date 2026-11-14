-- ROLLBACK of 20261104001005: removes public.report_response_log. Run with psql -1.
drop function public.report_response_log(uuid, date, date);
