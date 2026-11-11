import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, compactMoney, dayPart, daysBetween, deltaPct, previousRange } from "../../src/lib/dashboard-math.ts";

test("the previous period has the same length and ends the day before", () => {
  assert.deepEqual(previousRange("2026-11-04", "2026-11-10"), { from: "2026-10-28", to: "2026-11-03" });
  assert.deepEqual(previousRange("2026-11-10", "2026-11-10"), { from: "2026-11-09", to: "2026-11-09" });
  assert.deepEqual(previousRange("2026-03-01", "2026-03-31"), { from: "2026-01-29", to: "2026-02-28" });
});

test("days between is inclusive and crosses month ends", () => {
  assert.deepEqual(daysBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.equal(daysBetween("2026-11-10", "2026-11-10").length, 1);
});

test("delta is a percentage of the previous value and absent without one", () => {
  assert.equal(deltaPct(150, 100), 50);
  assert.equal(deltaPct(50, 100), -50);
  assert.equal(deltaPct(10, 0), null);
  assert.equal(deltaPct(Number.NaN, 5), null);
});

test("a workshop keeps its colour whatever its rank or the filter", () => {
  const ids = ["b", "a", "c"];
  assert.equal(colorFor("a", ids), colorFor("a", ["c", "a", "b"]));
  assert.notEqual(colorFor("a", ids), colorFor("b", ids));
});

test("money is compact only when large, always with the currency code and Latin digits", () => {
  assert.equal(compactMoney(2730, "QAR", "en"), "QAR 2,730");
  assert.equal(compactMoney(48200, "QAR", "en"), "QAR 48.2K");
  assert.match(compactMoney(2730, "QAR", "ar"), /QAR/);
});

test("greeting follows the company's own time zone", () => {
  const noon = new Date("2026-11-10T09:30:00Z"); // 12:30 in Qatar, 11:30 in Cairo (UTC+2 in winter)
  assert.equal(dayPart(noon, "Asia/Qatar"), "afternoon");
  assert.equal(dayPart(noon, "Africa/Cairo"), "morning");
  assert.equal(dayPart(new Date("2026-11-10T16:00:00Z"), "Asia/Qatar"), "evening");
});
