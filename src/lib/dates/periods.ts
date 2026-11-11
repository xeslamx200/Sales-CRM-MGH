/**
 * Reporting periods as calendar dates in a company's time zone.
 * The database interprets [from, to] as local midnight to local midnight
 * (see app.period_start), so the UI only ever sends dates, never instants.
 */

export type PeriodPreset = "today" | "yesterday" | "this_week" | "last_7_days" | "this_month" | "last_month" | "last_30_days";
export type DateRange = { from: string; to: string }; // YYYY-MM-DD, inclusive

/** 0 = Sunday … 6 = Saturday. Qatar/Gulf work weeks start on Sunday. */
export type WeekStart = 0 | 1 | 6;

/** Today's calendar date in the given IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(ymd: string, n: number): string {
  const d = toUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function resolvePeriod(preset: PeriodPreset, now: Date, timeZone: string, weekStart: WeekStart = 0): DateRange {
  const today = localDate(now, timeZone);
  const t = toUtcDate(today);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "last_7_days":
      return { from: addDays(today, -6), to: today };
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
    case "this_week": {
      const back = (t.getUTCDay() - weekStart + 7) % 7;
      return { from: addDays(today, -back), to: today };
    }
    case "this_month":
      return { from: today.slice(0, 8) + "01", to: today };
    case "last_month": {
      const firstThis = toUtcDate(today.slice(0, 8) + "01");
      const lastPrev = new Date(firstThis);
      lastPrev.setUTCDate(0);
      return { from: fmt(lastPrev).slice(0, 8) + "01", to: fmt(lastPrev) };
    }
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a custom range from user input. Max one year, like the DB. */
export function parseCustomRange(from: string, to: string): DateRange | null {
  if (!YMD.test(from) || !YMD.test(to)) return null;
  const a = toUtcDate(from);
  const b = toUtcDate(to);
  if (fmt(a) !== from || fmt(b) !== to) return null; // e.g. 2026-02-31
  const days = (b.getTime() - a.getTime()) / 86_400_000;
  if (days < 0 || days > 366) return null;
  return { from, to };
}
