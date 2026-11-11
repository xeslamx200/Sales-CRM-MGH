import { CheckCheck, Clock, Layers, UserPlus, Users } from "lucide-react";
import type { Dictionary, Locale } from "@/i18n";
import { formatNumber } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

/** One row of public.report_company_kpis. The UI only formats these values. */
export type KpiRow = {
  company_id: string; company_name: string; currency: string;
  open_leads: number; leads_created: number;
  overdue_tasks: number; tasks_completed: number; activities_logged: number;
};

type Icon = React.ComponentType<{ className?: string }>;

/** KPI tile in the MGH style: soft card, value, and a tinted icon chip (gold for money / activity, blue for pipeline, red when overdue). */
export function Tile({ label, value, hint, tone, icon: Icon, accent = "gold" }:
  { label: string; value: string; hint?: string; tone?: "danger"; icon?: Icon; accent?: "gold" | "blue" }) {
  const chip = tone === "danger" ? "bg-destructive/10 text-destructive" : accent === "blue" ? "bg-secondary text-primary" : "bg-accent text-[color:var(--brand-gold-ink)]";
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("ltr-nums self-start text-2xl font-semibold tracking-tight", tone === "danger" && "text-destructive")}>{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {Icon && <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", chip)}><Icon className="size-5" /></span>}
    </div>
  );
}

export function KpiTiles({ row, t, locale }: { row: KpiRow; t: Dictionary; locale: Locale }) {
  const n = (v: number) => formatNumber(v, locale);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile icon={UserPlus} accent="blue" label={t.reports.kpi.leadsCreated} value={n(row.leads_created)} />
        <Tile icon={Users} label={t.reports.kpi.openLeads} value={n(row.open_leads)} hint={t.reports.kpi.now} />
        <Tile icon={Layers} accent="blue" label={t.reports.kpi.activities} value={n(row.activities_logged)} />
        <Tile icon={CheckCheck} label={t.reports.kpi.tasksCompleted} value={n(row.tasks_completed)} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile icon={Clock} label={t.reports.kpi.overdueTasks} value={n(row.overdue_tasks)} hint={t.reports.kpi.now}
          tone={row.overdue_tasks > 0 ? "danger" : undefined} />
      </div>
    </div>
  );
}

/** Companies side by side; revenue stays in each company's own currency. */
export function KpiComparison({ rows, t, locale }: { rows: KpiRow[]; t: Dictionary; locale: Locale }) {
  const n = (v: number) => formatNumber(v, locale);
  const cols: { label: string; cell: (r: KpiRow) => string }[] = [
    { label: t.reports.kpi.leadsCreated, cell: (r) => n(r.leads_created) },
    { label: t.reports.kpi.openLeads, cell: (r) => n(r.open_leads) },
    { label: t.reports.kpi.tasksCompleted, cell: (r) => n(r.tasks_completed) },
    { label: t.reports.kpi.overdueTasks, cell: (r) => n(r.overdue_tasks) },
  ];
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-start font-medium">{t.common.company}</th>
            {cols.map((c) => <th key={c.label} className="px-3 py-2 text-start font-medium">{c.label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.company_id}>
              <td className="px-3 py-2 font-medium">{r.company_name}</td>
              {cols.map((c) => <td key={c.label} className="ltr-nums px-3 py-2 text-start">{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
