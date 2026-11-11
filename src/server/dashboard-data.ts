import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { daysBetween, previousRange } from "@/lib/dashboard-math";
import type { Database } from "@/types/database";

type Fns = Database["public"]["Functions"];
export type WorkshopKpi = Fns["report_workshop_kpis"]["Returns"][number];
export type WorkshopDay = Fns["report_workshop_daily"]["Returns"][number];
export type WorkshopBreakdown = Fns["report_workshop_breakdown"]["Returns"][number];
export type RecentBooking = Fns["customer_payment_rows"]["Returns"][number];

export type DashboardData = {
  /** server time when the figures were read (ms), used for "time ago" and the greeting */
  now: number;
  days: string[];
  prevDays: string[];
  kpis: WorkshopKpi[];
  prevKpis: WorkshopKpi[];
  daily: WorkshopDay[];
  prevDaily: WorkshopDay[];
  breakdown: WorkshopBreakdown[];
  recent: RecentBooking[];
  leadsPerDay: { day: string; total: number }[];
  goal: { actual: number; target: number; currency: string; people: number } | null;
};

/** Everything the workshop dashboard shows, from the existing report functions (so scope and permissions are the database's). */
export async function loadWorkshopDashboard(supabase: ServerClient, companyId: string, period: { from: string; to: string }, targetCurrency: string): Promise<DashboardData> {
  const prev = previousRange(period.from, period.to);
  const cur = { p_company_id: companyId, p_from: period.from, p_to: period.to };
  const old = { p_company_id: companyId, p_from: prev.from, p_to: prev.to };
  const [k, pk, d, pd, b, rec, lp, tg] = await Promise.all([
    supabase.rpc("report_workshop_kpis", cur),
    supabase.rpc("report_workshop_kpis", old),
    supabase.rpc("report_workshop_daily", cur),
    supabase.rpc("report_workshop_daily", old),
    supabase.rpc("report_workshop_breakdown", cur),
    supabase.rpc("customer_payment_rows", { p_company_id: companyId, p_from: period.from, p_to: period.to }),
    supabase.rpc("report_leads_per_day", cur),
    supabase.rpc("report_target_progress", { p_company_id: companyId }),
  ]);
  for (const r of [k, pk, d, pd, b, rec, lp, tg]) if (r.error) throw r.error;

  const recent = [...(rec.data ?? [])].filter((r) => r.booking_status === "booked").sort((a, c) => (a.booked_at < c.booked_at ? 1 : -1)).slice(0, 5);
  const goalRows = (tg.data ?? []).filter((r) => r.metric === "collected_egp" && r.target_value > 0);
  const goal = goalRows.length === 0 ? null : {
    actual: goalRows.reduce((s, r) => s + Number(r.actual_value), 0),
    target: goalRows.reduce((s, r) => s + Number(r.target_value), 0),
    currency: targetCurrency,
    people: goalRows.length,
  };
  return {
    now: Date.now(),
    days: daysBetween(period.from, period.to),
    prevDays: daysBetween(prev.from, prev.to),
    kpis: k.data ?? [], prevKpis: pk.data ?? [], daily: d.data ?? [], prevDaily: pd.data ?? [], breakdown: b.data ?? [], recent,
    leadsPerDay: (lp.data ?? []).filter((r) => r.day !== null).map((r) => ({ day: r.day as string, total: Number(r.total) })), goal,
  };
}
