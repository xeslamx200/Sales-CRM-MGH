-- Migration 1004: the dashboard "new leads" tile (report_workshop_kpis) counts the same leads as the daily chart (report_leads_per_day),
-- including automatic WhatsApp leads that have no creator, for a sales manager and for an agent.
begin;
select tests.logout();
insert into public.contacts (full_name, phone_e164) values ('Auto Lead A', '+97499000001'), ('Auto Lead B', '+97499000002');
insert into public.contact_companies (contact_id, company_id) select id, tests.ref('alpha') from public.contacts where phone_e164 in ('+97499000001', '+97499000002');
-- two automatic leads: no creator, no owner (as the WhatsApp pipeline creates them)
insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id)
select tests.ref('wa_alpha'), tests.ref('alpha'), id, right(phone_e164, 11) from public.contacts where phone_e164 in ('+97499000001', '+97499000002');
insert into public.leads (company_id, contact_id, title, auto_created, created_by, owner_id, conversation_id, source)
select tests.ref('alpha'), c.id, 'Auto ' || c.full_name, true, null, null, v.id, 'whatsapp'
from public.contacts c join public.conversations v on v.contact_id = c.id where c.phone_e164 in ('+97499000001', '+97499000002');
-- a lead owned by an agent
insert into public.leads (company_id, contact_id, title, owner_id, created_by)
select tests.ref('alpha'), id, 'Owned by agent', tests.uid('agent_a1'), tests.uid('agent_a1') from public.contacts where phone_e164 = '+97499000001';

select tests.login('mgr_a');
select tests.eq((select leads_created from public.report_workshop_kpis(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date) where currency is null),
  (select coalesce(sum(total), 0)::bigint from public.report_leads_per_day(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date)),
  'manager: the tile and the chart count the same leads');
select tests.ok((select leads_created from public.report_workshop_kpis(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date) where currency is null) >= 2,
  'manager: automatic leads (no creator) are counted');
select tests.login('agent_a1');
select tests.eq((select leads_created from public.report_workshop_kpis(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date) where currency is null),
  (select coalesce(sum(total), 0)::bigint from public.report_leads_per_day(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date)),
  'agent: the tile and the chart count the same leads');
select tests.login('admin_a');
select tests.eq((select leads_created from public.report_workshop_kpis(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date) where currency is null),
  (select coalesce(sum(total), 0)::bigint from public.report_leads_per_day(tests.ref('alpha'), (now() - interval '2 days')::date, (now() + interval '2 days')::date)),
  'company admin: the tile and the chart count the same leads');
select tests.logout();
rollback;
