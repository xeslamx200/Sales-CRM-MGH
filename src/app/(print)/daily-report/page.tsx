import { EmployeeDayCards } from "@/components/reports/employee-day";
import { PrintButton } from "@/components/reports/print-button";
import { EmptyState } from "@/components/app/states";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { reportPeriod } from "@/server/reports";
import { uuid, type SP } from "@/lib/search-params";

/** Printable daily report of the employees (the browser's "Save as PDF" turns it into a PDF file). */
export default async function DailyReportPrintPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const company = viewer.activeCompany;
  if (!company) return <EmptyState title={t.shifts.noData} />;
  const tz = company.timezone ?? "UTC";
  const period = reportPeriod(sp, tz, "today");
  const userId = uuid(sp, "user");
  const supabase = await createClient();
  const args = { p_company_id: company.id, p_from: period.from, p_to: period.to, ...(userId ? { p_user_id: userId } : {}) };
  const [{ data, error }, rep, sh] = await Promise.all([
    supabase.rpc("report_employee_day", args),
    supabase.rpc("report_shift_activity", args),
    supabase.from("employee_shifts").select("user_id, starts_at, ends_at, weekdays").eq("company_id", company.id).is("effective_to", null),
  ]);
  if (error) throw error;
  if (rep.error) throw rep.error;
  if (sh.error) throw sh.error;
  const rows = data ?? [];
  const hm = (v: string) => v.slice(0, 5);
  const shiftLabels = Object.fromEntries((sh.data ?? []).map((x) => [x.user_id, `${hm(x.starts_at)}–${hm(x.ends_at)} · ${[7, 1, 2, 3, 4, 5, 6].filter((d) => x.weekdays.includes(d)).map((d) => t.shifts.weekdays[d - 1]).join(" · ")}`]));
  const sx = t.shifts;
  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="space-y-4">
      <style>{"@page { size: A4 portrait; margin: 10mm; } @media print { body { background: #fff !important; } }"}</style>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{sx.printTitle}</h1>
          <p className="text-sm text-muted-foreground">{company.name} · {sx.period}: <span className="ltr-nums">{period.from} → {period.to}</span></p>
          <p className="text-xs text-muted-foreground print:hidden">{sx.printHint}</p>
        </div>
        <PrintButton label={sx.downloadPdf} />
      </div>
      {rows.length === 0 ? <EmptyState title={sx.noData} /> : <EmployeeDayCards rows={rows} shiftRows={rep.data ?? []} shiftLabels={shiftLabels} t={t} locale={locale} testId="daily-print" print />}
      <p className="text-xs text-muted-foreground">{sx.dailyNote}</p>
    </div>
  );
}
