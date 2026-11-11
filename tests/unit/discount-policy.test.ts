import { test } from "node:test";
import assert from "node:assert/strict";
import { appliesImmediately, discountAmount, effectivePercent, previewBooking, requiredLevel } from "../../src/lib/discount-policy.ts";

test("policy: percent boundaries 10 / 25 / 100", () => {
  const c: [number, string][] = [[0.01, "employee"], [5, "employee"], [10, "employee"], [10.01, "manager"], [25, "manager"], [25.01, "admin"], [99.99, "admin"], [100, "admin"]];
  for (const [v, level] of c) assert.equal(requiredLevel("percent", v, 1000), level, `${v} %`);
  assert.equal(requiredLevel("percent", 0, 1000), "none");
  assert.equal(requiredLevel("none", 0, 1000), "none");
});

test("policy: a fixed discount is judged by its effective percentage of the ORIGINAL price (exact, no rounding down)", () => {
  assert.equal(requiredLevel("fixed", 100, 1000), "employee");        // exactly 10 %
  assert.equal(requiredLevel("fixed", 100.01, 1000), "manager");      // 10.001 %
  assert.equal(requiredLevel("fixed", 250, 1000), "manager");         // exactly 25 %
  assert.equal(requiredLevel("fixed", 250.01, 1000), "admin");
  assert.equal(requiredLevel("fixed", 1000, 1000), "admin");          // 100 %
  assert.equal(requiredLevel("fixed", 50, 500), "employee");          // the same 10 % on another price
  assert.equal(requiredLevel("fixed", 133.33, 1333.33), "employee");  // 9.9999... %
  assert.equal(requiredLevel("fixed", 133.34, 1333.33), "manager");
  assert.equal(effectivePercent("fixed", 333.33, 1000), 33.333);
  assert.equal(effectivePercent("percent", 12.5, 1000), 12.5);
});

test("policy: amounts match the database (round half up on exact cents)", () => {
  assert.equal(discountAmount("percent", 10.01, 1000), 100.1);
  assert.equal(discountAmount("percent", 33.33, 750), 249.98);   // 249.975 -> 249.98
  assert.equal(discountAmount("fixed", 99.99, 1000), 99.99);
  assert.equal(discountAmount("none", 0, 1000), 0);
});

test("policy: only none / employee apply immediately", () => {
  assert.deepEqual((["none", "employee", "manager", "admin"] as const).map(appliesImmediately), [true, true, false, false]);
});

test("preview: original, discount, final, level; invalid values are flagged", () => {
  assert.deepEqual(previewBooking(1000, "percent", 10), { list: 1000, discount: 100, final: 900, level: "employee", percent: 10, valid: true });
  assert.deepEqual(previewBooking(1000, "fixed", 300), { list: 1000, discount: 300, final: 700, level: "admin", percent: 30, valid: true });
  assert.equal(previewBooking(1000, "none", null)?.final, 1000);
  assert.equal(previewBooking(1000, "fixed", 1000.01)?.valid, false);
  assert.equal(previewBooking(1000, "percent", 100.01)?.valid, false);
  assert.equal(previewBooking(1000, "percent", 0)?.valid, false);
  assert.equal(previewBooking(1000, "percent", null)?.valid, false);
  assert.equal(previewBooking(1000, "fixed", 10.123)?.valid, false);
  assert.equal(previewBooking(null, "none", null), null);
});
