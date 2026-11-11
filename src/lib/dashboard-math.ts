/** Small pure helpers of the dashboard (period arithmetic, deltas, stable colours). Dates are "YYYY-MM-DD" and always handled in UTC so the day count never drifts. */

const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every day of an inclusive range. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toMs(from); t <= toMs(to) && out.length < 400; t += DAY_MS) out.push(toDay(t));
  return out;
}

/** The period of the same length that ends the day before `from` (for "vs previous period"). */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;
  const prevTo = toMs(from) - DAY_MS;
  return { from: toDay(prevTo - (n - 1) * DAY_MS), to: toDay(prevTo) };
}

/** Percentage change; null when there is nothing to compare with. */
export function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Categorical colours of the dashboard (validated with the dataviz palette checker on a light surface: lightness band, chroma, colour-blind separation).
 * A workshop keeps its colour whatever its rank, so filtering never repaints the others.
 */
export const SERIES_COLORS = ["#2f6fcf", "#c99700", "#2f9e8f", "#d9573d"] as const;

export function colorFor(key: string, keys: string[]): string {
  const i = [...keys].sort().indexOf(key);
  return SERIES_COLORS[(i < 0 ? 0 : i) % SERIES_COLORS.length];
}

/** Time-of-day greeting bucket in a time zone. */
export function dayPart(now: Date, timeZone: string): "morning" | "afternoon" | "evening" {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone }).format(now));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

/** "QAR 48.2K" / "QAR 2,730": compact only when large; Latin digits in both languages so figures line up. */
export function compactMoney(n: number, currency: string, locale: "ar" | "en"): string {
  const big = Math.abs(n) >= 10_000;
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : "en-u-nu-latn", {
    style: "currency", currency: currency.trim() || "USD", currencyDisplay: "code", notation: big ? "compact" : "standard", maximumFractionDigits: big ? 1 : 0,
  }).format(n).replace(/ /g, " ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The six calendar months that end with the month of `to` (oldest first). Dates are plain "YYYY-MM-DD", handled in UTC. */
export function lastSixMonths(to: string): { key: string; from: string; to: string }[] {
  const [y, m] = to.split("-").map(Number);
  const out: { key: string; from: string; to: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const first = new Date(Date.UTC(y, m - 1 - i, 1));
    const last = new Date(Date.UTC(y, m - i, 0));
    out.push({ key: `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}`, from: iso(first), to: iso(last) });
  }
  return out;
}
