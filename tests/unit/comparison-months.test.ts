import { test } from "node:test";
import assert from "node:assert/strict";
import { lastSixMonths } from "../../src/lib/dashboard-math.ts";

test("comparison: the six months end with the month of the period end and handle year boundaries and leap years", () => {
  const m = lastSixMonths("2026-11-11");
  assert.deepEqual(m.map((x) => x.key), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.equal(m[0].from, "2026-06-01"); assert.equal(m[0].to, "2026-06-30");
  assert.equal(m[5].from, "2026-11-01"); assert.equal(m[5].to, "2026-11-30");
  const y = lastSixMonths("2026-02-10");
  assert.deepEqual(y.map((x) => x.key), ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(y[5].to, "2026-02-28");
  assert.equal(lastSixMonths("2024-02-29")[5].to, "2024-02-29", "leap year");
});

