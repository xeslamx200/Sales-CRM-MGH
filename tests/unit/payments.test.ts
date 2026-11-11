import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPaymentSchema, paymentSchema, reviewSchema, searchSchema } from "../../src/schemas/payments.ts";
import { hasMessage, userMessage } from "../../src/lib/errors.ts";
import { ar } from "../../src/i18n/ar.ts";
import { en } from "../../src/i18n/en.ts";

const OFFERING = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const base = { offeringId: OFFERING, contactId: CONTACT, amount: "100", currency: "USD", kind: "partial" };

test("payment schema: a valid payment with an existing customer", () => {
  const r = paymentSchema.safeParse({ ...base, paidOn: "2026-11-08", note: "  transfer  " });
  assert.equal(r.success, true);
  if (r.success) assert.deepEqual([r.data.amount, r.data.currency, r.data.kind, r.data.note, r.data.contactId], [100, "USD", "partial", "transfer", CONTACT]);
});

test("payment schema: amounts - positive, at most 2 decimals, Arabic digits and separators accepted", () => {
  const ok = (v: unknown) => { const r = paymentSchema.safeParse({ ...base, amount: v }); return r.success ? r.data.amount : null; };
  assert.equal(ok("1,250.50"), 1250.5);
  assert.equal(ok("٢٥٠٠"), 2500);
  assert.equal(ok(0.01), 0.01);
  assert.equal(ok(" 75 "), 75);
  assert.equal(ok("٢٬٥٠٠٫٥٠"), 2500.5, "Arabic thousands / decimal marks");
  assert.equal(ok("1,000"), 1000);
  assert.equal(ok("1000.5"), 1000.5);
  for (const bad of ["0", "-5", "", "abc", "10.123", "1e9999", 1_000_000_001, NaN, null, undefined, "12,5,5", "1,00", "12,34", ",5", "1.2.3", "1,2345", "10,000,00"]) assert.equal(ok(bad), null, String(bad));
});

test("payment schema: currency is one of the offered list; kind is partial or full", () => {
  for (const c of ["EGP", "USD", "EUR", "SAR", "AED", "KWD"]) assert.equal(paymentSchema.safeParse({ ...base, currency: c }).success, true, c);
  for (const c of ["usd", "XYZ", "", "BTC", "EGP "]) assert.equal(paymentSchema.safeParse({ ...base, currency: c }).success, false, c);
  assert.equal(paymentSchema.safeParse({ ...base, kind: "full" }).success, true);
  assert.equal(paymentSchema.safeParse({ ...base, kind: "half" }).success, false);
});

test("payment schema: the customer is an existing contact OR a new name + phone (never neither)", () => {
  const { contactId: _c, ...noContact } = base; void _c;
  assert.equal(paymentSchema.safeParse(noContact).success, false);
  assert.equal(paymentSchema.safeParse({ ...noContact, newName: "Sara" }).success, false, "a name alone is not enough");
  assert.equal(paymentSchema.safeParse({ ...noContact, newPhone: "01012345678" }).success, false, "a phone alone is not enough");
  assert.equal(paymentSchema.safeParse({ ...noContact, newName: "Sara", newPhone: "01012345678" }).success, true);
  assert.equal(paymentSchema.safeParse({ ...base, contactId: "" }).success, false, "an empty id counts as no customer");
  assert.equal(paymentSchema.safeParse({ ...base, contactId: "not-a-uuid" }).success, false);
});

test("payment schema: nothing the database decides can be supplied (company, rate, EGP total, status, creator are ignored)", () => {
  const r = paymentSchema.safeParse({ ...base, companyId: "x", fxRateToEgp: 1, amountEgp: 999999, status: "confirmed", createdBy: CONTACT });
  assert.equal(r.success, true);
  if (r.success) for (const k of ["companyId", "fxRateToEgp", "amountEgp", "status", "createdBy"]) assert.equal(k in r.data, false, k);
});

test("payment schema: the client builds it with localized messages", () => {
  const s = buildPaymentSchema({ amount: "AMOUNT-MSG", customer: "CUSTOMER-MSG" });
  const bad = s.safeParse({ ...base, contactId: "", amount: "0" });
  assert.equal(bad.success, false);
  if (!bad.success) assert.deepEqual(bad.error.issues.map((i) => i.message).sort(), ["AMOUNT-MSG"], "customer check runs only when the base shape is valid");
  const noCustomer = s.safeParse({ ...base, contactId: "" });
  if (!noCustomer.success) assert.deepEqual(noCustomer.error.issues.map((i) => i.message), ["CUSTOMER-MSG"]);
  else assert.fail("should fail");
});

test("review / search schemas", () => {
  assert.equal(reviewSchema.safeParse({ id: CONTACT, decision: "confirmed" }).success, true);
  assert.equal(reviewSchema.safeParse({ id: CONTACT, decision: "rejected", note: "x" }).success, true);
  assert.equal(reviewSchema.safeParse({ id: CONTACT, decision: "pending" }).success, false);
  assert.equal(reviewSchema.safeParse({ id: "x", decision: "confirmed" }).success, false);
  assert.equal(searchSchema.safeParse({ companyId: CONTACT, q: "a" }).success, false, "at least 2 characters");
  assert.equal(searchSchema.safeParse({ companyId: CONTACT, q: "sa" }).success, true);
});

test("every payment.* rule the database raises has a user message in Arabic AND English", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261104000980_payments.sql", import.meta.url), "utf8");
  const codes = new Set([...sql.matchAll(/raise exception '(payment\.[a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 14, `found ${codes.size} codes`);
  // payment.invalid_rates is raised only for the service-role rate writer; never shown to a user
  for (const c of codes) {
    if (c === "payment.invalid_rates") continue;
    assert.ok(hasMessage(c), `${c} has no message`);
    assert.notEqual(userMessage({ message: c }, "ar"), userMessage({ message: "nope" }, "ar"), `${c} (ar)`);
    assert.notEqual(userMessage({ message: c }, "en"), userMessage({ message: "nope" }, "en"), `${c} (en)`);
  }
});

test("payments strings exist with the same shape in both languages", () => {
  const keys = (o: Record<string, unknown>): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? keys(v as Record<string, unknown>).map((x) => `${k}.${x}`) : [k]));
  assert.deepEqual(keys(ar.payments).sort(), keys(en.payments).sort());
  assert.ok(keys(ar.payments).length > 70);
  for (const [k, v] of Object.entries(ar.payments)) if (typeof v === "string") assert.ok(v.length > 0, k);
  assert.ok(ar.nav.payments && en.nav.payments && ar.offerings.price && en.offerings.price);
});
