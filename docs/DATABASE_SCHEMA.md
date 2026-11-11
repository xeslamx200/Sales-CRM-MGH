# Database schema

PostgreSQL (Supabase). UUID primary keys, `created_at`/`updated_at` everywhere they change, actor columns on every business record. Full DDL: `supabase/migrations/20261019000100_core_schema.sql`.

## Entities

```
companies ─┬─ company_memberships ── profiles (1:1 auth.users)
           ├─ teams ── team_memberships
           ├─ pipelines ── pipeline_stages
           ├─ contact_companies ── contacts (canonical identity, shared)
           ├─ leads ─┬─ lead_assignments   (history)
           │         └─ lead_status_history (history)
           ├─ deals ── deal_stage_history  (history)
           ├─ tasks, activities, sales_targets, attachments
           └─ conversations ─┬─ messages
                             ├─ conversation_notes (internal)
                             └─ conversation_assignments (history)
whatsapp_accounts ── whatsapp_account_access (per-user grants)
whatsapp_webhook_events (service-only intake)   notifications   audit_logs   auth_events
contact_duplicate_reviews (human review queue)
```

| Table | Purpose / notable rules |
|---|---|
| `companies` | `slug`, `timezone` (reports), `currency`. New companies get default lead and deal pipelines. |
| `profiles` | One per auth user (created by trigger). `is_super_admin`, `is_active`, locale. |
| `company_memberships` | `(company_id, user_id)` unique; `role` per company. |
| `teams` / `team_memberships` | `manager_id` must be a company admin or sales manager; members must belong to the company. |
| `contacts` | Identity only. `phone_e164` unique among active (non-merged) contacts. `merged_into_id` after review. |
| `contact_companies` | Company-specific relationship, owner, notes. |
| `contact_duplicate_reviews` | Ambiguous matches (same name / e-mail without a phone match) for human review. |
| `pipelines` / `pipeline_stages` | Per company; kind `lead` or `deal`; deal stages typed `open`/`won`/`lost` with default probability. |
| `leads` | `created_by` (immutable) and `owner_id` (current) are separate. Source, campaign, referral, status, priority, estimated value, follow-up date, qualification (JSON). Archive, not delete. |
| `lead_assignments` | from, to, team, by, reason, when. |
| `lead_status_history` | from, to, by, when. |
| `deals` | Amount + company currency; `status` derived from stage; `won_at`/`lost_at`/`closed_by` system-set; loss reason required when lost. |
| `deal_stage_history` | from/to stage and status, by, when. |
| `tasks` | Related contact/lead/deal; `completed_at`/`completed_by` system-set and final; `canceled_at`. |
| `activities` | call/meeting/note/email/whatsapp/other; actor forced to session user; cannot be future-dated. |
| `sales_targets` | Metric, period, value; for a user, a team, or the whole company. |
| `whatsapp_accounts` | Number, Meta `phone_number_id`/`waba_id` (not secret), default company, status, `is_simulated`. |
| `whatsapp_account_access` | Who can see a number, and whether they can reply. |
| `conversations` | Unique per (number, customer WhatsApp ID). Company, contact, owner, status, last inbound/outbound (24 h window), unread count. |
| `messages` | Direction, Meta message id (unique → dedup), type, body, media ref, status, `sent_by` (employee, outbound only), `client_request_id` (send idempotency), `is_simulated`. |
| `conversation_notes` | Internal only; never sent. |
| `whatsapp_webhook_events` | Event-key dedup, retry bookkeeping; payload redacted after processing. |
| `notifications` | Per user; dedupe key for scheduled reminders. |
| `audit_logs` | Append-only (UPDATE/DELETE/TRUNCATE blocked for every role). |
| `attachments` | Metadata for files in Supabase Storage (25 MB max), linked to an entity. |
| `auth_events` | Sign-in/out and password events, used for login reporting only. |
| `app.rate_limits` | Fixed-window counters for sensitive endpoints (`…0810`). Not exposed by the Data API; purged after 2 days. |

## Denormalized values (deliberate)

| Column | Why | Maintained by |
|---|---|---|
| `leads.last_activity_at`, `first_contacted_at` | Sorting and filtering lists without scanning activities | activity/task triggers |
| `conversations.last_*_at`, `unread_count` | Inbox ordering; enforcing the 24 h window without scanning messages | message trigger |
| `*.company_id` on child/history rows | Composite FKs guarantee a child can't point at another company's parent; also used for RLS | FKs |

## Deletion policy

* Business records are **archived**, not deleted (leads, deals). Hard deletes are Super Admin only.
* `on delete restrict` protects records that have history (a contact with leads, a company with deals).
* History, audit and assignment rows cascade only when their parent is hard-deleted by a Super Admin.

## Local workflow

```bash
./scripts/db/reset-local.sh          # rebuild local DB from migrations
./scripts/db/reset-local.sh --seed   # … plus fictional dev data
./scripts/db/test.sh                 # rebuild + run DB tests
```

New change = new migration file `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Never edit an applied migration. Deploying migrations: see `docs/DEPLOYMENT.md`.
