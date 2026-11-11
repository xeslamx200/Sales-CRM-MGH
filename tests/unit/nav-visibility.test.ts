import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenNavFor, usesWorkshopRevenue } from "../../src/lib/nav-visibility.ts";

test("nothing is hidden from the menu by default", () => {
  assert.deepEqual(hiddenNavFor("mgh"), []);
  assert.deepEqual(hiddenNavFor("other-company"), []);
  assert.deepEqual(hiddenNavFor(null), []);
  assert.deepEqual(hiddenNavFor(undefined), []);
});

test("MGH shows booking revenue on the dashboard by default; other companies do not", () => {
  assert.equal(usesWorkshopRevenue("mgh"), true);
  assert.equal(usesWorkshopRevenue("nahj"), true);
  assert.equal(usesWorkshopRevenue("other-company"), false);
  assert.equal(usesWorkshopRevenue(null), false);
});
