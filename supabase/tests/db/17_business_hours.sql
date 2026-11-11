-- Business hours and business-hours response times (0930). Alpha is
-- Asia/Qatar (UTC+3, no DST). Expected values are worked out by hand.
begin;

select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 07:00+03', '2026-10-18 09:00+03'), null::bigint,
  'no hours configured: business time is NULL (not configured), never 0');

-- ------------------------------------------------------------ permissions
select tests.login('agent_a1');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'), '[]')$q$, 'auth.forbidden', 'agents cannot set business hours');
select tests.login('admin_b');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'), '[]')$q$, 'auth.forbidden', 'another company''s admin cannot');
select tests.throws($q$insert into public.company_business_hours (company_id, weekday, opens, closes) values (tests.ref('alpha'), 1, '08:00', '09:00')$q$,
  'row-level security', 'nor through the table directly');

-- Sun–Thu, split shift 08:00–12:00 and 16:00–20:00.
select tests.login('admin_a');
select tests.lives($q$select public.set_business_hours(tests.ref('alpha'), (
  select jsonb_agg(x) from (
    select jsonb_build_object('weekday', d, 'opens', '08:00', 'closes', '12:00') x from generate_series(0, 4) d
    union all
    select jsonb_build_object('weekday', d, 'opens', '16:00', 'closes', '20:00') from generate_series(0, 4) d) s))$q$,
  'the company admin sets a split-shift week');
select tests.eq(tests.count($q$select * from public.company_business_hours where company_id = tests.ref('alpha')$q$), 10::bigint, '10 intervals stored');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'),
  '[{"weekday": 1, "opens": "08:00", "closes": "12:00"}, {"weekday": 1, "opens": "11:00", "closes": "13:00"}]')$q$,
  'business_hours.overlap', 'overlapping intervals on the same day are refused');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'), '[{"weekday": 1, "opens": "18:00", "closes": "09:00"}]')$q$,
  'business_hours.invalid', 'an interval must close after it opens');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'), '[{"weekday": 9, "opens": "08:00", "closes": "09:00"}]')$q$,
  'business_hours.invalid', 'weekday must be 0–6');
select tests.throws($q$select public.set_business_hours(tests.ref('alpha'), '[{"weekday": 1, "opens": "8am", "closes": "nine"}]')$q$,
  'business_hours.invalid', 'times must be valid');
select tests.eq(tests.count($q$select * from public.company_business_hours where company_id = tests.ref('alpha')$q$), 10::bigint,
  'a refused update leaves the previous schedule intact');

select tests.login('agent_a1');
select tests.eq(tests.count('select * from public.company_business_hours'), 10::bigint, 'members read their company''s hours');
select tests.login('agent_b');
select tests.eq(tests.count('select * from public.company_business_hours'), 0::bigint, 'other companies do not');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 07:00+03', '2026-10-18 09:00+03'), null::bigint,
  'the helper runs with the caller''s rights: another company learns nothing about Alpha''s hours');
select tests.logout();

-- ------------------------------------------------------------ exact values
-- 2026-10-18 is a Sunday; 2026-10-23/24 are Friday/Saturday (closed).
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 07:00+03', '2026-10-18 09:00+03'), 3600::bigint,
  'before opening counts nothing: 08:00–09:00 = 1 h');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 11:30+03', '2026-10-18 16:30+03'), 3600::bigint,
  'the midday break is excluded: 30 min + 30 min');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-22 19:50+03', '2026-10-25 08:10+03'), 1200::bigint,
  'Thursday evening to Sunday morning: 10 min + weekend closed + 10 min');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-23 10:00+03', '2026-10-24 10:00+03'), 0::bigint,
  'entirely inside closed days: 0');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 10:00+03', '2026-10-18 09:00+03'), 0::bigint,
  'an inverted range is 0');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-18 05:00Z', '2026-10-18 06:00Z'), 3600::bigint,
  'instants are interpreted in the company timezone (05:00Z = 08:00 Doha)');

select tests.login('admin_a');
insert into public.company_holidays (company_id, day, name) values (tests.ref('alpha'), '2026-10-25', 'Holiday');
select tests.eq(app.business_seconds(tests.ref('alpha'), '2026-10-22 19:50+03', '2026-10-26 08:10+03'), 1200::bigint,
  'a holiday closes the whole day: 10 min Thu + Sunday off + 10 min Mon');
select tests.login('agent_a1');
select tests.throws($q$insert into public.company_holidays (company_id, day, name) values (tests.ref('alpha'), '2026-12-18', 'National Day')$q$,
  'row-level security', 'agents cannot add holidays');

-- DST: a London company's 09:00–17:00 is 08:00–16:00Z in summer and 09:00–17:00Z in winter.
select tests.logout();
update public.companies set timezone = 'Europe/London' where id = tests.ref('gamma');
insert into public.company_business_hours (company_id, weekday, opens, closes) values (tests.ref('gamma'), 1, '09:00', '17:00');
select tests.eq(app.business_seconds(tests.ref('gamma'), '2026-07-06 08:00Z', '2026-07-06 09:00Z'), 3600::bigint, 'summer (BST) window');
select tests.eq(app.business_seconds(tests.ref('gamma'), '2026-11-02 08:00Z', '2026-11-02 09:00Z'), 0::bigint, 'winter (GMT) window');

-- ------------------------------------------------------------ report columns
-- Asked Sunday 11:50, answered 16:05 (Doha): 4 h 15 min elapsed, 15 min business.
-- Asked Monday 09:00, answered 09:20: 20 min elapsed and business.
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'bh1', '97455558888', 'Hours', 'text', 'q1', null, '2026-10-18 11:50+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'delivered', 'a1', tests.uid('agent_a1'), '2026-10-18 16:05+03', 'bho1' from public.conversations where customer_wa_id = '97455558888';
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'bh2', '97455558888', 'Hours', 'text', 'q2', null, '2026-10-19 09:00+03');
select tests.logout();
insert into public.messages (conversation_id, direction, status, body, sent_by, sent_at, wa_message_id)
select id, 'outbound', 'delivered', 'a2', tests.uid('agent_a1'), '2026-10-19 09:20+03', 'bho2' from public.conversations where customer_wa_id = '97455558888';

select tests.login('admin_a');
create temp table br as select * from public.report_whatsapp_response(tests.ref('alpha'), '2026-10-18', '2026-10-19')
  where user_id = tests.uid('agent_a1');
select tests.eq((select turns_answered from br), 2::bigint, 'two answered turns');
select tests.eq((select avg_response_seconds from br), 8250::numeric, 'elapsed average: (15300 + 1200) / 2');
select tests.eq((select avg_business_seconds from br), 1050::numeric, 'business-hours average: (900 + 1200) / 2');
select tests.eq((select median_business_seconds from br), 1050::numeric, 'business-hours median');
select tests.eq((select answered_within_15m from br), 0.0000::numeric, 'neither reply was within 15 elapsed minutes');
select tests.eq((select business_within_15m from br), 0.5000::numeric, 'one of two within 15 business minutes');

-- Without configured hours the business columns are NULL, not zero.
select tests.logout();
delete from public.company_business_hours where company_id = tests.ref('alpha');
select tests.login('admin_a');
select tests.eq((select avg_business_seconds from public.report_whatsapp_response(tests.ref('alpha'), '2026-10-18', '2026-10-19')
  where user_id = tests.uid('agent_a1')), null::numeric, 'no hours configured: business average is NULL');

rollback;
