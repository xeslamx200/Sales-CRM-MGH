-- Pipeline management (0900).
begin;

select tests.login('agent_a1');
select tests.throws($q$select public.create_pipeline(tests.ref('alpha'), 'Hijack', 'deal')$q$, 'row-level security',
  'agents cannot create pipelines');

select tests.login('admin_a');
insert into tests.refs select 'p_new', public.create_pipeline(tests.ref('alpha'), 'Projects', 'deal');
select tests.eq((select string_agg(stage_type::text, ',' order by position) from public.pipeline_stages where pipeline_id = tests.ref('p_new')),
  'open,won,lost', 'a new deal pipeline starts with open, won and lost stages');
select tests.throws($q$select public.create_pipeline(tests.ref('beta'), 'Other company', 'deal')$q$, 'row-level security',
  'cannot create pipelines in another company');

-- Stage editing.
select tests.lives($q$insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type, probability)
  values (tests.ref('p_new'), tests.ref('alpha'), 'Proposal', 3, 'open', 50)$q$, 'admin adds a stage');
select tests.lives($q$update public.pipeline_stages set name = 'Qualified', probability = 20
  where pipeline_id = tests.ref('p_new') and position = 0$q$, 'admin renames a stage');

-- Reorder: Proposal after "Qualified".
select tests.lives($q$select public.reorder_pipeline_stages(tests.ref('p_new'), array(
  select id from public.pipeline_stages where pipeline_id = tests.ref('p_new')
  order by case name when 'Qualified' then 0 when 'Proposal' then 1 when 'مكسوبة' then 2 else 3 end))$q$, 'admin reorders stages atomically');
select tests.eq((select string_agg(name, ',' order by position) from public.pipeline_stages where pipeline_id = tests.ref('p_new')),
  'Qualified,Proposal,مكسوبة,خاسرة', 'new order stored');
select tests.throws($q$select public.reorder_pipeline_stages(tests.ref('p_new'), array(
  select id from public.pipeline_stages where pipeline_id = tests.ref('p_new') limit 2))$q$, 'pipeline.invalid_order',
  'a partial order is refused');

-- Default switching keeps exactly one default.
select tests.lives($q$select public.set_default_pipeline(tests.ref('p_new'))$q$, 'admin switches the default deal pipeline');
select tests.eq((select count(*) from public.pipelines where company_id = tests.ref('alpha') and kind = 'deal' and is_default), 1::bigint,
  'still exactly one default');
select tests.ok((select is_default from public.pipelines where id = tests.ref('p_new')), 'the chosen pipeline is the default');

-- 0910: the default stays usable whichever path writes.
select tests.throws($q$update public.pipeline_stages set is_active = false where pipeline_id = tests.ref('p_new') and stage_type = 'lost'$q$,
  'pipeline.incomplete', 'cannot deactivate the last lost stage of the default deal pipeline');
select tests.throws($q$delete from public.pipeline_stages where pipeline_id = tests.ref('p_new') and stage_type = 'won'$q$,
  'pipeline.incomplete', 'cannot delete the last won stage of the default deal pipeline');
select tests.throws($q$update public.pipeline_stages set stage_type = 'open' where pipeline_id = tests.ref('p_new') and stage_type = 'won'$q$,
  'pipeline.incomplete', 'cannot retype the last won stage of the default deal pipeline');
select tests.throws($q$update public.pipelines set is_active = false where id = tests.ref('p_new')$q$,
  'pipeline.default_must_stay_active', 'cannot deactivate the default pipeline');
select tests.throws($q$update public.pipelines set kind = 'lead' where id = tests.ref('p_new')$q$,
  'pipeline.immutable_field', 'a pipeline cannot change kind');
select tests.throws($q$update public.pipeline_stages set pipeline_id = (select id from public.pipelines where company_id = tests.ref('alpha')
  and kind = 'deal' and id <> tests.ref('p_new') limit 1) where pipeline_id = tests.ref('p_new') and position = 0$q$,
  'pipeline.immutable_field', 'a stage cannot move to another pipeline');
select tests.throws($q$update public.pipeline_stages set is_active = false where pipeline_id = (select id from public.pipelines
  where company_id = tests.ref('alpha') and kind = 'lead' and is_default)$q$,
  'pipeline.incomplete', 'cannot deactivate every stage of the default lead pipeline');

select tests.lives($q$select public.set_default_pipeline((select id from public.pipelines where company_id = tests.ref('alpha')
  and kind = 'deal' and name <> 'Projects' limit 1))$q$, 'switch back');
select tests.lives($q$update public.pipeline_stages set is_active = false where pipeline_id = tests.ref('p_new') and stage_type = 'lost'$q$,
  'a non-default pipeline may be left incomplete while being edited');
select tests.throws($q$select public.set_default_pipeline(tests.ref('p_new'))$q$, 'pipeline.incomplete',
  'a deal pipeline without an active lost stage cannot become the default');
select tests.lives($q$update public.pipelines set is_active = false where id = tests.ref('p_new')$q$, 'a non-default pipeline can be deactivated');
select tests.throws($q$select public.set_default_pipeline(tests.ref('p_new'))$q$, 'pipeline.inactive',
  'an inactive pipeline cannot become the default');

-- Rules from the stage guard still apply.
select tests.throws($q$insert into public.pipeline_stages (pipeline_id, company_id, name, position, stage_type)
  select id, company_id, 'Won lead?', 9, 'won' from public.pipelines where company_id = tests.ref('alpha') and kind = 'lead' and is_default$q$,
  'pipeline.lead_stages_must_be_open', 'lead pipelines only have open stages');

select tests.login('mgr_a');
select tests.throws($q$select public.set_default_pipeline(tests.ref('p_new'))$q$, '(auth.forbidden|pipeline)',
  'sales managers cannot change the default pipeline');
select tests.eq((select count(*) from public.pipelines where id = tests.ref('p_new') and is_default), 0::bigint, 'unchanged');

rollback;
