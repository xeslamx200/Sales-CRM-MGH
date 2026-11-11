# Multi-Company Sales CRM & WhatsApp Hub

One CRM for three companies under one management structure. It has shared employees and customers, strict per-company access, lead → deal pipeline, tasks, performance reporting, and a unified inbox for 4–6 WhatsApp Business numbers via Meta's official Cloud API. The interface is Arabic-first (RTL), with English available per user.

**Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind 4 + shadcn/ui · Supabase (Postgres, Auth, RLS) · Vercel. No n8n/Zapier/Make.

## Status

| Layer | State |
|---|---|
| Database: schema, RLS, business rules, RPCs, reports, search, import, rate limits, scheduled jobs (pg_cron), attachments, business hours, automatic WhatsApp leads, Kapso sandbox | **Done — 708 DB checks passing** (Postgres 16 and 17) |
| Pure logic (WhatsApp, Kapso, phone, CSV, import validation, periods, time zones, env, errors, attachments) | **Done — 100 unit tests passing** |
| Direct API security (real JWTs against REST/RPC/GraphQL/Storage) | **Done — 51 tests passing** (incl. 22 for Kapso Sandbox); security review in `docs/SECURITY.md` |
| Web app: auth, admin (companies, users, teams, numbers, pipelines, audit log, business hours, system status), contacts, leads, deals (with attachments), tasks, search, import/export, dashboard, reports, inbox (media, templates, automatic lead panel with interest/offering, company move), courses & services catalogue | **Done — 11 end-to-end scenarios (Playwright)** passing on `next dev` and `next start` |
| WhatsApp webhook / send pipeline | Built and tested locally with signed payloads and simulated numbers; **not verified against Meta** — needs your Meta app + test number |
| Kapso Sandbox, Phase 1 (receive-only, separate endpoint, sandbox company) | Built and tested locally; **no webhook created, nothing exposed, nothing sent** — see `docs/KAPSO_SANDBOX.md` |
| CI (GitHub Actions) | Workflow written; runs once the repository exists |
| Deployment | Staging runbook ready (`docs/DEPLOYMENT.md`); needs your accounts and approvals |

The full list is in [`docs/CHECKLIST.md`](docs/CHECKLIST.md).

## Local development

Requirements: Node 22.18+, Docker (for the local Supabase stack). PostgreSQL 16 client/server binaries only for the fast DB test suite.

```bash
npm install
npm run db:start            # local Supabase (applies supabase/migrations), prints local keys
cp .env.example .env.local  # fill with the local values printed above (never real secrets)
npm run seed:dev            # fictional demo data + users seed+<role>@example.test / Seed-Password-2026
npm run dev                 # http://localhost:3000 — sign in as seed+owner@example.test (super admin)
```

| Command | What it does |
|---|---|
| `npm run test:db` | Rebuilds a local Postgres DB from migrations and runs the SQL suite (`supabase/tests/db`) |
| `npm run test:unit` | Node test runner over `tests/unit` |
| `npm run typecheck` · `npm run lint` · `npm run build` | Static checks and production build |
| `npm run test:api` | Direct API security tests as real seed users (local Supabase only) |
| `npm run test:e2e` | Playwright scenarios (needs local Supabase + seed; starts `next start`) |
| `npm run check:migrations` · `npm run check:bundle` | Destructive-migration check · server secrets in the browser bundle (after a build) |
| `npm run db:types` | Regenerate `src/types/database.ts` from the local schema |

The DB suite needs a local Postgres on port 54322 (any method, e.g. `initdb -D ~/.pgdata -U postgres --auth=trust && pg_ctl -D ~/.pgdata -o "-p 54322" start`; set `PGHOST=localhost` on Windows). Local Supabase uses port 54332 for its database so both can run side by side.

## Documentation

| Doc | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | System shape, code layout, migrations, key decisions |
| [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) | Tables, relationships, denormalization, deletion policy |
| [SECURITY](docs/SECURITY.md) | Roles, access matrix, guarded transitions, service-role boundary, rate limits |
| [METRICS](docs/METRICS.md) | Exact definition of every KPI and report |
| [WHATSAPP_INTEGRATION](docs/WHATSAPP_INTEGRATION.md) | Coexistence findings, flow, what we need from you |
| [WHATSAPP_AUTO_LEADS](docs/WHATSAPP_AUTO_LEADS.md) | Automatic lead creation: rules, duplicate prevention, ownership, rollback |
| [KAPSO_SANDBOX](docs/KAPSO_SANDBOX.md) | Kapso Sandbox, Phase 1 (receive-only): endpoint contract, sandbox company, idempotency, metric isolation proof, rollback. Local only, not exposed |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Staging-first runbook: Supabase, Vercel, pg_cron jobs, WordPress-safe DNS, backups |
| [STAGING_PLAN](docs/STAGING_PLAN.md) | Proposed isolated staging (Supabase + Vercel), variables by name, migration/rollback plan, costs: awaiting approval |
| [TESTING](docs/TESTING.md) | Suites, commands, scenario coverage, volume check |
| [CHECKLIST](docs/CHECKLIST.md) | Progress |
