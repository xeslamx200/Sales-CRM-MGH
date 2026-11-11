import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { lastSixMonths, previousRange } from "@/lib/dashboard-math";
import type { Database } from "@/types/database";
import type { KpiRow } from "@/components/reports/kpis";

type Fns = Database["public"]["Functions"];
export type WorkshopKpi = Fns["report_workshop_kpis"]["Returns"][number];
export type WorkshopBreakdown = Fns["report_workshop_breakdown"]["Returns"][number];
export type EmployeePerf = Fns["report_employee_performance"]["Returns"][number];
export type ResponseRow = Fns["report_whatsapp_response"]["Returns"][number];

export type MonthPoint = { key: string; label: string; from: string; to: string; kpis: WorkshopKpi[] };

export type ComparisonData = {
  period: { from: string; to: string };
  previous: { from: string; to: string };
  base: KpiRow | null;
  basePrev: KpiRow | null;
  workshop: boolean;
  kpis: WorkshopKpi[];
  prevKpis: WorkshopKpi[];
  breakdown: WorkshopBreakdown[];
  prevBreakdown: WorkshopBreakdown[];
  months: MonthPoint[];
  employees: EmployeePerf[];
  prevEmployees: EmployeePerf[];
  response: ResponseRow[];
  prevResponse: ResponseRow[];
};

/** Everything the "Comparison" report shows, from the existing report functions (so scope and permissions are the database's). */
export async function loadComparison(supabase: ServerClient, companyId: string, period: { from: string; to: string }, workshop: boolean, userId: string | null): Promise<ComparisonData> {
  const previous = previousRange(period.from, period.to);
  const who = userId ? { p_user_id: userId } : {};
  const cur = { p_company_id: companyId, p_from: period.from, p_to: period.to, ...who };
  const old = { p_company_id: companyId, p_from: previous.from, p_to: previous.to, ...who };
  const months = lastSixMonths(period.to);

  const [k, pk, emp, pemp, wr, pwr] = await Promise.all([
    supabase.rpc("report_company_kpis", { p_from: period.from, p_to: period.to, p_company_ids: [companyId], ...(userId ? { p_user_id: userId } : {}) }),
    supabase.rpc("report_company_kpis", { p_from: previous.from, p_to: previous.to, p_company_ids: [companyId], ...(userId ? { p_user_id: userId } : {}) }),
    supabase.rpc("report_employee_performance", { p_company_id: companyId, p_from: period.from, p_to: period.to }),
    supabase.rpc("report_employee_performance", { p_company_id: companyId, p_from: previous.from, p_to: previous.to }),
    supabase.rpc("report_whatsapp_response", { p_company_id: companyId, p_from: period.from, p_to: period.to }),
    supabase.rpc("report_whatsapp_response", { p_company_id: companyId, p_from: previous.from, p_to: previous.to }),
  ]);
  for (const r of [k, pk, emp, pemp, wr, pwr]) if (r.error) throw r.error;

  let kpis: WorkshopKpi[] = [], prevKpis: WorkshopKpi[] = [], breakdown: WorkshopBreakdown[] = [], prevBreakdown: WorkshopBreakdown[] = [];
  let monthly: MonthPoint[] = [];
  if (workshop) {
    const [a, b, c, d, ...m] = await Promise.all([
      supabase.rpc("report_workshop_kpis", cur), supabase.rpc("report_workshop_kpis", old),
      supabase.rpc("report_workshop_breakdown", cur), supabase.rpc("report_workshop_breakdown", old),
      ...months.map((mm) => supabase.rpc("report_workshop_kpis", { p_company_id: companyId, p_from: mm.from, p_to: mm.to, ...who })),
    ]);
    for (const r of [a, b, c, d, ...m]) if (r.error) throw r.error;
    kpis = a.data ?? []; prevKpis = b.data ?? []; breakdown = c.data ?? []; prevBreakdown = d.data ?? [];
    monthly = months.map((mm, i) => ({ ...mm, label: mm.key, kpis: m[i].data ?? [] }));
  }
  return {
    period, previous, workshop,
    base: ((k.data ?? [])[0] as KpiRow | undefined) ?? null, basePrev: ((pk.data ?? [])[0] as KpiRow | undefined) ?? null,
    kpis, prevKpis, breakdown, prevBreakdown, months: monthly,
    employees: emp.data ?? [], prevEmployees: pemp.data ?? [], response: wr.data ?? [], prevResponse: pwr.data ?? [],
  };
}
