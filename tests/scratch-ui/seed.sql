-- SCRATCH-ONLY seed for the frontend tests. Runs on a copy of the fixture database (27 + 970..986 + tests/_helpers + _fixtures). Never on Staging.
select public.upsert_fx_rates('{"QAR": 14.1, "SAR": 13.2}'::jsonb, 'scratch-ui');
do $$
declare w uuid; w2 uuid; wb uuid; g uuid; c uuid; i int;
begin
  perform tests.create_user('adm2', 'Second Admin');
  insert into public.company_memberships (company_id, user_id, role) values (tests.ref('alpha'), tests.uid('adm2'), 'company_admin');

  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'كلود للأعمال / Claude for Business', 'workshop') returning id into w;
  insert into tests.refs values ('ui_w', w);
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 1000), (tests.ref('alpha'), w, 'QA', 'offline', 'QAR', 1500),
    (tests.ref('alpha'), w, 'SA', 'online', 'SAR', 800), (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 2500);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance) values
    (tests.ref('alpha'), w, 'Group 1', array[date '2027-12-06', date '2027-12-07', date '2027-12-08'], date '2027-12-06', date '2027-12-08', 2, null) returning id into g;
  insert into tests.refs values ('ui_g1', g);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, attendance) values
    (tests.ref('alpha'), w, 'Group 2', array[date '2027-12-13', date '2027-12-14', date '2027-12-15'], date '2027-12-13', date '2027-12-15', null, null) returning id into g;
  insert into tests.refs values ('ui_g2', g);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity, is_active) values
    (tests.ref('alpha'), w, 'Group 0 (closed)', array[date '2027-11-01'], date '2027-11-01', date '2027-11-01', null, false);

  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'AI for Kids (no price yet)', 'workshop') returning id into w2;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values (tests.ref('alpha'), w2, 'Kids G1', array[date '2027-12-20'], date '2027-12-20', date '2027-12-20');
  insert into tests.refs values ('ui_w2', w2);

  for i in 1..16 loop
    insert into public.contacts (full_name, phone_e164) values ((case when i = 1 then 'أحمد علي' else 'Customer ' || i end), '+2010222' || lpad(i::text, 5, '0')) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'),
      case when i <= 10 then tests.uid('agent_a1') when i <= 13 then tests.uid('mgr_a') else tests.uid('admin_a') end);
    insert into tests.refs values ('ui_c' || i, c);
  end loop;

  insert into public.company_offerings (company_id, name, kind) values (tests.ref('beta'), 'Beta workshop', 'workshop') returning id into wb;
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values (tests.ref('beta'), wb, 'QA', 'online', 'QAR', 100);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values (tests.ref('beta'), wb, 'Beta G1', array[date '2027-12-06'], date '2027-12-06', date '2027-12-06');
  insert into tests.refs values ('ui_wb', wb);
  insert into public.contacts (full_name, phone_e164) values ('Beta customer', '+2010999000001') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('beta'), tests.uid('agent_b'));
end $$;
select 'seeded' as status, (select count(*) from public.profiles) as profiles, (select string_agg(email, ',' order by email) from public.profiles where email like '%@test.local' limit 20) as emails;
