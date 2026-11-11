-- Rate limiting (0810): own-bucket isolation, keyed buckets for the service
-- role only, limits and argument validation.
begin;

select tests.login('agent_a1');
select tests.ok(public.rate_limit_hit('send_message', null, 2, 60), 'first call is allowed');
select tests.ok(public.rate_limit_hit('send_message', null, 2, 60), 'second call is allowed');
select tests.ok(not public.rate_limit_hit('send_message', null, 2, 60), 'third call within the window is refused');
select tests.ok(public.rate_limit_hit('export', null, 2, 60), 'a different action has its own bucket');

-- A user cannot exhaust someone else's quota: the key is ignored for users.
select tests.ok(not public.rate_limit_hit('send_message', tests.uid('agent_a2')::text, 2, 60),
  'passing another user''s id as key still counts against the caller');
select tests.login('agent_a2');
select tests.ok(public.rate_limit_hit('send_message', null, 2, 60), 'other users are unaffected');

select tests.throws($q$select public.rate_limit_hit('Bad-Action!', null, 1, 60)$q$, 'rate_limit.invalid_arguments',
  'action names are validated');
select tests.throws($q$select public.rate_limit_hit('x', null, 0, 60)$q$, 'rate_limit.invalid_arguments', 'limit must be positive');
select tests.throws($q$select public.purge_rate_limits()$q$, 'permission denied', 'users cannot purge counters');
select tests.throws($q$select count(*) from app.rate_limits$q$, 'permission denied', 'users cannot read counters');

select tests.login_anon();
select tests.throws($q$select public.rate_limit_hit('sign_in', 'abc', 5, 60)$q$, 'permission denied',
  'anon cannot touch rate limits (sign-in limiting is done server-side)');

select tests.service();
select tests.ok(public.rate_limit_hit('sign_in', 'h_0123456789abcdef', 1, 600), 'service role: keyed bucket allowed once');
select tests.ok(not public.rate_limit_hit('sign_in', 'h_0123456789abcdef', 1, 600), 'service role: keyed bucket refused after limit');
select tests.ok(public.rate_limit_hit('sign_in', 'h_fedcba9876543210', 1, 600), 'different key, different bucket');
select tests.throws($q$select public.rate_limit_hit('sign_in', null, 1, 600)$q$, 'rate_limit.invalid_arguments',
  'service calls must provide a key');
select tests.throws($q$select public.rate_limit_hit('sign_in', 'raw email@example.com', 1, 600)$q$, 'rate_limit.invalid_arguments',
  'keys must be opaque tokens (hashes), not raw e-mails');
select tests.eq(public.purge_rate_limits(), 0, 'purge keeps current windows');

rollback;
