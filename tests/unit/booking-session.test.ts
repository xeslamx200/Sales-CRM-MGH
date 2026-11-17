import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingSchema } from "../../src/schemas/bookings.ts";
import { workshopPriceSchema } from "../../src/schemas/workshops.ts";

const ID = "7c1f6c3e-6b0e-4a43-9d2b-1f0a5d7c9e11";
const base = { contactId: ID, groupId: ID, country: "QA", attendance: "online", discountType: "none", paidNow: "0" };

test("a booking is the whole workshop unless it says otherwise", () => {
  const r = bookingSchema.parse(base);
  assert.equal(r.kind, "full");
  assert.ok(!r.sessionDate);
});

test("a single-session booking needs its date", () => {
  assert.equal(bookingSchema.safeParse({ ...base, kind: "session" }).success, false);
  const ok = bookingSchema.parse({ ...base, kind: "session", sessionDate: "2026-12-06" });
  assert.equal(ok.kind, "session");
  assert.equal(ok.sessionDate, "2026-12-06");
});

test("an unknown kind is refused and the repeat confirmation is optional", () => {
  assert.equal(bookingSchema.safeParse({ ...base, kind: "weekly" }).success, false);
  assert.equal(bookingSchema.parse({ ...base, confirmRepeat: true }).confirmRepeat, true);
  assert.equal(bookingSchema.parse(base).confirmRepeat, undefined);
});

test("the single-session price is optional on a workshop price, and validated when given", () => {
  const p = { offeringId: ID, country: "QA", attendance: "online", currency: "QAR", price: "500" };
  assert.equal(workshopPriceSchema.parse(p).sessionPrice, null);
  assert.equal(workshopPriceSchema.parse({ ...p, sessionPrice: "" }).sessionPrice, null);
  assert.equal(workshopPriceSchema.parse({ ...p, sessionPrice: "150.50" }).sessionPrice, 150.5);
  assert.equal(workshopPriceSchema.safeParse({ ...p, sessionPrice: "-5" }).success, false);
  assert.equal(workshopPriceSchema.safeParse({ ...p, sessionPrice: "1.234" }).success, false);
});
