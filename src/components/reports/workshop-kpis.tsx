import { Banknote, CheckCheck, Clock, Coins, Hourglass, Layers, Percent, Receipt, ShoppingBag, UserPlus, Users, Wallet } from "lucide-react";
import { Section } from "@/components/app/page-header";
import type { Dictionary, Locale } from "@/i18n";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format.ts";
import type { Database } from "@/types/database";
import { Tile, type KpiRow } from "./kpis";

type Fns = Database["public"]["Functions"];
export type WorkshopKpiRow = Fns["report_workshop_kpis"]["Returns"][number];
export type WorkshopBreakdownRow = Fns["report_workshop_breakdown"]["Returns"][number];

/** Dashboard for companies that sell workshops: revenue comes from bookings and payments, never from Deals. Money stays per currency. */
export function WorkshopKpiTiles({ rows, breakdown, base, t, locale }: { rows: WorkshopKpiRow[]; breakdown: WorkshopBreakdownRow[]; base: KpiRow | null; t: Dictionary; locale: Locale }) {
  const w = t.workshopDash;
  const n = (v: number | null | undefined) => formatNumber(v ?? 0, locale);
  const totals = rows.find((r) => r.currency === null);
  const money = rows.filter((r) => r.currency !== null);
  const cur = (r: WorkshopKpiRow) => (r.currency ?? "").trim();
  return (
    <div className="flex flex-col gap-3">
      {money.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{w.noBookings}</p>}
      {money.map((r) => (
        <div key={r.currency} className="flex flex-col gap-2" data-testid={`workshop-money-${cur(r)}`}>
          {money.length > 1 && <h3 className="text-sm font-medium text-muted-foreground">{w.revenueTitle} · {cur(r)}</h3>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile icon={Coins} label={w.collected} value={formatCurrency(r.collected ?? 0, cur(r), locale)} hint={w.collectedHint} />
            <Tile icon={Receipt} accent="blue" label={w.booked} value={formatCurrency(r.booked_value ?? 0, cur(r), locale)} hint={w.bookedHint} />
            <Tile icon={Wallet} label={w.remaining} value={formatCurrency(r.remaining ?? 0, cur(r), locale)} hint={w.remainingHint} />
            <Tile icon={Hourglass} accent="blue" label={w.pending} value={formatCurrency(r.pending ?? 0, cur(r), locale)} hint={w.pendingHint} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile icon={ShoppingBag} accent="blue" label={`${w.bookings} (${cur(r)})`} value={n(r.bookings)} />
            <Tile icon={Banknote} label={w.discounts} value={formatCurrency(r.discount_total ?? 0, cur(r), locale)}
              hint={(r.list_value ?? 0) > 0 ? formatPercent((r.discount_total ?? 0) / (r.list_value ?? 1), locale) : undefined} />
          </div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile icon={ShoppingBag} label={w.bookings} value={n(totals?.bookings)} hint={`${w.cancelled}: ${n(totals?.cancelled)}`} />
        <Tile icon={Users} accent="blue" label={w.customers} value={n(totals?.customers)} />
        <Tile icon={UserPlus} label={t.reports.kpi.leadsCreated} value={n(totals?.leads_created)} />
        <Tile icon={Percent} accent="blue" label={w.leadsBooked} value={formatPercent((totals?.leads_created ?? 0) > 0 ? (totals?.leads_booked ?? 0) / (totals?.leads_created ?? 1) : null, locale)}
          hint={`${n(totals?.leads_booked)} / ${n(totals?.leads_created)}`} />
      </div>
      {base && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile icon={Users} accent="blue" label={t.reports.kpi.openLeads} value={n(base.open_leads)} hint={t.reports.kpi.now} />
          <Tile icon={Layers} label={t.reports.kpi.activities} value={n(base.activities_logged)} />
          <Tile icon={CheckCheck} accent="blue" label={t.reports.kpi.tasksCompleted} value={n(base.tasks_completed)} />
          <Tile icon={Clock} label={t.reports.kpi.overdueTasks} value={n(base.overdue_tasks)} hint={t.reports.kpi.now} tone={base.overdue_tasks > 0 ? "danger" : undefined} />
        </div>
      )}
      {breakdown.length > 0 && (
        <Section title={w.perWorkshop}>
          <div className="relative overflow-x-auto" data-testid="workshop-breakdown">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>{[w.workshop, w.currency, w.bookings, w.booked, w.collected, w.remaining].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-start font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {breakdown.map((r) => (
                  <tr key={`${r.offering_id}-${r.currency}`}>
                    <td className="px-3 py-1.5 font-medium">{r.offering_name}</td>
                    <td className="px-3 py-1.5">{r.currency.trim()}</td>
                    <td className="ltr-nums px-3 py-1.5">{n(r.bookings)}</td>
                    <td className="ltr-nums whitespace-nowrap px-3 py-1.5">{formatCurrency(r.booked_value, r.currency.trim(), locale)}</td>
                    <td className="ltr-nums whitespace-nowrap px-3 py-1.5">{formatCurrency(r.collected, r.currency.trim(), locale)}</td>
                    <td className="ltr-nums whitespace-nowrap px-3 py-1.5">{formatCurrency(r.remaining, r.currency.trim(), locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <p className="text-xs text-muted-foreground">{w.note}</p>
    </div>
  );
}
