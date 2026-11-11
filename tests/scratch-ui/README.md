# Scratch UI harness (frontend tests of the real app)

Everything here runs **only** against disposable local resources: a copy of the scratch Postgres (`kapso_ui_scratch`), my own PostgREST container
(`kapso-ui-postgrest`, port 3300) and a tiny gateway (`gateway.mjs`, port 3301) that stands in for the Supabase API (PostgREST proxy + a minimal sign-in).
It never touches Staging, Production or the shared local Supabase stack, and `.env.local` is never edited (the launcher overrides the Supabase variables
and disables Kapso sending for its own process only).

1. `bash tests/scratch-ui/reset.sh` - rebuilds `kapso_ui_scratch` from the fixture database, applies migration 986 and `seed.sql`, restarts PostgREST.
2. Start the gateway: `JWT_SECRET=<same as PGRST_JWT_SECRET> PGRST_URL=http://127.0.0.1:3300 PORT=3301 node tests/scratch-ui/gateway.mjs`
3. Start the app with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3301`, the anon / service keys printed by `GET http://127.0.0.1:3301/anon-key` (local, scratch-signed),
   `KAPSO_WEBHOOK_SECRET=`, `KAPSO_SEND_ALLOWLIST=` and `next dev -p 3299`.
4. `APP=http://localhost:3299 node tests/scratch-ui/e2e.mjs` - 34 steps; writes `tests/scratch-ui/out/frontend_results.json` and screenshots (git-ignored).
   Run `reset.sh` again before every run (the suite creates bookings and uses the unique-customer rule).
