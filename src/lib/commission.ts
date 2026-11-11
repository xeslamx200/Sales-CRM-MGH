/**
 * Commission display helpers (pure). The database is the source of truth: report_monthly_commission computes attainment, the tier rate and the
 * commission itself. These functions only describe the tiers to the user ("what do I need for the next tier?") and validate the editor.
 *
 * Rule: the rate of the HIGHEST tier whose threshold the attainment has reached applies to the WHOLE confirmed amount of the month.
 */

export type Tier = { min: number; rate: number };   // fractions: min 0.8 = 80 % of the amount target, rate 0.03 = 3 %

export const MAX_TIERS = 12;

/** Highest tier reached (null = below the first tier, or no attainment because no amount target was set). */
export function tierFor(tiers: readonly Tier[], attainment: number | null): Tier | null {
  if (attainment == null || !Number.isFinite(attainment)) return null;
  let best: Tier | null = null;
  for (const t of tiers) if (t.min <= attainment + 1e-9 && (best === null || t.min > best.min)) best = t;
  return best;
}

/** The next tier above the current attainment, and how much more confirmed money (EGP) it needs. null = already at the top, or no target. */
export function nextTier(tiers: readonly Tier[], targetAmount: number | null, achieved: number): { tier: Tier; missingEgp: number } | null {
  if (targetAmount == null || targetAmount <= 0) return null;
  const att = achieved / targetAmount;
  let next: Tier | null = null;
  for (const t of tiers) if (t.min > att + 1e-9 && (next === null || t.min < next.min)) next = t;
  if (!next) return null;
  return { tier: next, missingEgp: Math.max(0, Math.round((next.min * targetAmount - achieved) * 100) / 100) };
}

/** Commission for an amount at a rate, rounded like the database (2 decimals). */
export function commissionOf(amountEgp: number, rate: number): number {
  return Math.round(amountEgp * rate * 100 + Number.EPSILON) / 100;
}

export type TierDraft = { minPercent: string; ratePercent: string };
export type TierCheck = { ok: true; tiers: Tier[] } | { ok: false; reason: "empty_row" | "invalid_number" | "order" | "rate_order" | "too_many" };

/** Editor rows (percentages as typed) -> fractions, with the same rules as set_commission_tiers: strictly increasing thresholds, rates never decreasing. */
export function checkTierDrafts(rows: readonly TierDraft[]): TierCheck {
  if (rows.length > MAX_TIERS) return { ok: false, reason: "too_many" };
  const num = (s: string) => Number(s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/٫/g, ".").replace(/[%\s]/g, ""));
  const out: Tier[] = [];
  for (const r of rows) {
    if (r.minPercent.trim() === "" || r.ratePercent.trim() === "") return { ok: false, reason: "empty_row" };
    const min = num(r.minPercent), rate = num(r.ratePercent);
    if (!Number.isFinite(min) || !Number.isFinite(rate) || min < 0 || min > 1000 || rate < 0 || rate > 100) return { ok: false, reason: "invalid_number" };
    out.push({ min: Math.round(min * 100) / 10000, rate: Math.round(rate * 100) / 10000 });   // percent -> fraction, 4 decimals like the database
  }
  out.sort((a, b) => a.min - b.min);
  for (let i = 1; i < out.length; i++) {
    if (out[i].min <= out[i - 1].min) return { ok: false, reason: "order" };
    if (out[i].rate < out[i - 1].rate) return { ok: false, reason: "rate_order" };
  }
  return { ok: true, tiers: out };
}

/** "2026-11" (from the URL) -> the first day of that month, or null. */
export function parseMonth(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 2100 ? `${value}-01` : null;
}
export function shiftMonth(firstDay: string, delta: number): string {
  const d = new Date(Date.UTC(Number(firstDay.slice(0, 4)), Number(firstDay.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}
