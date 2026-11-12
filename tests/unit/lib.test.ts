import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, toCsv, escapeCsvCell } from "../../src/lib/csv.ts";
import { resolvePeriod, localDate, parseCustomRange } from "../../src/lib/dates/periods.ts";
import { errorKey, userMessage, hasMessage } from "../../src/lib/errors.ts";
import { formatPercent, formatCurrency, formatDuration, formatNumber } from "../../src/lib/format.ts";

// ------------------------------------------------------------------- CSV
test("CSV parses quotes, escaped quotes, newlines in fields, CRLF and BOM", () => {
  const text = '﻿name,phone,notes\r\n"Haddad, Omar",+97455550001,"said ""hi""\nthen left"\r\nسارة,0555,\r\n';
  const r = parseCsv(text);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.headers, ["name", "phone", "notes"]);
  assert.deepEqual(r.rows, [["Haddad, Omar", "+97455550001", 'said "hi"\nthen left'], ["سارة", "0555", ""]]);
});

test("CSV rejects malformed or oversized input", () => {
  assert.deepEqual(parseCsv(""), { ok: false, error: "empty" });
  assert.deepEqual(parseCsv('a,b\n"x,y\n'), { ok: false, error: "unterminated_quote", line: 3 });
  assert.deepEqual(parseCsv("a,b\n1,2,3\n"), { ok: false, error: "inconsistent_columns", line: 2 });
  assert.deepEqual(parseCsv("a\n" + "1\n".repeat(11), { maxRows: 10 }), { ok: false, error: "too_many_rows" });
  assert.deepEqual(parseCsv("a".repeat(100), { maxBytes: 10 }), { ok: false, error: "too_large" });
});

test("CSV export neutralizes formula injection", () => {
  assert.equal(escapeCsvCell("=HYPERLINK(\"http://evil\")"), "\"'=HYPERLINK(\"\"http://evil\"\")\"");
  assert.equal(escapeCsvCell("+97455550001"), "'+97455550001");
  assert.equal(escapeCsvCell("-5"), "'-5");
  assert.equal(escapeCsvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(escapeCsvCell("plain"), "plain");
  assert.equal(escapeCsvCell(null), "");
});

test("CSV export round-trips through the parser and starts with a BOM", () => {
  const out = toCsv(["a", "b"], [["x,y", 'q"uote'], ["سطر\nجديد", 3]]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  const back = parseCsv(out);
  assert.equal(back.ok, true);
  if (back.ok) assert.deepEqual(back.rows, [["x,y", 'q"uote'], ["سطر\nجديد", "3"]]);
});

// --------------------------------------------------------------- periods
test("'today' depends on the company's time zone", () => {
  const instant = new Date("2026-09-30T21:30:00Z"); // 00:30 Oct 1 in Qatar, 23:30 Sep 30 in Cairo (UTC+2)... check below
  assert.equal(localDate(instant, "Asia/Qatar"), "2026-10-01");
  assert.equal(localDate(instant, "UTC"), "2026-09-30");
  assert.deepEqual(resolvePeriod("today", instant, "Asia/Qatar"), { from: "2026-10-01", to: "2026-10-01" });
});

test("presets resolve to inclusive local date ranges", () => {
  const now = new Date("2026-10-19T09:00:00Z"); // Monday 19 Oct 2026 in Qatar
  const tz = "Asia/Qatar";
  assert.deepEqual(resolvePeriod("yesterday", now, tz), { from: "2026-10-18", to: "2026-10-18" });
  assert.deepEqual(resolvePeriod("last_7_days", now, tz), { from: "2026-10-13", to: "2026-10-19" });
  assert.deepEqual(resolvePeriod("this_week", now, tz, 0), { from: "2026-10-18", to: "2026-10-19" }, "week starts Sunday");
  assert.deepEqual(resolvePeriod("this_week", now, tz, 6), { from: "2026-10-17", to: "2026-10-19" }, "week starts Saturday");
  assert.deepEqual(resolvePeriod("this_month", now, tz), { from: "2026-10-01", to: "2026-10-19" });
  assert.deepEqual(resolvePeriod("last_month", now, tz), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(resolvePeriod("last_month", new Date("2026-03-10T09:00:00Z"), tz), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(resolvePeriod("last_month", new Date("2026-01-10T09:00:00Z"), tz), { from: "2025-12-01", to: "2025-12-31" });
});

test("custom ranges are validated", () => {
  assert.deepEqual(parseCustomRange("2026-09-01", "2026-09-30"), { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(parseCustomRange("2026-09-30", "2026-09-01"), null, "reversed");
  assert.equal(parseCustomRange("2026-02-31", "2026-03-01"), null, "impossible date");
  assert.equal(parseCustomRange("2025-01-01", "2026-09-01"), null, "longer than a year");
  assert.equal(parseCustomRange("2026-9-1", "2026-09-30"), null, "bad format");
});

// ---------------------------------------------------------------- errors
test("database rule keys map to Arabic messages; raw database text never leaks", () => {
  assert.equal(errorKey({ message: "shift.not_found" }), "shift.not_found");
  assert.equal(userMessage({ message: "shift.not_found" }), "لا يوجد شيفت مفتوح لهذا الموظف.");
  assert.equal(userMessage({ message: "shift.not_found" }, "en"), "This employee has no open shift.");
  assert.equal(errorKey({ message: 'new row violates row-level security policy for table "leads"' }), "auth.forbidden");
  assert.equal(errorKey({ message: 'duplicate key value violates unique constraint "x" Key (phone)=(+974...)' }), "generic");
  assert.equal(errorKey(new Error("not.a.known.key")), "generic");
  assert.equal(errorKey(undefined), "generic");
});

test("every user-facing error key raised by the database has a localized message", () => {
  const dir = join(import.meta.dirname, "../../supabase/migrations");
  const keys = new Set<string>();
  for (const f of readdirSync(dir)) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const m of sql.matchAll(/raise exception '([a-z_]+(?:\.[a-z_]+)+)'/g)) keys.add(m[1]);
  }
  // Keys that can only be hit by internal/maintenance code paths, never by a
  // user action through the UI.
  // Deals are no longer part of the application; the (empty) database objects can still raise their keys, which no screen can reach.
  const internal = new Set([
    "audit.immutable", "notification.only_read_state_editable", "profile.immutable_field", "profile.email_managed_by_auth",
    "company.immutable_field", "company.super_admin_only_field", "membership.immutable_field", "team.immutable_field",
    "team.manager_must_be_manager", "team.member_must_belong_to_company", "contact.immutable_field",
    "contact.merge_via_rpc_only", "contact.merged_is_read_only", "contact_company.immutable_field",
    "contact_company.owner_must_be_member", "contact_company.owner_change_forbidden", "pipeline.lead_stages_must_be_open",
    "pipeline.stage_type_in_use", "lead.created_by_required", "lead.immutable_field", "lead.stage_not_in_company_lead_pipeline",
    "deal.created_by_required", "deal.immutable_field", "deal.contact_not_accessible", "deal.lead_not_accessible",
    "deal.owner_must_be_member", "deal.loss_reason_required", "deal.no_pipeline", "deal.owner_change_forbidden", "deal.reopen_requires_manager",
    "deal.stage_inactive", "deal.stage_not_in_pipeline", "deal.won_amount_requires_manager", "lead.convert_via_rpc_only",
    "task.created_by_required", "task.immutable_field", "task.lead_not_accessible",
    "task.deal_not_accessible", "task.contact_not_accessible", "task.assignee_must_be_member",
    "activity.lead_not_accessible", "activity.deal_not_accessible", "activity.contact_not_accessible", "activity.immutable_field",
    "target.immutable_field", "target.user_must_be_member", "conversation.immutable_field", "conversation.system_field",
    "conversation.unread_can_only_be_cleared", "conversation.company_change_forbidden", "message.immutable_field",
    "message.request_id_conflict", "whatsapp.invalid_payload", "whatsapp.unknown_phone_number_id", "webhook.invalid_status",
    "contact.merge_same", "contact.not_found", "review.not_found", "rate_limit.invalid_arguments", "import.invalid_batch", "job.unknown",
    // Kapso / webhook processing (970-979): raised while a delivery is processed by the service role, stored as the event's error code, never shown to a person
    "kapso.account_not_production", "kapso.contact_moved", "kapso.conversation_not_found", "kapso.echo_identity_conflict", "kapso.echo_unattributed",
    "kapso.identity_conflict", "kapso.origin_not_ingestable", "webhook.claim_conflict", "webhook.event_not_found", "webhook.invalid_event_key",
    "webhook.invalid_payload_kind", "webhook.invalid_reason", "webhook.payload_too_large", "whatsapp.isolation_unsupported",
    // workshop price history is written by the price setter only; no screen edits it
    "price.history_immutable",
    // history sync (997): service role only, the app sends well-formed batches
    // pairing is a super-admin data step (service role); an invalid pair never comes from a screen
    "workshop.sharing_invalid_pair",
    "kapso.invalid_history_rows", "kapso.history_batch_too_large", "kapso.invalid_history_row",
  ]);
  const missing = [...keys].filter((k) => !internal.has(k) && !hasMessage(k)).sort();
  assert.deepEqual(missing, [], `add messages to src/lib/errors.ts for: ${missing.join(", ")}`);
});

// ---------------------------------------------------------------- format
test("formatting uses Latin digits and treats missing data as missing, not zero", () => {
  assert.equal(formatNumber(1234.5), "1,234.5");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(0.75, "en"), "75%");
  assert.match(formatCurrency(1800, "QAR", "en"), /QAR\s?1,800/);
  assert.match(formatCurrency(1800, "QAR"), /1,800/);
  assert.equal(formatDuration(600, "en"), "10m");
  assert.equal(formatDuration(3725, "en"), "1h 2m");
  assert.equal(formatDuration(null), "—");
});
