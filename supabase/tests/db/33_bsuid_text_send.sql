-- 20261104000993: an employee may send TEXT to a BSUID-only customer of a Kapso production account; everything else stays refused.
-- Run on a scratch database that has the chain through 992 (the 979 guard is the "before"). One transaction, rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table t_res (n int generated always as identity, what text, ok boolean);
create or replace function pg_temp.expect_fail(p_sql text, p_code text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_res (what, ok) values (p_what, false);
  exception when others then
    insert into t_res (what, ok) values (p_what, sqlerrm = p_code);
  end;
end $$;

-- fixtures: a real company, a Kapso production account (sending on), a BSUID-only conversation, a phone conversation
do $$
declare v_co uuid; v_acc uuid; v_user uuid; v_c1 uuid; v_c2 uuid; v_ct1 uuid; v_ct2 uuid;
begin
  select id into v_co from public.companies where not is_sandbox order by created_at limit 1;
  select id into v_user from public.profiles limit 1;
  insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, waba_id, provider, environment, connection_mode, status, outbound_enabled)
    values (v_co, 'T993', '+971500000993', '993000000000001', '993000000000002', 'kapso', 'production', 'coexistence', 'active', true) returning id into v_acc;
  insert into public.contacts (full_name) values ('T993 bsuid') returning id into v_ct1;
  insert into public.contacts (full_name) values ('T993 phone') returning id into v_ct2;
  alter table public.conversations disable trigger user;
  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, customer_bsuid) values (v_acc, v_co, v_ct1, null, 'QA.993000000000001') returning id into v_c1;
  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, customer_bsuid) values (v_acc, v_co, v_ct2, '971500000994', null) returning id into v_c2;
  alter table public.conversations enable trigger user;
  perform set_config('t993.acc', v_acc::text, true); perform set_config('t993.user', v_user::text, true);
  perform set_config('t993.bs', v_c1::text, true); perform set_config('t993.ph', v_c2::text, true);
end $$;

create or replace function pg_temp.msg(p_conv text, p_type text) returns text language plpgsql as $$
begin
  return format($f$insert into public.messages (conversation_id, direction, message_type, body, status, sent_by, is_simulated) values (%L, 'outbound', %L, 'hi', 'queued', %L, false)$f$,
    current_setting(p_conv), p_type, current_setting('t993.user'));
end $$;

-- 1. text to the BSUID customer is accepted
do $$ begin
  begin execute pg_temp.msg('t993.bs', 'text'); insert into t_res (what, ok) values ('text to a BSUID-only customer of a Kapso production account is accepted', true);
  exception when others then insert into t_res (what, ok) values ('text to a BSUID-only customer of a Kapso production account is accepted (' || sqlerrm || ')', false); end;
end $$;
-- 2. everything else to the BSUID customer stays refused
select pg_temp.expect_fail(pg_temp.msg('t993.bs', 'image'), 'whatsapp.recipient_phone_unknown', 'an image to a BSUID-only customer is refused');
select pg_temp.expect_fail(pg_temp.msg('t993.bs', 'document'), 'whatsapp.recipient_phone_unknown', 'a document to a BSUID-only customer is refused');
select pg_temp.expect_fail(pg_temp.msg('t993.bs', 'template'), 'whatsapp.recipient_phone_unknown', 'a template to a BSUID-only customer is refused');
-- 3. the other checks of the guard still apply to the BSUID customer
update public.whatsapp_accounts set outbound_enabled = false where id = current_setting('t993.acc')::uuid;
select pg_temp.expect_fail(pg_temp.msg('t993.bs', 'text'), 'whatsapp.outbound_disabled', 'sending switched off on the account still refuses a BSUID text');
update public.whatsapp_accounts set outbound_enabled = true where id = current_setting('t993.acc')::uuid;
-- 4. a phone customer is unaffected, and an echo (sent_by NULL) is still recorded
do $$ begin
  begin execute pg_temp.msg('t993.ph', 'text'); insert into t_res (what, ok) values ('text to a phone customer is accepted as before', true);
  exception when others then insert into t_res (what, ok) values ('text to a phone customer is accepted as before (' || sqlerrm || ')', false); end;
end $$;
-- 5. a conversation with neither identifier cannot exist (constraint), so no send path to "nobody"
select pg_temp.expect_fail($q$insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, customer_bsuid) select whatsapp_account_id, company_id, contact_id, null, null from public.conversations where id = current_setting('t993.bs')::uuid$q$,
  'new row for relation "conversations" violates check constraint "conversations_customer_identity_chk"', 'a conversation without any identity cannot exist');

select n, what, case when ok then 'PASS' else 'FAIL' end as result from t_res order by n;
select count(*) filter (where not ok) as failures, count(*) as checks from t_res;
rollback;
