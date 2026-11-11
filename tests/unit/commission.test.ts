import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTierDrafts, commissionOf, nextTier, parseMonth, shiftMonth, tierFor, type Tier } from "../../src/lib/commission.ts";

const tiers: Tier[] = [{ min: 0.8, rate: 0.03 }, { min: 1, rate: 0.06 }];

test("commission tierFor: highest tier reached; below the first = none; exact threshold counts", () => {
  assert.equal(tierFor(tiers, null), null, "no target => no attainment => no tier");
  assert.equal(tierFor(tiers, 0), null);
  assert.equal(tierFor(tiers, 0.79), null);
  assert.deepEqual(tierFor(tiers, 0.8), { min: 0.8, rate: 0.03 });
  assert.deepEqual(tierFor(tiers, 0.9999), { min: 0.8, rate: 0.03 });
  assert.deepEqual(tierFor(tiers, 1), { min: 1, rate: 0.06 });
  assert.deepEqual(tierFor(tiers, 2.5), { min: 1, rate: 0.06 });
  assert.equal(tierFor([], 5), null);
  assert.deepEqual(tierFor([...tiers].reverse(), 1.2), { min: 1, rate: 0.06 }, "input order does not matter");
});

test("commission nextTier: what is still missing for the next tier", () => {
  assert.deepEqual(nextTier(tiers, 10000, 0), { tier: tiers[0], missingEgp: 8000 });
  assert.deepEqual(nextTier(tiers, 10000, 7000), { tier: tiers[0], missingEgp: 1000 });
  assert.deepEqual(nextTier(tiers, 10000, 8000), { tier: tiers[1], missingEgp: 2000 }, "reached the first tier: the next is the second");
  assert.equal(nextTier(tiers, 10000, 10000), null, "already at the top");
  assert.equal(nextTier(tiers, null, 500), null, "no target");
  assert.equal(nextTier(tiers, 0, 500), null);
  assert.equal(nextTier([], 10000, 0), null);
  assert.equal(nextTier(tiers, 3333.33, 100)!.missingEgp, 2566.66, "rounded to cents");
});

test("commission commissionOf: whole amount x rate, 2 decimals", () => {
  assert.equal(commissionOf(8000, 0.03), 240);
  assert.equal(commissionOf(10000, 0.06), 600);
  assert.equal(commissionOf(333.33, 0.03), 10);
  assert.equal(commissionOf(0, 0.06), 0);
  assert.equal(commissionOf(1234.56, 0), 0);
});

test("commission editor: percentages become fractions and follow the database rules", () => {
  const ok = checkTierDrafts([{ minPercent: "100", ratePercent: "6" }, { minPercent: "80", ratePercent: "3" }]);
  assert.deepEqual(ok, { ok: true, tiers });
  assert.deepEqual(checkTierDrafts([{ minPercent: "٨٠", ratePercent: "٣٫٥" }]), { ok: true, tiers: [{ min: 0.8, rate: 0.035 }] }, "Arabic digits and decimal mark");
  assert.deepEqual(checkTierDrafts([{ minPercent: "80 %", ratePercent: "3%" }]), { ok: true, tiers: [{ min: 0.8, rate: 0.03 }] });
  assert.deepEqual(checkTierDrafts([]), { ok: true, tiers: [] }, "no tiers = no commission (allowed)");
  assert.deepEqual(checkTierDrafts([{ minPercent: "0", ratePercent: "1" }]), { ok: true, tiers: [{ min: 0, rate: 0.01 }] }, "a tier from 0% pays from the first pound");
  const bad = (rows: Array<[string, string]>) => (checkTierDrafts(rows.map(([a, b]) => ({ minPercent: a, ratePercent: b }))) as { ok: false; reason: string }).reason;
  assert.equal(bad([["80", "6"], ["100", "3"]]), "rate_order", "a higher achievement can never pay a lower rate");
  assert.equal(bad([["80", "3"], ["80", "4"]]), "order", "duplicate threshold");
  assert.equal(bad([["", "3"]]), "empty_row");
  assert.equal(bad([["80", ""]]), "empty_row");
  assert.equal(bad([["abc", "3"]]), "invalid_number");
  assert.equal(bad([["-5", "3"]]), "invalid_number");
  assert.equal(bad([["80", "101"]]), "invalid_number", "a rate above 100% is refused");
  assert.equal(bad(Array.from({ length: 13 }, (_, i) => [String(i * 10), "1"] as [string, string])), "too_many");
});

test("commission months: only YYYY-MM is accepted; shifting crosses years", () => {
  assert.equal(parseMonth("2026-11"), "2026-11-01");
  for (const bad of [null, undefined, "", "2026-13", "2026-00", "26-11", "2026-1", "2026-11-05", "1999-12", "2101-01", "abcd-ef"]) assert.equal(parseMonth(bad as string), null, String(bad));
  assert.equal(shiftMonth("2026-11-01", 1), "2026-12-01");
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-01-01", -1), "2025-12-01");
  assert.equal(shiftMonth("2026-03-01", 0), "2026-03-01");
});

test("every commission.* / target.* rule the 981 migration raises has a user message in Arabic AND English", async () => {
  const { readFileSync } = await import("node:fs");
  const { hasMessage, userMessage } = await import("../../src/lib/errors.ts");
  const sql = readFileSync(new URL("../../supabase/proposed/20261104000981_employee_targets_commission.sql", import.meta.url), "utf8");
  const codes = new Set([...sql.matchAll(/raise exception '((?:commission|target)\.[a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...codes].sort(), ["commission.invalid_tiers", "target.invalid_user", "target.invalid_value"]);
  for (const c of codes) {
    assert.ok(hasMessage(c), c);
    for (const l of ["ar", "en"] as const) assert.notEqual(userMessage({ message: c }, l), userMessage({ message: "nope" }, l), `${c} (${l})`);
  }
});

test("performance strings exist with the same shape in both languages, and the new target metrics are labelled", async () => {
  const { ar } = await import("../../src/i18n/ar.ts");
  const { en } = await import("../../src/i18n/en.ts");
  assert.deepEqual(Object.keys(ar.performance).sort(), Object.keys(en.performance).sort());
  assert.ok(Object.keys(ar.performance).length > 35);
  for (const m of ["collected_egp", "paid_customers"] as const) { assert.ok(ar.enums.targetMetric[m]); assert.ok(en.enums.targetMetric[m]); }
  assert.ok(ar.nav.performance && en.nav.performance);
});

test("MGH tiers: boundary attainments (0 / 3 / 4 / 5 %) and the commission on the whole amount", () => {
  const mgh: Tier[] = [{ min: 0.8, rate: 0.03 }, { min: 0.9, rate: 0.04 }, { min: 1, rate: 0.05 }];
  const cases: [number, number | null][] = [[0.79, null], [0.8, 0.03], [0.8999, 0.03], [0.9, 0.04], [0.9999, 0.04], [1, 0.05], [1.2, 0.05]];
  for (const [att, rate] of cases) assert.equal(tierFor(mgh, att)?.rate ?? null, rate, `attainment ${att}`);
  // collected amounts against a 10 000 target, as in supabase/tests/db_proposed/23_approvers_target_defaults.sql
  assert.equal(commissionOf(8000, 0.03), 240);
  assert.equal(commissionOf(8999, 0.03), 269.97);
  assert.equal(commissionOf(9000, 0.04), 360);
  assert.equal(commissionOf(9999, 0.04), 399.96);
  assert.equal(commissionOf(10000, 0.05), 500);
  assert.equal(commissionOf(22999, 0.04), 919.96);
});
