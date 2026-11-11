import Link from "next/link";
import { PageHeader, Section } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { PeriodPicker } from "@/components/reports/period-picker";
import { KpiComparison, KpiTiles, type KpiRow } from "@/components/reports/kpis";
import { DailyCharts, type DailyRow } from "@/components/reports/daily-charts";
import { LeadsPerDayChart, type LeadsDayRow } from "@/components/reports/leads-per-day-chart";
import { ResponseSpeedTiles, WaitingNow, type SpeedRow, type WaitingRow } from "@/components/reports/response-speed";
import { TargetProgress, type TargetRow } from "@/components/reports/targets";
import { DashboardHeader, WorkshopDashboard } from "@/components/dashboard/workshop-dashboard";
import { loadWorkshopDashboard, type DashboardData } from "@/server/dashboard-data";
import { getCompanyUiSettings } from "@/server/company-settings";
import { getViewer, roleIn } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { reportPeriod } from "@/server/reports";
import { formatNumber } from "@/lib/format.ts";

/**
 * Dashboard. Every number comes from a report_* SQL function (one definition
 * per metric, docs/METRICS.md); this page only formats and lays them out.
 */
export default async function DashboardPage({ searchParams }: PageProps<"/">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const company = viewer.activeCompany;
  const tz = company?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const period = reportPeriod(sp, tz);
  const supabase = await createClient();

  const kpis = await supabase.rpc("report_company_kpis", {
    p_from: period.from, p_to: period.to, p_company_ids: viewer.scopeCompanyIds,
  });
  if (kpis.error) throw kpis.error;
  const rows = (kpis.data ?? []) as KpiRow[];

  const role = roleIn(viewer, company?.id);
  const scopeHint =
    role === "sales_agent" || role === "cs_agent" ? t.reports.scopeSelf
    : role === "sales_manager" ? t.reports.scopeTeam
    : t.reports.scopeCompany;

  let daily: DailyRow[] = [];
  let targets: TargetRow[] = [];
  let leadsDaily: LeadsDayRow[] = [];
  let speed: SpeedRow[] = [];
  let waiting: WaitingRow[] = [];
  let workload: { whatsapp_account_id: string; display_name: string; open_conversations: number; unassigned_conversations: number; unread_conversations: number }[] = [];
  const names = new Map<string, string>();
  let targetCurrency = "EGP";
  // Workshop companies: revenue comes from bookings and payments
  let dash: DashboardData | null = null;
  const uiSettings = await getCompanyUiSettings(supabase, company);
  const workshopMode = !!company && uiSettings.dashboardMode === "workshop";
  const widget = (w: string) => !uiSettings.hiddenWidgets.includes(w);
  if (company) {
    targetCurrency = (await supabase.rpc("company_target_currency", { p_company_id: company.id })).data ?? "EGP";
    if (workshopMode) dash = await loadWorkshopDashboard(supabase, company.id, period, targetCurrency);
    const [d, tg, wl, teams, ld, rs, wn] = await Promise.all([
      supabase.rpc("report_daily_series", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_target_progress", { p_company_id: company.id }),
      supabase.rpc("report_whatsapp_workload", { p_company_ids: [company.id] }),
      supabase.from("teams").select("id, name").eq("company_id", company.id),
      supabase.rpc("report_leads_per_day", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_response_speed", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_waiting_now", { p_company_id: company.id }),
    ]);
    if (d.error) throw d.error;
    if (ld.error) throw ld.error;
    // Response speed and the waiting list are secondary panels: if one of them cannot be computed (for instance a database time-out), the rest of the dashboard still loads.
    if (rs.error) console.warn("[dashboard] response speed unavailable", { code: rs.error.code });
    if (wn.error) console.warn("[dashboard] waiting list unavailable", { code: wn.error.code });
    leadsDaily = (ld.data ?? []) as LeadsDayRow[];
    speed = (rs.data ?? []) as SpeedRow[];
    waiting = (wn.data ?? []) as WaitingRow[];
    daily = (d.data ?? []) as DailyRow[];
    targets = (tg.data ?? []) as TargetRow[];
    workload = wl.data ?? [];
    for (const team of teams.data ?? []) names.set(team.id, team.name);
    const userIds = [...new Set(targets.flatMap((x) => (x.user_id ? [x.user_id] : [])))];
    if (userIds.length) {
      const { data: people } = await supabase.from("profiles").select("id, full_name").in("id", userIds);
      for (const p of people ?? []) names.set(p.id, p.full_name);
    }
  }

  return (
    <>
      {company && workshopMode && dash ? (
        <DashboardHeader name={viewer.fullName || viewer.email} companyName={company.name} tz={tz} t={t} locale={locale} period={period} now={new Date(dash.now)}
          openChats={workload.reduce((n, w) => n + Number(w.open_conversations), 0)} />
      ) : (
        <PageHeader
          title={t.nav.dashboard}
          description={`${company?.name ?? t.common.allCompanies} · ${scopeHint}`}
          actions={<PeriodPicker preset={period.preset} from={period.from} to={period.to} />}
        />
      )}
      {company && workshopMode && dash ? (
        <WorkshopDashboard data={dash} t={t} locale={locale} now={dash.now} hidden={uiSettings.hiddenWidgets} />
      ) : rows.length === 0 ? (
        <EmptyState title={t.reports.noData} />
      ) : company && rows.length === 1 ? (
        <KpiTiles row={rows[0]} t={t} locale={locale} />
      ) : (
        <Section title={t.reports.companyComparison}>
          <KpiComparison rows={rows} t={t} locale={locale} />
          <p className="mt-2 text-xs text-muted-foreground">{t.reports.currencyNote}</p>
        </Section>
      )}
      {company && (
        <>
          {widget("leads_per_day") && <Section title={t.reports.leadsPerDay}>
            <LeadsPerDayChart rows={leadsDaily} />
          </Section>}
          {widget("response_speed") && <Section title={t.reports.speed.title} actions={<Link href="/reports?tab=whatsapp" className="text-xs text-primary hover:underline">{t.reports.tabs.whatsapp}</Link>}>
            <ResponseSpeedTiles overall={speed.find((r) => r.day === null)} t={t} locale={locale} />
            <h3 className="mb-1 mt-4 text-sm font-medium">{t.reports.speed.waitingNow} <span className="ltr-nums text-muted-foreground">({formatNumber(waiting.length, locale)})</span></h3>
            <WaitingNow rows={waiting} t={t} locale={locale} />
          </Section>}
          {!workshopMode && (
            <Section title={t.reports.trend}>
              <DailyCharts rows={daily} />
            </Section>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {widget("targets") && <Section title={t.reports.targets}>
              <TargetProgress rows={targets} names={names} t={t} locale={locale} targetCurrency={targetCurrency} />
            </Section>}
            {widget("whatsapp_load") && <Section title={t.reports.whatsappWorkload} actions={<Link href="/inbox" className="text-xs text-primary hover:underline">{t.nav.inbox}</Link>}>
              {workload.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.reports.noNumbers}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 text-start font-normal">{t.nav.whatsappNumbers}</th>
                      <th className="py-1 text-start font-normal">{t.reports.openConversations}</th>
                      <th className="py-1 text-start font-normal">{t.common.unassigned}</th>
                      <th className="py-1 text-start font-normal">{t.reports.unread}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {workload.map((w) => (
                      <tr key={w.whatsapp_account_id}>
                        <td className="py-1.5">{w.display_name}</td>
                        <td className="ltr-nums py-1.5">{formatNumber(w.open_conversations, locale)}</td>
                        <td className="ltr-nums py-1.5">{formatNumber(w.unassigned_conversations, locale)}</td>
                        <td className="ltr-nums py-1.5">{formatNumber(w.unread_conversations, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {t.reports.definitionsNote} <Link href="/reports" className="text-primary hover:underline">{t.nav.reports}</Link>
      </p>
    </>
  );
}
