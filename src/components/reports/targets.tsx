import type { Dictionary, Locale } from "@/i18n";
import type { Enums } from "@/types/database";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format.ts";

/** One row of public.report_target_progress. */
export type TargetRow = {
  target_id: string; metric: Enums<"target_metric">; user_id: string | null; team_id: string | null;
  period_start: string; period_end: string; target_value: number; actual_value: number; attainment: number | null;
};

export function TargetProgress({
  rows, names, t, locale, targetCurrency = "EGP",
}: { rows: TargetRow[]; names: Map<string, string>; t: Dictionary; locale: Locale; targetCurrency?: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t.reports.noTargets}</p>;
  const fmtVal = (metric: TargetRow["metric"], v: number) =>
    metric === "collected_egp" ? formatCurrency(v, targetCurrency, locale) : formatNumber(v, locale);
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(1, r.attainment ?? 0));
        const who = r.user_id ? names.get(r.user_id) ?? "—" : r.team_id ? names.get(r.team_id) ?? t.common.team : t.reports.wholeCompany;
        return (
          <li key={r.target_id} className="text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{t.enums.targetMetric[r.metric]} · <span className="text-muted-foreground">{who}</span></span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <bdi className="tabular-nums">{fmtVal(r.metric, r.actual_value)}</bdi>/<bdi className="tabular-nums">{fmtVal(r.metric, r.target_value)}</bdi>
                <span aria-hidden>·</span>
                <bdi className="font-medium tabular-nums text-foreground">{formatPercent(r.attainment, locale)}</bdi>
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(pct * 100)} aria-label={t.enums.targetMetric[r.metric]}>
              <div className="h-2 rounded-full bg-primary" style={{ width: `${pct * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
