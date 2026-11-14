-- 20261104001007 - report_response_log also says WHICH CRM employees replied in each turn, and the report shows who is responsible for the customer.
--
-- A reply typed in the WhatsApp phone app reaches the CRM as an echo with NO sender (the app is shared and Meta does not say who typed it), so
-- "answered from the phone" can never name a person. What the CRM does know: the employees who replied from the CRM in the same conversation
-- (crm_repliers: every one, from the customer's message until the customer's next turn, in the order they first replied) and the employee the
-- conversation is assigned to (owner_name, already returned by 1005, now shown). Same turn, answer and visibility rules as 1005.
-- The return type changes, so the function is dropped and created again (same name, grants and security). Read-only; no table, column or index.
-- Rollback: supabase/rollbacks/20261104001007_report_response_log_repliers.rollback.sql (back to the 1005 version)

-- destructive-ok: recreated below with one more column (crm_repliers); nothing stored depends on it
drop function public.report_response_log(uuid, date, date);

create function public.report_response_log(p_company_id uuid, p_from date, p_to date)
returns table (conversation_id uuid, contact_name text, phone text, asked_at timestamptz, answered_at timestamptz,
               answered_by text, answered_by_name text, wait_seconds numeric, owner_name text, crm_repliers text)
language plpgsql stable security definer set search_path = '' as $$
declare t0 timestamptz; t1 timestamptz; v_scope record;
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'report.invalid_period' using errcode = '22023'; end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  if not found then return; end if;
  t0 := app.period_start(p_company_id, p_from);
  t1 := app.period_start(p_company_id, p_to + 1);
  return query
  with turns as (
    select m.conversation_id as cid, m.sent_at as asked
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    left join lateral (
      select p.direction from public.messages p
      where p.conversation_id = m.conversation_id and not p.is_simulated and p.status <> 'failed'
        and (p.sent_at, p.created_at, p.id) < (m.sent_at, m.created_at, m.id)
      order by p.sent_at desc, p.created_at desc, p.id desc limit 1
    ) pv on true
    where c.company_id = p_company_id and not c.is_simulated and not m.is_simulated and m.status <> 'failed'
      and m.direction = 'inbound' and m.sent_at >= t0 and m.sent_at < t1
      and pv.direction is distinct from 'inbound'
  ),
  visible as (
    select t.cid, t.asked, lead(t.asked) over (partition by t.cid order by t.asked) as next_asked
    from turns t where v_scope.see_all or app.can_access_conversation(t.cid)
  ),
  answered as (
    select v.cid, v.asked, v.next_asked, r.sent_at as ans_at, r.sent_by
    from visible v
    left join lateral (
      select o.sent_at, o.sent_by from public.messages o
      where o.conversation_id = v.cid and not o.is_simulated and o.status <> 'failed' and o.direction = 'outbound' and o.sent_at >= v.asked
      order by o.sent_at, o.created_at, o.id limit 1
    ) r on true
  )
  select a.cid, coalesce(nullif(btrim(ct.full_name), ''), nullif(ct.phone_e164, ''), c.customer_wa_id, c.customer_bsuid, '—'),
         coalesce(nullif(ct.phone_e164, ''), case when c.customer_wa_id is not null then '+' || c.customer_wa_id end),
         a.asked, a.ans_at,
         case when a.ans_at is null then null when a.sent_by is null then 'phone' else 'crm' end,
         case when a.sent_by is not null then app.user_display_name(a.sent_by) end,
         round(extract(epoch from coalesce(a.ans_at, now()) - a.asked), 0),
         app.user_display_name(c.owner_id),
         -- every CRM employee who replied in this turn (until the customer's next turn), in the order they first replied
         (select string_agg(q.nm, ', ' order by q.first_at)
            from (select app.user_display_name(o.sent_by) as nm, min(o.sent_at) as first_at
                  from public.messages o
                  where o.conversation_id = a.cid and o.direction = 'outbound' and o.sent_by is not null and not o.is_simulated and o.status <> 'failed'
                    and o.sent_at >= a.asked and (a.next_asked is null or o.sent_at < a.next_asked)
                  group by o.sent_by) q)
  from answered a
  join public.conversations c on c.id = a.cid
  left join public.contacts ct on ct.id = c.contact_id
  order by (a.ans_at is not null), a.asked desc
  limit 1000;
end $$;
revoke all on function public.report_response_log(uuid, date, date) from public, anon;
grant execute on function public.report_response_log(uuid, date, date) to authenticated, service_role;
