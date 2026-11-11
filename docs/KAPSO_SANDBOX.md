# Kapso Sandbox (Phase 1: receive-only)

Lets the team exercise the real CRM workflow (contact → conversation → messages → automatic lead → assignment → pipeline) with WhatsApp traffic from **Kapso's sandbox**, without touching Meta, any production number, or any company's numbers. Phase 1 only **receives**: nothing is ever sent through Kapso.

**State (23 Oct 2026): implemented and tested locally only.** The Kapso webhook has not been created, no tunnel exists, no port is exposed, no message has been sent, migration `0960` is applied to no database except the local ones, and nothing is committed. Exposing the app is a separate decision (§9).

## 1. What was added

| Piece | Where |
|---|---|
| Endpoint `POST /api/webhooks/kapso` (separate from Meta's) | `src/app/api/webhooks/kapso/route.ts` |
| Signature check, bounded body reader | `src/lib/kapso/signature.ts` |
| Payload v2 parser (framework-free) | `src/lib/kapso/parser.ts` |
| Processing, idempotency keys, outcomes | `src/lib/kapso/processor.ts` |
| Store (service role, provider-specific wrappers only) | `src/server/whatsapp/kapso-store.ts` |
| Database: sandbox company, provider, flags, wrappers, metric exclusion | `supabase/migrations/20261021000960_kapso_sandbox.sql` |
| Tested rollback | `supabase/rollbacks/20261021000960_kapso_sandbox.rollback.sql` |
| Env | `KAPSO_WEBHOOK_SECRET` (`src/env.ts`, group `kapso`; empty → endpoint answers 503) |
| UI | sandbox badge/banner, company switcher, composer disabled, admin forms (sandbox company, Kapso number) |

**Not touched:** the Meta route, signature, parser, store, `ingest_whatsapp_message`, `ingest_whatsapp_echo`, `apply_whatsapp_status`, and every existing test.

## 2. The design in one paragraph

A Kapso number belongs to a **sandbox company** (`companies.is_sandbox`, immutable). Everything that number produces lives inside that company, so **no real company can ever contain sandbox rows**, and every report skips sandbox companies by construction. The webhook never says which company or account to use: the database maps `phone_number_id` → account → company and refuses anything that is not an active Kapso sandbox account of a sandbox company.

## 3. Endpoint contract (verified against Kapso's documentation, 22–23 Oct 2026)

| | |
|---|---|
| Method | `POST` only (anything else: 405) |
| Signature | header `X-Webhook-Signature` = hex HMAC-SHA256 of the **raw body** with the webhook secret; no prefix, no timestamp. Compared in constant time after a length check. Missing/invalid → **401**, before anything about the request is read or stored |
| Version | `X-Webhook-Payload-Version` must be `v2`; anything else → **400** (checked after the signature) |
| Events (`X-Webhook-Event`) | `whatsapp.message.received`, `.sent`, `.delivered`, `.read`, `.failed`. Any other signed event → 200 and ignored (so Kapso doesn't retry it) |
| Batches | `{ type, batch: true, data: [...], batch_info }` (received messages); at most 100 items, else 400. A bad item never blocks the others |
| Body limit | 2 MiB, enforced while streaming (declared `Content-Length` too) → **413** |
| Answers | 200 once the batch is recorded (per-event failures are stored for our retry job); **503** when storage or `KAPSO_WEBHOOK_SECRET`/service-role is unavailable (Kapso then retries); 400/401/413 as above |
| Kapso retries | max 3 attempts (10 s and 40 s apart, ~50 s in total) and it expects 200 within 10 s |

Direction cross-check: the event name comes from an **unsigned** header, so the parser also requires it to agree with the **signed** body (`message.kapso.direction`): `received` must be inbound; `sent/delivered/read/failed` must be outbound. A mismatch is dropped and logged as `item[n].direction_mismatch`.

## 4. Idempotency (retries, batches, parallel deliveries, races)

* Logical event keys, not Kapso's `X-Idempotency-Key` (which only identifies one delivery): `kapso:msg:<wamid>` and `kapso:status:<wamid>:<status>`. `sent`, `delivered`, `read` and `failed` share the wamid, so the status is part of the key. The `kapso:` prefix cannot collide with Meta's `msg:` / `status:` keys.
* `claim_webhook_event` (unique key) plus the existing unique `messages.wa_message_id`; the Kapso wrappers call the existing idempotent functions.
* A **status that arrives before its message** (Kapso reports messages the CRM never created): the wrapper records an **echo** (outbound, no employee credited) from the customer phone in the payload and applies the status; if the payload names no customer it returns "not applicable yet" and the event is retried by the scheduled job (`status.message_not_found`).
* Statuses only move forward (`guard_message_update`); a late `sent` never undoes `read`; `failed` keeps its code.
* Proven with real concurrency: 20 simultaneous deliveries of one message → one message, one conversation, one contact, one lead; 12 different messages from a new customer → one contact/conversation/lead; racing status events → one message at the furthest status; 10 parallel identical HTTP posts.

## 5. Ownership checks (database, not application)

`app.kapso_account(phone_number_id)` is called first by every wrapper and refuses (`kapso.unknown_account`) unless the account has `provider = 'kapso'`, `is_sandbox`, status `test` or `active`, and belongs to a sandbox company. Consequences, all tested:

* A **Meta** phone_number_id sent to the Kapso endpoint is refused and creates nothing.
* An unknown, `pending_setup` or `disabled` account is refused (the event is stored as failed and **recovered by the retry job** once the account is activated).
* A wamid that already belongs to another account (a Meta message, or another sandbox company's) is refused (`kapso.message_account_mismatch`); `apply_whatsapp_status` alone looks only at the wamid, so the Kapso wrapper checks the owner first.
* `company_id` / account ids in the payload are never read (unit-tested: they appear nowhere in the parsed event).
* Database triggers: a sandbox company cannot become real or vice versa (`company.sandbox_immutable`); a Kapso account can only live in a sandbox company and a Meta account never does (`whatsapp.sandbox_company_mismatch`); an account's provider cannot change once it has conversations (`whatsapp.provider_immutable`); a conversation cannot move between a sandbox and a real company (`conversation.sandbox_boundary`).
* Row flags (`is_sandbox` on conversations, messages, leads) are **derived** from the company by triggers; a user cannot forge or clear them.

## 6. Sandbox data never reaches metrics (safeguard 5)

**Mechanism.** `app.report_scope()` (used by `report_company_kpis`, `report_daily_series`, `report_target_progress`, `report_whatsapp_response` and, through `app.report_users`, `report_employee_performance`) skips sandbox companies; `report_whatsapp_workload` skips them explicitly. The dashboard "all companies" scope, lists and the inbox exclude sandbox companies unless one is chosen explicitly. The default company is a real one.

**Proof.**

1. *Differential test* (`supabase/tests/db/19_kapso_sandbox.sql`): every report function is called for 7 callers (super admin, company admin, manager, agent, shared employee, another company's admin and agent) × 4 companies (+ aggregates, with and without the sandbox id, with simulated data on/off). Then full sandbox activity is created: contacts, conversations, inbound/outbound messages, failures, automatic and manual leads, a won deal of 888,000, a lost and an open deal, completed/overdue tasks, activities, targets, notes, merges, and data created through the **unchanged Meta intake** naming a Kapso number. The two snapshots must be identical. Controls: the sandbox tables really hold the data; a change in a real company **does** change the snapshot (the test is not blind); the sandbox company's own reports are empty even for the super admin.
2. *Mutation checks*: removing the `report_scope` exclusion fails the test (20 snapshot entries differ); removing the workload exclusion fails it (6); removing the contact-unflag trigger fails the unflag test.
3. *Same proof through PostgREST as real users* (`tests/api/kapso.test.ts`): 6 users × all companies × 5 report families, before and after sandbox traffic plus a 987,654 won deal in the sandbox company: no result changes.
4. *Tripwire*: the test lists every function that reads business tables (45). A new function that does must be reviewed for sandbox exclusion before the list is updated.

**Limits (stated plainly).**

* `contacts` are global (one identity per phone, shared across companies). `contacts.is_sandbox` is a **display hint** (set by the Kapso wrappers; cleared the first time a real company links the contact); metrics never read it.
* The Meta intake does not check the provider. A Meta-signed payload naming a Kapso phone_number_id would still only create rows **in the sandbox company** (flagged, excluded); only someone holding the Meta app secret can send such a payload.
* Anything that counts rows without going through the reports above (a future export or report) must exclude `is_sandbox`/sandbox companies itself; the tripwire exists to catch that in review.
* "Import leads" and "search" are not metrics; a user who is a member of both a real and the sandbox company can search sandbox contacts.

## 7. Phase 1 limits

* **No outbound.** A database trigger refuses an employee message in a sandbox conversation (`whatsapp.sandbox_send_disabled`); the composer is replaced by a notice. Provider echoes/statuses from Kapso are recorded without a sender.
* **No media.** Media messages keep their type and caption; no file is fetched or referenced (Kapso hosts media behind its own URLs and there is no verified, safe download path yet).
* **No templates, no Meta connection test, no template sync** for a Kapso number (hidden in the UI and refused by the actions).
* **Customers without a phone number** (usernames/BSUIDs only) cannot create a contact; the event is recorded as a quarantine row (`invalid.missing_customer_phone`, original item kept) instead of being dropped, see docs/KAPSO_WEBHOOK_LIFECYCLE.md. Not seen in the sandbox yet.
* **`read`** payload shape is not documented by Kapso (no example). It is handled like `delivered`; verify with a real event.

## 8. Tests

| Layer | What | Result (23 Oct 2026) |
|---|---|---|
| Database | `supabase/tests/db/19_kapso_sandbox.sql`: guards, ownership, intake, duplicates, race, retries, send block, flag forgery, boundary, invariants, differential metrics proof, tripwire | **97 checks**; the whole suite is **708 checks / 19 files** on PostgreSQL 16 and 17 (the previous 611 unchanged) |
| Unit | `tests/unit/kapso.test.ts`: signature (tampering, wrong secret, prefix, truncation, other bytes, cross-provider), bounded reader, parser for all five events, batches, processor (order of checks, versions, duplicates, parallel, races, failures, 503, retry payload keys) | **34 tests**; mutation-checked (signature compare, direction check, version check, status key) |
| API (real Supabase, parallel) | `tests/api/kapso.test.ts` | **22 tests** (10 database-level, 11 HTTP against a loopback server, 1 Meta regression) |
| End to end (Playwright) | `tests/e2e/kapso.spec.ts`: visibility, badge, banner, disabled composer, "all companies" scope, admin forms | **3 tests**; the whole suite is **14 passing** on the production build |
| Rollback | `scripts/db/rollback-proof-0960.sh` (§10) | schema byte-identical, data checksums identical |

```bash
# Database
npm run test:db

# Unit
npm run test:unit

# API + end to end: a LOOPBACK server with a THROWAWAY secret (never a real Kapso secret, never a tunnel)
npm run build
S=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
KAPSO_WEBHOOK_SECRET=$S npx next start -H 127.0.0.1 -p 3210 &
KAPSO_TEST_BASE_URL=http://127.0.0.1:3210 KAPSO_WEBHOOK_SECRET=$S npm run test:api
E2E_BASE_URL=http://127.0.0.1:3210 KAPSO_WEBHOOK_SECRET=$S npx playwright test
```

`npm run test:api` runs its files **one at a time** (`--test-concurrency=1`): the metrics test compares reports before and after sandbox traffic and must not race another suite that is creating real-company data. Without `KAPSO_TEST_BASE_URL` the HTTP tests are reported as skipped.

## 9. Before the real Kapso webhook exists (all still to do, each needs your approval)

1. Review these results; decide whether to commit.
2. Apply `0960` to the **staging** database only after the staging plan is approved (`docs/STAGING_PLAN.md`); never to production for this test.
3. Set `KAPSO_WEBHOOK_SECRET` yourself (Kapso's UI generates the signing secret; paste it only into the environment variable, never into chat, a URL, a test or a file).
4. In the CRM (as super admin): create a **sandbox company** (admin → companies → "Sandbox company"), then a **Kapso number** in that company (admin → WhatsApp numbers → provider "Kapso Sandbox") with the `phone_number_id` Kapso shows, status "Test"; grant employees access to the number.
5. A public HTTPS address for the endpoint is the only thing Kapso needs. Options are a temporary tunnel (stopped right after) or the staging deployment; **neither exists yet** and each needs its own approval. Expose only `/api/webhooks/kapso`.
6. Create the Kapso webhook for that sandbox number: events received/sent/delivered/read/failed, payload version v2, the endpoint above.
7. Test with your own phone: one inbound message, check inbox, automatic lead, and that no report changed.

## 10. Rollback

`supabase/rollbacks/20261021000960_kapso_sandbox.rollback.sql` (manual, never automatic):

* **Part 1** (always, no rows change): restores the exact pre-`0960` `process_webhook_retries`.
* **Part 2**: restores the exact pre-`0960` `app.report_scope()` / `report_whatsapp_workload` and drops everything `0960` added, but **only if nothing sandbox exists** (no sandbox company, Kapso account, or flagged contact/conversation/message/lead). Otherwise it stops with counts, leaving the metric exclusion in place, because removing it would make sandbox data count in real KPIs. Resolve the data first (export, or delete the sandbox company's test data deliberately), then run it again (safe to re-run).

Proven by `scripts/db/rollback-proof-0960.sh` on scratch databases of a local Postgres, with Meta data present: apply → rollback leaves the schema **byte-identical** (`pg_dump -s`, including grants, functions, triggers, policies) and all row checksums unchanged; the three restored functions are byte-identical to their pre-`0960` definitions; Meta intake, statuses and the retry job still work afterwards; re-applying `0960` works; with sandbox data present Part 2 refuses and deletes nothing; after a deliberate purge it completes and the schema is identical to the baseline again. Revert the application code too (`src/lib/kapso`, the route, the store, UI and admin changes), or unset `KAPSO_WEBHOOK_SECRET` so the endpoint answers 503.

## 11. Unresolved risks

| Risk | Note |
|---|---|
| Kapso retries only ~50 s | A failure that lasts longer is recovered by our retry job (every 5 minutes, 8 attempts), not by Kapso. A `received` event whose body never reaches us (outage > 50 s) is lost. |
| `read` shape and sandbox send behaviour unverified | No documentation example for `read`; sending (a later phase) needs an API key, base URL and rate limits that are not verified. |
| Signature has no timestamp | Kapso's scheme cannot reject a replayed, validly signed request; replays are harmless here because every event is idempotent, and a replayed status could only repeat a status already reported. |
| Local-only evidence | Nothing was tested against Kapso itself; payloads follow Kapso's documentation. |
| Existing quirk (Meta route, left unchanged) | `safeErrorCode` in the Meta processor expects an `Error`, but Supabase errors are plain objects, so Meta events failed through the web path store the generic `processing_error` (the retry job stores the specific code). The Kapso processor reads both shapes. |
| Sandbox company in the user's UI | A super admin who selects it sees banners and test data; real-company scopes never include it. |
