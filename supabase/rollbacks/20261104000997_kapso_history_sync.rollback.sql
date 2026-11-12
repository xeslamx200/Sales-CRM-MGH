-- ROLLBACK of 20261104000997. Drops the history sync function; messages it stored are ordinary messages and stay. Run with psql -1.
drop function public.kapso_import_history(text, jsonb);
