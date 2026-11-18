import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingSchema, editBookingSchema, editPaymentSchema } from "../../src/schemas/bookings.ts";
import { workshopPriceSchema } from "../../src/schemas/workshops.ts";

const ID = "7c1f6c3e-6b0e-4a43-9d2b-1f0a5d7c9e11";
const base = { contactId: ID, groupId: ID, country: "QA", attendance: "online", price: "500", currency: "QAR" };

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

test("the employee types the price and the currency; there is no discount any more", () => {
  const r = bookingSchema.parse(base);
  assert.equal(r.price, 500);
  assert.equal(r.currency, "QAR");
  assert.equal(r.paymentMode, "full");
  assert.equal(r.discountType, "none");
  for (const bad of [{ price: "" }, { price: "0" }, { price: "12.345" }, { price: "abc" }, { currency: "QA" }, { currency: "" }]) {
    assert.equal(bookingSchema.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("a deposit needs the amount paid (below the price) and the reminder day", () => {
  const dep = { ...base, paymentMode: "deposit", paidNow: "200", remindOn: "2026-12-20" };
  const ok = bookingSchema.parse(dep);
  assert.equal(ok.paymentMode, "deposit");
  assert.equal(ok.paidNow, 200);
  assert.equal(ok.remindOn, "2026-12-20");
  assert.equal(bookingSchema.safeParse({ ...dep, remindOn: "" }).success, false, "no reminder day");
  assert.equal(bookingSchema.safeParse({ ...dep, paidNow: "" }).success, false, "no deposit amount");
  assert.equal(bookingSchema.safeParse({ ...dep, paidNow: "0" }).success, false, "zero deposit");
  assert.equal(bookingSchema.safeParse({ ...dep, paidNow: "500" }).success, false, "deposit equal to the price is a full payment");
  assert.equal(bookingSchema.safeParse({ ...dep, paidNow: "600" }).success, false, "deposit above the price");
  assert.equal(bookingSchema.safeParse({ ...base, paymentMode: "monthly" }).success, false);
});

test("a correction of a booking needs a valid price and a reason (and a reminder day for a deposit)", () => {
  const ok = { bookingId: ID, price: "1200", currency: "egp", paymentMode: "full", remindOn: "", reason: "typo in the price" };
  const r = editBookingSchema.parse(ok);
  assert.equal(r.price, 1200);
  assert.equal(r.paymentMode, "full");
  for (const bad of [{ price: "" }, { price: "0" }, { price: "1.234" }, { currency: "EG" }, { reason: "" }, { reason: "ab" }, { paymentMode: "deposit" }, { paymentMode: "monthly" }]) {
    assert.equal(editBookingSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(editBookingSchema.safeParse({ ...ok, paymentMode: "deposit", remindOn: "2026-12-20" }).success, true);
});

test("a correction of a payment needs a valid amount and a reason", () => {
  const ok = { bookingId: ID, paymentId: ID, amount: "450.50", reason: "receipt says 450.50" };
  assert.equal(editPaymentSchema.parse(ok).amount, 450.5);
  for (const bad of [{ amount: "" }, { amount: "0" }, { amount: "-5" }, { amount: "abc" }, { reason: " " }, { reason: "x" }]) {
    assert.equal(editPaymentSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("a booking correction can carry the amounts of its payments", () => {
  const ok = { bookingId: ID, price: "1800", currency: "QAR", paymentMode: "full", remindOn: "", reason: "typo", payments: [{ paymentId: ID, amount: "1450.50" }] };
  assert.equal(editBookingSchema.parse(ok).payments[0].amount, 1450.5);
  assert.deepEqual(editBookingSchema.parse({ ...ok, payments: undefined }).payments, []);
  assert.equal(editBookingSchema.safeParse({ ...ok, payments: [{ paymentId: ID, amount: "0" }] }).success, false);
  assert.equal(editBookingSchema.safeParse({ ...ok, payments: [{ paymentId: "x", amount: "10" }] }).success, false);
});
