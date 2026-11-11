# Architecture

```
Browser (Arabic RTL UI)                     Meta WhatsApp Cloud API
   │  Next.js App Router (React, server components)     │ webhooks ▲ sends
   ▼                                                    ▼          │
Vercel ── server actions / route handlers ──────────────┴──────────┘
   │   user's session (anon key + JWT)  → RLS + DB rules apply
   │   service-role key (webhooks, send results, cron only)
   ▼
Supabase: Postgres (RLS, triggers, RPCs, reporting functions) + Auth
```

## Principles

* **The database is the source of truth for authorization and business rules.** RLS decides what rows exist for a user; triggers decide which changes are legal; RPCs make multi-row operations atomic. The app cannot bypass them by accident, because normal requests use the user's session.
* **One definition per metric**, in SQL, tested with exact values (`docs/METRICS.md`).
* **History is append-only**: lead status, lead assignment, deal stage, conversation assignment, audit log.
* **Pure logic lives in `src/lib`**, with no framework imports, unit-tested with Node's test runner.
* **No external automation platforms.** Background work is either a database function triggered by Supabase `pg_cron`, or a Vercel Cron route protected by `CRON_SECRET`.
* **The app only formats.** Server components and server actions read and write with the user's session; every number on the dashboard comes from a `report_*` function. Raw database errors never reach the browser: actions return localized messages from stable keys (`src/server/action.ts`, `src/lib/errors.ts`).
| `…0960_kapso_sandbox` | Kapso Sandbox (Phase 1): `companies.is_sandbox` (immutable), `whatsapp_accounts.provider/is_sandbox`, derived `is_sandbox` flags on contacts/conversations/messages/leads, provider-specific wrappers `ingest_kapso_message` / `ingest_kapso_echo` / `apply_kapso_status` with account-ownership checks, sandbox boundary/send guards; replaces `app.report_scope`, `report_whatsapp_workload` (sandbox companies excluded from every metric) and `process_webhook_retries` (additive Kapso branch). See `docs/KAPSO_SANDBOX.md` |

## Repository layout

```
supabase/
  migrations/          versioned schema, RLS, rules, RPCs, reports (apply in order)
  seed/dev_seed.sql    fictional, labeled development data (opt-in only)
  tests/shim/          local emulation of Supabase auth/roles (tests only)
  tests/db/            SQL test suite (helpers, fixtures, 01–06)
src/
  lib/                 pure, framework-free modules (node --test): phone, csv, import, dates, errors, format, whatsapp/*, kapso/*
  env.ts               Zod env schemas (names only in errors); src/server/env.ts reads them server-side
  proxy.ts             Next 16 "proxy" (formerly middleware): session refresh + sign-in redirect
  app/                 routes: (auth) sign-in flows, (app) CRM screens, api/webhooks, api/cron, api/export
  actions/             "use server" actions (Zod-validated, user session, localized errors)
  server/              server-only: Supabase clients, viewer/session, data queries, WhatsApp store/send, rate limits
  components/          ui/ (shadcn), app/ (design system), crm/, inbox/, reports/, shell/, form/
  i18n/                ar.ts (source of truth), en.ts (same shape, type-checked)
  schemas/             Zod schemas shared by client forms and server actions
  types/database.ts    generated from the schema (npm run db:types)
tests/unit/            node:test unit tests
tests/e2e/             Playwright
scripts/db/            reset-local.sh, test.sh
docs/                  this documentation
```

## Migrations

| File | Contents |
|---|---|
| `…0100_core_schema` | enums, 29 tables, constraints, indexes, `updated_at` triggers |
| `…0200_access_helpers` | `app.*` scope functions used by RLS (SECURITY DEFINER, pinned `search_path`) |
| `…0300_rls_policies` | RLS on every table; `anon` revoked |
| `…0400_business_rules_core` | audit, notifications, profiles, companies, memberships, teams, contacts, default pipelines |
| `…0500_business_rules_sales` | leads, deals, tasks, activities, targets (guards, history, notifications) |
| `…0600_conversations_and_rpcs` | conversation/message rules; RPCs: contacts, assignment, conversion, outbound queue, ingestion, merge, reminders |
| `…0690_function_grants` | EXECUTE privileges (internal helpers closed; service-only RPCs closed to users) |
| `…0700_reporting` | KPI, performance, daily series, targets, response time, workload |
| `…0710_whatsapp_echoes_and_retries` | coexistence echoes, webhook claim/finish/retry/purge |
| `…0720_hardening_teams_contacts` | team membership admin-only; contact phone guard; definer fixes |
| `…0800_search_and_import` | `global_search`, `import_leads` (both invoker), trigram indexes |
| `…0810_rate_limits` | DB-backed rate-limit counters (own-bucket for users, keyed for the service role) |
| `…0820_rls_performance` | hot RLS policies rewritten with statement-level scope sets (same rules, proven equivalent) |
| `…0830_report_daily_series_perf` | daily series in one pass per table (same values) |
| `…0840_security_fixes` | contact-merge authorization, login events from Auth triggers, target-actual scope, dead-letter retention |
| `…0850_guards_former_members` | edits to records owned by deactivated/former members no longer blocked |
| `…0860_claim_requires_reply` | claiming a conversation requires reply permission on the number |
| `…0870_scheduled_jobs` | pg_cron jobs (retries, reminders, retention) with a run log (`app.job_runs`) |
| `…0880_conversation_company_move` | move a conversation to another company with a reason |
| `…0890_whatsapp_media_templates_health` | private buckets, media cache, templates, credential health, `queue_outbound` (text/media/template) |
| `…0900_pipeline_admin` | create pipeline, reorder stages, switch default |
| `…0910_pipeline_integrity` | the default pipeline stays active and complete; rows can't move between pipelines/companies |
| `…0920_attachments_guard` | attachment rows: caller as uploader, record's company, path inside the record's folder, type allow-list; tighter delete |
| `…0930_business_hours` | business hours, holidays, `app.business_seconds`, business-hours columns in the response report |
| `…0940_template_support` | `whatsapp_templates.supported`: only templates the CRM can send (no media headers, header/URL parameters, carousels…) are offered and accepted |
| `…0950_auto_leads` | automatic WhatsApp leads (`leads.conversation_id/auto_created/interest/offering_*`, nullable creator for automatic leads only), `company_offerings`, `conversation_leads` view, `lead_from_conversation`, owner-sync and unlink triggers; replaces `ingest_whatsapp_message`, `guard_lead`, `after_lead_change` |

## Key decisions

| Decision | Why |
|---|---|
| Canonical `contacts` + `contact_companies` | Shared identity without sharing business data; exact-phone dedup across companies. |
| Deal status derived from stage type | Prevents "won" deals sitting in an open stage; revenue can't drift from the pipeline. |
| Outcome timestamps set by the database | Revenue and performance can't be backdated from the UI. |
| Conversation per (number, customer) | Mirrors WhatsApp's single thread per pair; company is an attribute that authorized managers can change. |
| Internal notes in their own table | They can never be sent to a customer by mistake. |
| Per-number access grants | Shared numbers across companies with explicit control over who reads and who replies. |
| SECURITY DEFINER reports with explicit scope | Fast aggregates; scope mirrors RLS and is tested. |
| Scheduled reminders via `generate_task_reminders()` | Run by Supabase `pg_cron` every 15 min. It's an in-database extension, so there's no extra deployment component. Vercel Cron is the alternative. |
| Latin digits in the Arabic UI | Consistent numbers in tables, exports and phone numbers (one constant to change). |
| RLS scope as statement-level sets | `(select app.admin_company_ids())` etc. are evaluated once per query (initPlans), so policies cost hash lookups per row instead of per-row function calls. 50k leads: search 30–50 s → ~0.5 s, contacts list 27 s → 0.26 s. |
| Email links use token hash + `verifyOtp` | Invites start in the admin's browser, so PKCE codes can't work; `/auth/confirm` verifies a one-time token hash. |
| Polling, not Realtime, in the inbox | 15 s refresh; simple and works everywhere. Supabase Realtime can replace it later without schema changes. |
