/**
 * Exchange rates to EGP for payments (pure functions, no I/O).
 *
 * Source: https://open.er-api.com/v6/latest/EGP (free, no key; mid-market rates, refreshed about once a day; attribution link required).
 * Its answer is "1 EGP = x <currency>"; we store the inverse, "1 <currency> = N EGP", in public.fx_rates (server only). Each payment freezes
 * the rate it used, and the database computes the EGP total itself: the numbers here are only a PREVIEW for the form and the validation of
 * the external answer. These are NOT the bank's transfer rates: the real amount received can differ slightly from the recorded EGP total.
 */

/** Currencies offered in the payment form. EGP needs no rate. */
export const PAYMENT_CURRENCIES = ["EGP", "USD", "EUR", "GBP", "SAR", "AED", "KWD", "QAR", "BHD", "OMR", "JOD", "TRY"] as const;
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];
export const FOREIGN_CURRENCIES = PAYMENT_CURRENCIES.filter((c) => c !== "EGP");

export const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/EGP";
export const FX_SOURCE_NAME = "open.er-api.com (ExchangeRate-API)";
/** Refresh when the stored rates are older than this; the database refuses to record a payment on a rate older than 48 hours. */
export const FX_REFRESH_AFTER_MS = 6 * 3_600_000;
export const FX_MAX_AGE_MS = 48 * 3_600_000;

export type RateTable = Record<string, { rateToEgp: number; fetchedAt: string }>;

/**
 * Parse the external answer into { USD: 50.1, ... } = EGP per 1 unit. Anything unexpected returns null (the caller keeps the old rates):
 * a wrong rate silently stored would corrupt every payment recorded afterwards.
 */
export function parseExchangeRates(json: unknown, wanted: readonly string[] = FOREIGN_CURRENCIES): Record<string, number> | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as { result?: unknown; base_code?: unknown; rates?: unknown };
  if (j.result !== "success" || j.base_code !== "EGP" || typeof j.rates !== "object" || j.rates === null) return null;
  const rates = j.rates as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const code of wanted) {
    const perEgp = rates[code];                       // 1 EGP = perEgp <code>
    if (typeof perEgp !== "number" || !Number.isFinite(perEgp) || perEgp <= 0) continue;
    const toEgp = 1 / perEgp;                          // 1 <code> = toEgp EGP
    if (!Number.isFinite(toEgp) || toEgp <= 0 || toEgp > 1_000_000) continue;
    out[code] = Math.round(toEgp * 1e8) / 1e8;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Rate for a currency: EGP is always 1; a foreign currency needs a stored rate that is not older than `maxAgeMs`. */
export function rateFor(currency: string, table: RateTable, now: number = Date.now(), maxAgeMs: number = FX_MAX_AGE_MS): number | null {
  const c = currency.toUpperCase();
  if (c === "EGP") return 1;
  const r = table[c];
  if (!r) return null;
  const age = now - Date.parse(r.fetchedAt);
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return r.rateToEgp;
}

/** Do these stored rates need a refresh (a currency is missing, or the oldest one is past the refresh age)? */
export function ratesNeedRefresh(table: RateTable, now: number = Date.now(), refreshAfterMs: number = FX_REFRESH_AFTER_MS): boolean {
  for (const code of FOREIGN_CURRENCIES) {
    const r = table[code];
    if (!r) return true;
    const age = now - Date.parse(r.fetchedAt);
    if (!Number.isFinite(age) || age > refreshAfterMs) return true;
  }
  return false;
}

/** EGP total for display: the same rounding as the database (half away from zero at 2 decimals), computed on cents to avoid float noise. */
export function egpPreview(amount: number, rate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || amount <= 0 || rate <= 0) return 0;
  return Math.round((Math.round(amount * 100) / 100) * rate * 100 + Number.EPSILON) / 100;
}

/** Balance of a customer for one workshop from CONFIRMED payments only. price null = no price set (no balance can be computed). */
export function workshopBalance(priceEgp: number | null, confirmedEgp: number): { paid: number; remaining: number | null; settled: boolean } {
  const paid = Math.round(confirmedEgp * 100) / 100;
  if (priceEgp == null) return { paid, remaining: null, settled: false };
  const remaining = Math.max(0, Math.round((priceEgp - paid) * 100) / 100);
  return { paid, remaining, settled: remaining === 0 };
}
