import "server-only";
import { parseCustomRange, resolvePeriod, type DateRange, type PeriodPreset } from "@/lib/dates/periods.ts";
import { oneOf, str, type SP } from "@/lib/search-params";

export const PRESETS: PeriodPreset[] = ["today", "yesterday", "this_week", "last_7_days", "this_month", "last_month", "last_30_days"];

/**
 * Reporting period from the URL: a preset resolved in the company's time
 * zone, or a validated custom range. The database interprets the dates in
 * each company's own zone (docs/METRICS.md).
 */
export function reportPeriod(sp: SP, tz: string, fallback: PeriodPreset = "this_month"): DateRange & { preset: PeriodPreset | "custom" } {
  const preset = oneOf(sp, "period", [...PRESETS, "custom"] as const);
  if (preset === "custom") {
    const range = parseCustomRange(str(sp, "from") ?? "", str(sp, "to") ?? "");
    if (range) return { ...range, preset: "custom" };
  }
  const p = preset && preset !== "custom" ? preset : fallback;
  return { ...resolvePeriod(p, new Date(), tz), preset: p };
}
