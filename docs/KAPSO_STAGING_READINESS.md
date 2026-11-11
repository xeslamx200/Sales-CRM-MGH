# Kapso Staging readiness — checklist (2026-11-05)

Statuses: **Ready** · **Blocked** · **Requires user input** · **Requires external provider confirmation**.
Details and commands: `docs/KAPSO_STAGING_DEPLOYMENT_RUNBOOK.md` (section numbers in brackets). Nothing has been deployed or applied.

**Overall: NOT ready for an actual Staging deployment** — the target environment is not identified and the repository is not committed.

## Code and migrations
| Item | Status | Note |
|---|---|---|
| Migration files 970, 972, 975, 976, 977 (revised), 978 (rev. 2 + 3) present, hashes recorded | Ready | [4.1] |
| Rollback files for all six, hashes recorded | Ready | [4.1] |
| Static safety scan of the proposed files (`check-migrations` logic) | Ready | passed, 6 files; committed chain 27 files passed |
| Order and dependencies understood (977 after 972; 978 after 970; reverse-order rollback) | Ready | [4.2] |
| Proposed files promoted into `supabase/migrations/` | Requires user input | approved commit needed; `db push` ignores `supabase/migrations/` [4.3] |
| Working tree committed and pushed to a private remote | Requires user input | 35 uncommitted entries; no remote [1] |
| Admin path to create a Kapso **production-environment** account | Blocked | UI creates Kapso accounts as sandbox only; reviewed SQL [8.9] or a UI change must be approved |
| Scratch evidence (SQL suite, t1–t7, rollback catalog identity, TS e2e) | Ready | `KAPSO_REMEDIATION_REPORT.md` rev. 2–3 |

## Staging environment
| Item | Status | Note |
|---|---|---|
| Supabase staging project (ref, region, organization, plan) | Requires user input | I1, I2 |
| Postgres 17 on the project | Requires user input | verified at preflight P7 |
| `pg_cron` available (retry job scheduled) | Requires user input | 0870 skips scheduling silently without it; stop condition [9.3] |
| Vercel project, plan, region, production-domain webhook URL | Requires user input | I3, I4 |
| Operator machine (Supabase CLI, psql 17, openssl) | Requires user input | I9 |
| Backup procedure | Ready | [7]; Free plan has no automatic backups |
| Preflight checks P1–P10 defined | Ready | [5] |
| Post-migration verification incl. function fingerprints | Ready | [9.1] 15 md5 values from the scratch build |

## Configuration
| Item | Status | Note |
|---|---|---|
| Variable matrix (names, secrecy, staging values) | Ready | [6] |
| `KAPSO_PROTOCOL=v2` set explicitly in staging | Requires user input | entered by the owner in Vercel |
| `KAPSO_WEBHOOK_SECRET` (staging-only) | Requires user input | entered by the owner; never in chat |
| `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `APP_URL`, public Supabase vars | Requires user input | staging values only |
| `WHATSAPP_*` left unset (no Graph send possible) | Ready | decision recorded [6] |
| `.env.example` lists `KAPSO_PROTOCOL` | Blocked (minor) | not changed in this preflight; documentation gap |
| `/api/health` reports Kapso configuration | Blocked (minor) | not implemented; use the unsigned-POST probe T0 |

## Testing
| Item | Status | Note |
|---|---|---|
| Fixture tests T0–T10, T12–T14 (signature, malformed, duplicates, mixed batch, origins, BSUID quarantine, retry, isolation, cron auth, outbound off) | Ready (plan) | [10]; need the deployed staging app |
| Concurrency / crash / terminal-state suites | Ready (scratch only) | cannot and must not run on staging; scratch evidence [9.2] |
| Real provider deliveries T15–T16 (inbound, statuses, echoes) | Requires external provider confirmation | staging Kapso number + webhook |
| BSUID support | Requires external provider confirmation | field unknown; BSUID-only items stay quarantined (T17) |
| Origin value set, `read` payload, Content-Type | Requires external provider confirmation | [10] T15–T16 |

## Safety
| Item | Status | Note |
|---|---|---|
| `outbound_enabled=false` by default + DB send guard | Ready | verified at V4 and T14 |
| Retry job has no send path | Ready | V6 + body check [12.4] |
| Cron requires bearer auth | Ready | T13 |
| Logs free of content/PII/secrets | Ready (unit-tested) | re-check on staging logs [12.6] |
| Staging/production separation (org, project, secrets, `STAGING — ` prefix) | Requires user input | [12.7] |

## MGH Receive-only (later, production — not staging)
| Item | Status | Note |
|---|---|---|
| MGH company id, phone_number_id, connection mode, Kapso project | Requires user input | I10 [11] |
| Kapso delivery configuration and signing secret for production | Requires external provider confirmation | [11.7] |
| Staging go criteria met | Blocked | depends on everything above |
| Outbound | Blocked | not implemented; out of scope |
