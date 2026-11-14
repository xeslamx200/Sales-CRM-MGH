import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HIDEABLE_PAGES, PERMISSION_KEYS, parseDenied, sectionOf } from "../../src/lib/permissions.ts";

test("custom roles: only the switches stored as false are denials; anything else (absent, true, garbage) is allowed", () => {
  assert.deepEqual(parseDenied({ export_data: false, record_payments: false, send_messages: true }), ["record_payments", "export_data"]);
  assert.deepEqual(parseDenied({}), []);
  assert.deepEqual(parseDenied(null), []);
  assert.deepEqual(parseDenied("x"), []);
  assert.deepEqual(parseDenied({ unknown_key: false, export_data: "false" }), []);
});

test("custom roles: payments and customer payments belong to the Bookings section of the menu", () => {
  assert.equal(sectionOf("/payments"), "/bookings");
  assert.equal(sectionOf("/payments/new"), "/bookings");
  assert.equal(sectionOf("/customer-payments"), "/bookings");
  assert.equal(sectionOf("/bookings/abc"), "/bookings");
  assert.equal(sectionOf("/leads/import"), "/leads");
  assert.equal(sectionOf("/reports"), "/reports");
});

test("custom roles: the keys the application knows are exactly the ones the database function accepts", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261104001006_company_roles.sql", import.meta.url), "utf8");
  const grab = (name: string) => [...(new RegExp(`${name} text\\[\\] := array\\[([^\\]]*)\\]`).exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(grab("v_allowed_perm"), [...PERMISSION_KEYS]);
  assert.deepEqual(grab("v_allowed_nav"), [...HIDEABLE_PAGES]);
});

test("custom roles: every protected action asks requirePermission, and every hideable section has its guard layout", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  for (const [file, key] of [
    ["src/server/whatsapp/send.ts", "send_messages"], ["src/actions/leads.ts", "create_leads"], ["src/actions/inbox.ts", "create_leads"], ["src/actions/import.ts", "import_leads"],
    ["src/actions/bookings.ts", "create_bookings"], ["src/actions/bookings.ts", "record_payments"], ["src/actions/payments.ts", "record_payments"],
  ] as const) assert.ok(new RegExp(`requirePermission\\([^)]*"${key}"\\)`).test(read(file)), `${file} checks ${key}`);
  for (const seg of ["inbox", "leads", "contacts", "bookings", "workshops", "performance", "tasks", "reports", "payments", "customer-payments"]) {
    assert.ok(read(`src/app/(app)/${seg}/layout.tsx`).includes("guardSection"), `${seg} has its guard layout`);
  }
  for (const r of ["leads", "customer-payments", "workshop/[id]"]) assert.ok(read(`src/app/api/export/${r}/route.ts`).includes('"export_data"'), `export ${r} checks export_data`);
});
