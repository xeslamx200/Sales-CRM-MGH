-- ROLLBACK of 20261104000988. Refuses while any shift exists (it is the owner's configuration of who works when). Run with psql -1.
do $$ begin
  if exists (select 1 from public.employee_shifts) then raise exception 'rollback refused: employee shifts exist (delete them on purpose first; clearing only closes a shift)'; end if;
end $$;
drop function public.report_shift_activity(uuid, date, date, uuid);
drop function app.in_shift(uuid, uuid, timestamptz);
drop function app.shift_starting_on(uuid, uuid, date);
drop function public.clear_employee_shift(uuid, uuid, date);
drop function public.set_employee_shift(uuid, uuid, time, time, smallint[], date);
drop table public.employee_shifts;
