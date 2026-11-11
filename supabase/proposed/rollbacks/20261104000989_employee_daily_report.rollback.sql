-- ROLLBACK of 20261104000989. Refuses while any presence row exists (it is the record of when people used the CRM). Run with psql -1.
do $$ begin
  if exists (select 1 from public.user_presence_days) then raise exception 'rollback refused: presence rows exist (delete them on purpose first)'; end if;
end $$;
drop function public.report_employee_day(uuid, date, date, uuid);
drop function public.touch_presence(uuid);
drop table public.user_presence_days;
