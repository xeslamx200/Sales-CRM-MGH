import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionDates, countryName, WORKSHOP_COUNTRIES } from "../../src/lib/workshop-config.ts";
import { workshopGroupSchema, workshopPriceSchema } from "../../src/schemas/workshops.ts";

const OID = "11111111-1111-4111-8111-111111111111";

test("session dates: one per line, sorted, de-duplicated, Arabic digits and separators accepted", () => {
  assert.deepEqual(parseSessionDates("2026-12-08\n2026-12-06\n2026-12-07\n2026-12-06"), ["2026-12-06", "2026-12-07", "2026-12-08"]);
  assert.deepEqual(parseSessionDates("٢٠٢٦-١٢-٠٦، 2026-12-07"), ["2026-12-06", "2026-12-07"]);
});

test("session dates: anything that is not a real calendar date is refused", () => {
  assert.equal(parseSessionDates(""), null);
  assert.equal(parseSessionDates("6 December"), null);
  assert.equal(parseSessionDates("2026-02-30"), null);
  assert.equal(parseSessionDates("2026-13-01"), null);
  assert.equal(parseSessionDates("2026-12-06 tomorrow"), null);
  assert.equal(parseSessionDates(Array.from({ length: 61 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}-x${i}`).join(" ")), null);
});

test("price schema: positive, at most 2 decimals, 2-letter country, 3-letter currency, online|offline", () => {
  const ok = workshopPriceSchema.safeParse({ offeringId: OID, country: "qa", attendance: "online", currency: "QAR", price: "1,500.50" });
  assert.equal(ok.success && ok.data.price, 1500.5);
  for (const bad of [{ price: "" }, { price: "0" }, { price: "-5" }, { price: "10.123" }, { price: "abc" }, { country: "QAT" }, { currency: "QR" }, { attendance: "hybrid" }]) {
    assert.equal(workshopPriceSchema.safeParse({ offeringId: OID, country: "QA", attendance: "online", currency: "QAR", price: "100", ...bad }).success, false, JSON.stringify(bad));
  }
});

test("group schema: text sessions become a sorted list; capacity is a positive whole number or empty; empty attendance = both", () => {
  const ok = workshopGroupSchema.safeParse({ offeringId: OID, name: " Group 1 ", sessions: "2026-12-07\n2026-12-06", capacity: "20", attendance: "", isActive: true });
  assert.ok(ok.success);
  if (ok.success) { assert.deepEqual(ok.data.sessions, ["2026-12-06", "2026-12-07"]); assert.equal(ok.data.capacity, 20); assert.equal(ok.data.attendance, null); assert.equal(ok.data.name, "Group 1"); }
  assert.equal(workshopGroupSchema.safeParse({ offeringId: OID, name: "G", sessions: "2026-12-06", capacity: "", attendance: "online", isActive: true }).success, true);
  for (const bad of [{ capacity: "0" }, { capacity: "2.5" }, { capacity: "abc" }, { sessions: "" }, { sessions: "soon" }, { name: " " }]) {
    assert.equal(workshopGroupSchema.safeParse({ offeringId: OID, name: "G", sessions: "2026-12-06", capacity: "5", attendance: "", isActive: true, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("country list: the owner's countries (and the GCC set) with their currencies", () => {
  assert.deepEqual(WORKSHOP_COUNTRIES.map((c) => `${c.code}:${c.currency}`), ["QA:QAR", "SA:SAR", "BH:BHD", "KW:KWD", "AE:AED", "OM:OMR", "EG:EGP"]);
  assert.equal(countryName("QA", "en"), "Qatar");
  assert.equal(countryName("ZZ", "ar"), "ZZ");
});
