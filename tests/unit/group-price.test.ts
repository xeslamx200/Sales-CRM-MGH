import { test } from "node:test";
import assert from "node:assert/strict";
import { workshopGroupSchema } from "../../src/schemas/workshops.ts";

const ID = "7c1f6c3e-6b0e-4a43-9d2b-1f0a5d7c9e11";
const base = { offeringId: ID, name: "Ali", sessions: "2026-12-06", capacity: "", attendance: "", isActive: true };

test("a group has no own price unless given", () => {
  const r = workshopGroupSchema.parse(base);
  assert.equal(r.groupPrice, null);
  assert.equal(r.groupCurrency, null);
  const e = workshopGroupSchema.parse({ ...base, groupPrice: "", groupCurrency: "" });
  assert.equal(e.groupPrice, null);
});

test("a group price comes with a currency, both or neither", () => {
  const ok = workshopGroupSchema.parse({ ...base, groupPrice: "900.50", groupCurrency: "qar" });
  assert.equal(ok.groupPrice, 900.5);
  assert.equal(ok.groupCurrency, "QAR");
  assert.equal(workshopGroupSchema.safeParse({ ...base, groupPrice: "900" }).success, false);
  assert.equal(workshopGroupSchema.safeParse({ ...base, groupCurrency: "QAR" }).success, false);
});

test("a group price is a positive amount with two decimals at most", () => {
  for (const bad of ["0", "-5", "1.234", "abc"]) assert.equal(workshopGroupSchema.safeParse({ ...base, groupPrice: bad, groupCurrency: "QAR" }).success, false, bad);
});
