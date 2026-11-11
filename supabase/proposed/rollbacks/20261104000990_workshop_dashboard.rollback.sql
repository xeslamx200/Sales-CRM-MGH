-- ROLLBACK of 20261104000990 (two read-only report functions; no data is involved). Run with psql -1.
drop function public.report_workshop_daily(uuid, date, date, uuid);
drop function public.report_workshop_breakdown(uuid, date, date, uuid);
drop function public.report_workshop_kpis(uuid, date, date, uuid);
