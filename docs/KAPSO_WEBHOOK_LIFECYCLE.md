# Kapso webhook: event lifecycle, invalid events, protocol selection

Status: **implemented in code, tested on disposable scratch PostgreSQL only.** The SQL it relies on is in `supabase/proposed/` and is
**not applied** anywhere. Nothing here sends WhatsApp messages; outbound stays disabled (`outbound_enabled = false`).

## 1. Lifecycle

```
HTTP POST /api/webhooks/kapso
  -> method POST? (405)  -> configured? (503 "not configured")  -> Content-Type JSON or absent? (415)
  -> body <= 2 MiB, enforced while streaming (413)
  -> HMAC-SHA256 of the RAW bytes == X-Webhook-Signature, constant time (401)          nothing above stores anything
  -> payload version / JSON / event name / batch envelope   -> unusable as a whole: ONE quarantine row (body fingerprint)
  -> items:   invalid item                                  -> ONE quarantine row (logical key or item fingerprint)
              account check (kapso_account_protocol)        -> incompatible: quarantine row with the item
              history_sync                                  -> ONE 'ignored' row (no payload)
              unknown / conflicting origin                  -> ONE quarantine row (no content)
              customer message / status / echo              -> claim -> ingest/apply (one DB transaction) -> finish
  -> 200 when every item has a durable state; 503 as soon as one state could not be written
retry job (pg_cron every 5 min, or GET /api/cron/whatsapp-retry): failed rows + v2 rows stuck 'pending' > 15 min,
  attempts < 8, FOR UPDATE SKIP LOCKED, quarantine rows never selected
```

Code: `src/lib/kapso/webhook-http.ts` (HTTP), `src/lib/kapso/v2.ts` / `processor.ts` (protocols), `src/lib/kapso/quarantine.ts`
(records), `src/lib/kapso/protocol.ts` (compatibility), `src/lib/cron-retry.ts` + `src/lib/cron-auth.ts` (cron).
SQL: `supabase/proposed/20261104000978_kapso_event_lifecycle.sql`.

## 2. Durable states of an item

| State | Row in `whatsapp_webhook_events` | Who moves it on |
|---|---|---|
| processed | `processed`, payload `{}` | final |
| duplicate | the existing row is already `processed`/`ignored` | final (nothing written) |
| failed, retryable | `failed`, payload = the serialized event (`kapso_inbound_v2` / `kapso_status_v2` / v1 kinds), `last_error` = stable code | retry job, max 8 attempts, then a dead letter until the 30-day retention |
| in flight / crashed | `pending` | the same event's redelivery (`retry`), or (v2) the retry job after 15 minutes |
| quarantined | `failed`, payload kind `kapso_quarantined`, `last_error` = reason | a person (reprocess, see 6); the retry job never selects it |
| ignored (history_sync) | `ignored`, payload `{}` | final |

State invariants (enforced in PostgreSQL, row-locked, tested with independent sessions — `scripts/db/concurrency/t7.sh`):

* **`processed` and `ignored` are terminal.** `finish_kapso_event` changes a row only while it is `pending` or `failed`; for a terminal
  row ANY requested status (failed, processed, ignored) returns `already_final` and the row is left byte-for-byte unchanged. Two
  workers finishing the same row serialize on its row lock; the second re-checks the condition on the committed row and is refused.
  `claim_kapso_event` answers `duplicate` for a terminal row; the retry job never selects one.
* **A quarantine/ignore write replaces only a quarantine record.** `record_kapso_held_event` (one statement, row locked) refreshes an
  existing row only if it is itself a quarantine record (kind `kapso_quarantined`, pending or failed). Every other existing row — terminal,
  or a processable event that is pending (in flight / crashed) or failed (retry work), of any event kind — is returned as `duplicate` and
  left byte-for-byte unchanged (payload, kind, status, attempts, last_error, received_at, processed_at, phone_number_id).
* `claim_kapso_event` refreshes the payload of a non-final row, so a redelivery that now parses replaces a quarantine record; if it then
  fails, the row holds real retry work.
* TypeScript: `finishEvent` returns `finished | already_final`; `already_final` (another delivery or the retry job finished the event
  first) is counted as a duplicate — never as processed by this delivery, never as failed retry work; any other RPC result is treated
  as an unrecorded state (503).

## 3. Reason codes (`last_error` of a quarantine row)

| Code | Meaning | Item kept? | Key |
|---|---|---|---|
| `invalid.missing_customer_identity` (v2) / `invalid.missing_customer_phone` (v1) | no readable phone and no readable BSUID | yes (<= 16 KiB) | logical |
| `invalid.invalid_timestamp` | `message.timestamp` unreadable | yes | logical |
| `protocol.v2_required` | production account reached the v1 path | yes | logical |
| `account.misconfigured` | account row contradicts itself (environment / connection mode / company sandbox flag) | yes | logical |
| `invalid.missing_message`, `invalid.invalid_phone_number_id`, `invalid.invalid_message_id`, `invalid.direction_mismatch` | malformed item | no (key names only) | `kapso:invalid:<sha256>` |
| `origin.unknown`, `origin.direction_conflict` | origin not one we may ingest | no | logical |
| `payload.invalid_json`, `payload.unsupported_version`, `payload.not_object`, `batch.missing_data`, `batch.too_large`, `event.unsupported` | the whole signed body | no (size, safe header values, top-level key names) | `kapso:invalid_payload:<sha256 of body>` |

Retryable failure codes (`failed` with an event payload) are the database's dotted keys, e.g. `kapso.unknown_account`,
`status.message_not_found`, `kapso.identity_conflict` (contact moved 5 times while waiting, patch 977), `processing_error`
(anything not a known key; free text and customer data are never stored).

## 4. HTTP response policy

| Answer | When | Provider effect |
|---|---|---|
| 401 | missing/malformed/wrong signature | nothing stored or revealed |
| 405 / 413 / 415 / 503 "not configured" | before authentication | nothing stored |
| **200** `{ "ok": true }` | every item processed, duplicate, recorded for retry, quarantined or ignored | Kapso stops redelivering |
| **503** `{ "ok": false }` | a claim / quarantine / failure mark / account check could not be written | Kapso redelivers (2 retries in ~50 s); finished items are duplicates then, never second messages/leads/conversations |

A permanently invalid but **recorded** event is answered 200 (redelivery cannot fix it). The body never contains database detail.

## 5. Protocol selection (`KAPSO_PROTOCOL`)

| | sandbox account | production account | misconfigured | unknown / inactive | DB without Rev6 |
|---|---|---|---|---|---|
| `v1` (default, also when unset/empty) | processed (0960 wrappers) | **quarantined `protocol.v2_required`** | quarantined | processed -> DB refuses -> failed (retryable) | processed (every Kapso account is a sandbox there) |
| `v2` (explicit) | processed (Rev6 delegates phone-only sandbox traffic to 0960) | processed | quarantined | DB refuses -> failed (retryable) | not usable (RPCs missing -> 503) |

Any other value fails closed (503 "not configured"). The decision is made per `phone_number_id` from the account row
(`kapso_account_protocol`), not from the environment variable alone; one deployment can serve sandbox and production accounts with `v2`.

Deployment variables (values never logged): `KAPSO_WEBHOOK_SECRET` (>= 16 chars), `KAPSO_PROTOCOL` (`v2` for production),
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (cron route). v2 needs, in order: proposed 970, 972, 975, 976, 977, 978.

## 6. BSUID

* `KAPSO_BSUID_PATHS = []`: **the payload field that carries the BSUID is not known** (not in Kapso's documentation, never seen in a
  captured payload). No BSUID is read; no path is guessed.
* A customer without a readable phone is quarantined as `invalid.missing_customer_identity` **with the original item**. No contact,
  conversation, lead or identity is created; no E.164 number is derived; nothing is merged.
* Once the field is confirmed from a real payload: add it to `KAPSO_BSUID_PATHS`, then run `reprocessQuarantinedV2(store,
  "invalid.missing_customer_identity")` (operator action, not wired to any route). Items that now parse complete their own row;
  the rest stay quarantined. Tested with a test-only path on scratch PostgreSQL.
* Identities are scoped per Kapso account (`contact_identities` unique per account); the same BSUID on two accounts is two contacts.
* BSUID-only conversations cannot be replied to: the database refuses any send on production Kapso accounts while outbound is disabled.

## 7. Retry worker

`process_webhook_retries` (978 version): one transaction per run, limit 100, attempts < 8 (incremented before each try), oldest first,
`FOR UPDATE SKIP LOCKED` (two concurrent runs never take the same row), each event in its own sub-transaction (a failure is recorded,
the rest go on). Fixed cadence (pg_cron every 5 minutes) is the back-off; a manual cron call only adds a run. It calls only intake
functions (no send, no HTTP), and every intake function resolves the account from the stored `phone_number_id`.
v2 kinds (`kapso_inbound_v2`, `kapso_status_v2`) are finished with `finish_kapso_event` (counted only when it answers `finished`);
Meta and v1 kinds keep `finish_webhook_event` exactly as in 970. While the job runs it holds each of its rows `FOR UPDATE`, so a webhook
worker finishing / claiming / quarantining the same event waits and then sees the job's result (`already_final` / `duplicate`); a row
a webhook worker holds is skipped (`SKIP LOCKED`). Tested in independent sessions: `scripts/db/concurrency/t7.sh jobrace`.
Cron route: `Authorization: Bearer <CRON_SECRET>` compared in constant time (HMAC digests); 401 never starts the job; 500/503 carry
no detail.

## 8. Security controls

Raw-body HMAC-SHA256, constant-time comparison, signature before parsing/storage, size cap while streaming, content-type check,
company/account never taken from the request (only `phone_number_id`, which is unique), unknown numbers create nothing, stable error
codes only, structured logs with counters/codes/origin names only (no content, phone, ids, signature or secret), service-role-only
SQL functions with `search_path ''`.

## 9. Migrations and rollback (review only, nothing applied)

Order: 970 -> 972 -> 975 -> 976 -> 977 -> 978 (see `supabase/proposed/README.md`). Roll back in reverse order. 978's rollback drops
its five functions and restores the 970 body of `process_webhook_retries`; no data is deleted and rows written through 978 remain
valid for 970. After rolling back 978, set `KAPSO_PROTOCOL=v1` (v2 would answer 503).

## 10. Blocked pending Kapso confirmation

* BSUID field location and format (see 6).
* `read` status payload shape; the exact set of `message.kapso.origin` values (unknown values are quarantined, never ingested).
* Whether Kapso sends `Content-Type: application/json` on every delivery (a missing header is accepted; a different one is 415).
* Outbound API contract and idempotency: no outbound implementation exists.
