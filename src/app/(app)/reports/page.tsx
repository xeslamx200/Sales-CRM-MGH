import { Comparison } from "@/components/reports/comparison";
import { loadComparison } from "@/server/comparison-data";
import Link from "next/link";
import { FileDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { FilterBar } from "@/components/app/filter-bar";
import { PeriodPicker } from "@/components/reports/period-picker";
import { KpiComparison, KpiTiles, type KpiRow } from "@/components/reports/kpis";
import { LeadsPerDayChart, type LeadsDayRow } from "@/components/reports/leads-per-day-chart";
import { ResponseSpeedTiles, SpeedDailyTable, WaitingNow, type SpeedRow, type WaitingRow } from "@/components/reports/response-speed";
import { TargetProgress, type TargetRow } from "@/components/reports/targets";
import { TargetDialog } from "@/components/reports/target-form";
import { EmployeeDayCards } from "@/components/reports/employee-day";
import { WorkshopKpiTiles } from "@/components/reports/workshop-kpis";
import { getCompanyUiSettings } from "@/server/company-settings";
import { ShiftDialog, type ShiftPerson } from "@/components/reports/shift-dialog";
import { getViewer, isAdminOf, isManagerOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { reportPeriod } from "@/server/reports";
import { listMembers, peopleOptions } from "@/server/data/members";
import { oneOf, uuid } from "@/lib/search-params";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const TABS = ["overview", "comparison", "employees", "whatsapp", "shifts", "targets"] as const;

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const tab = oneOf(sp, "tab", TABS) ?? "overview";
  const company = viewer.activeCompany;
  const tz = company?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const period = reportPeriod(sp, tz);
  const teamId = uuid(sp, "team");
  const userId = uuid(sp, "user");
  const supabase = await createClient();
  const manager = company ? isManagerOf(viewer, company.id) : viewer.isSuperAdmin;
  const n = (v: number) => formatNumber(v, locale);

  // The overview figures do not depend on the team / member lists: start them first so both arrive in the same round trip.
  const overviewKpis = tab === "overview"
    ? supabase.rpc("report_company_kpis", {
      p_from: period.from, p_to: period.to, p_company_ids: viewer.scopeCompanyIds,
      p_team_id: teamId ?? undefined, p_user_id: userId ?? undefined,
    })
    : null;
  const [teams, members] = company
    ? await Promise.all([
      supabase.from("teams").select("id, name").eq("company_id", company.id).eq("is_active", true).order("name"),
      listMembers(supabase, [company.id], { activeOnly: true }),
    ])
    : [{ data: [] as { id: string; name: string }[] }, []];
  const teamOptions = (teams.data ?? []).map((x) => ({ value: x.id, label: x.name }));

  const tabLink = (key: (typeof TABS)[number]) => {
    const q = new URLSearchParams();
    for (const k of ["period", "from", "to"]) {
      const v = sp[k];
      if (typeof v === "string") q.set(k, v);
    }
    if (key !== "overview") q.set("tab", key);
    const s = q.toString();
    return s ? `/reports?${s}` : "/reports";
  };

  const header = (
    <>
      <PageHeader title={t.nav.reports} description={company?.name ?? t.common.allCompanies}
        actions={<PeriodPicker preset={period.preset} from={period.from} to={period.to} />} />
      <nav className="flex flex-wrap gap-1 border-b" aria-label={t.nav.reports}>
        {TABS.map((key) => (
          <Link key={key} href={tabLink(key)} aria-current={tab === key ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm",
              tab === key ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.reports.tabs[key]}
          </Link>
        ))}
      </nav>
    </>
  );

  // ------------------------------------------------------------- overview
  if (tab === "overview") {
    const { data, error } = await overviewKpis!;
    if (error) throw error;
    const rows = (data ?? []) as KpiRow[];
    let workshop: React.ReactNode = null;
    if (company && (await getCompanyUiSettings(supabase, company)).dashboardMode === "workshop") {
      const args = { p_company_id: company.id, p_from: period.from, p_to: period.to, ...(userId ? { p_user_id: userId } : {}) };
      const [wk, wb] = await Promise.all([supabase.rpc("report_workshop_kpis", args), supabase.rpc("report_workshop_breakdown", args)]);
      if (wk.error) throw wk.error;
      if (wb.error) throw wb.error;
      workshop = <WorkshopKpiTiles rows={wk.data ?? []} breakdown={wb.data ?? []} base={rows[0] ?? null} t={t} locale={locale} />;
    }
    return (
      <>
        {header}
        {company && manager && (
          <FilterBar filters={[
            { type: "select", name: "team", label: t.common.team, options: teamOptions },
            { type: "select", name: "user", label: t.reports.employee, options: peopleOptions(members) },
          ]} />
        )}
        {rows.length === 0 ? <EmptyState title={t.reports.noData} />
          : workshop ? workshop
          : company && rows.length === 1 ? <KpiTiles row={rows[0]} t={t} locale={locale} />
          : <KpiComparison rows={rows} t={t} locale={locale} />}
        <Definitions t={t} />
      </>
    );
  }

  if (!company) {
    return <>{header}<EmptyState title={t.reports.selectCompany} /></>;
  }

  // ----------------------------------------------------------- comparison
  if (tab === "comparison") {
    const workshop = (await getCompanyUiSettings(supabase, company)).dashboardMode === "workshop";
    const data = await loadComparison(supabase, company.id, period, workshop, userId);
    return (
      <>
        {header}
        {manager && <FilterBar filters={[{ type: "select", name: "user", label: t.reports.employee, options: peopleOptions(members) }]} />}
        <Comparison data={data} t={t} locale={locale} activeUserIds={new Set(members.map((m) => m.userId))} />
      </>
    );
  }

  // ------------------------------------------------------------ employees
  if (tab === "employees") {
    const { data, error } = await supabase.rpc("report_employee_performance", {
      p_company_id: company.id, p_from: period.from, p_to: period.to, p_team_id: teamId ?? undefined,
    });
    if (error) throw error;
    // "Assigned" = how many customers carry this employee's name right now (not the number of assignment events in the period)
    const ownedCounts = new Map<string, number>(await Promise.all((data ?? []).map(async (r) => {
      const { count } = await supabase.from("leads").select("id", { count: "exact", head: true })
        .eq("company_id", company.id).eq("owner_id", r.user_id).is("archived_at", null);
      return [r.user_id, count ?? 0] as const;
    })));
    const cols: { label: string; cell: (r: NonNullable<typeof data>[number]) => string }[] = [
      { label: t.reports.kpi.leadsCreated, cell: (r) => n(r.leads_created) },
      { label: t.reports.kpi.leadsAssigned, cell: (r) => n(ownedCounts.get(r.user_id) ?? 0) },
      { label: t.reports.kpi.leadsContacted, cell: (r) => n(r.leads_contacted) },
      { label: t.reports.kpi.meetings, cell: (r) => n(r.meetings_logged) },
      { label: t.reports.kpi.followUps, cell: (r) => n(r.follow_ups_completed) },
      { label: t.reports.kpi.overdueTasks, cell: (r) => n(r.overdue_tasks) },
      { label: t.reports.kpi.whatsappReplies, cell: (r) => n(r.whatsapp_replies) },
      { label: t.reports.kpi.signIns, cell: (r) => n(r.sign_ins) },
    ];
    return (
      <>
        {header}
        {manager && <FilterBar filters={[{ type: "select", name: "team", label: t.common.team, options: teamOptions }]} />}
        {(data ?? []).length === 0 ? <EmptyState title={t.reports.noData} /> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="sticky start-0 bg-muted px-3 py-2 text-start font-medium">{t.reports.employee}</th>
                  {cols.map((c) => <th key={c.label} className="whitespace-nowrap px-3 py-2 text-center font-medium">{c.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y">
                {(data ?? []).map((r) => (
                  <tr key={r.user_id}>
                    <td className="sticky start-0 bg-card px-3 py-2 font-medium">
                      <Link href={`/reports?user=${r.user_id}&period=${period.preset}${period.preset === "custom" ? `&from=${period.from}&to=${period.to}` : ""}`}
                        className="text-primary hover:underline">{r.full_name}</Link>
                    </td>
                    {cols.map((c) => <td key={c.label} className="ltr-nums px-3 py-2 text-center">{c.cell(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t.reports.signInsNote}</p>
        <Definitions t={t} />
      </>
    );
  }

  // --------------------------------------------------------------- shifts
  if (tab === "shifts") {
    const [rep, sh] = await Promise.all([
      supabase.rpc("report_shift_activity", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.from("employee_shifts").select("user_id, starts_at, ends_at, weekdays").eq("company_id", company.id).is("effective_to", null),
    ]);
    if (rep.error) throw rep.error;
    if (sh.error) throw sh.error;
    const day = await supabase.rpc("report_employee_day", { p_company_id: company.id, p_from: period.from, p_to: period.to, ...(userId ? { p_user_id: userId } : {}) });
    if (day.error) throw day.error;
    const dayRows = day.data ?? [];
    const pq = new URLSearchParams({ period: period.preset, from: period.from, to: period.to });
    if (userId) pq.set("user", userId);
    const printHref = `/daily-report?${pq.toString()}`;
    const sx = t.shifts;
    const hm = (v: string | null) => (v ? v.slice(0, 5) : "—");
    const open = new Map((sh.data ?? []).map((x) => [x.user_id, x]));
    const dayNames = (w: number[]) => [7, 1, 2, 3, 4, 5, 6].filter((d) => w.includes(d)).map((d) => sx.weekdays[d - 1]).join(" · ");
    const shiftLabels = Object.fromEntries((sh.data ?? []).map((x) => [x.user_id, `${hm(x.starts_at)}–${hm(x.ends_at)} · ${dayNames(x.weekdays)}`]));
    const people: ShiftPerson[] = members.filter((m) => m.role === "sales_agent" || m.role === "sales_manager").map((m) => {
      const x = open.get(m.userId);
      return { userId: m.userId, name: m.fullName, shift: x ? { starts: hm(x.starts_at), ends: hm(x.ends_at), weekdays: x.weekdays } : null };
    });
    return (
      <>
        {header}
        <p className="text-sm text-muted-foreground">{sx.hint}</p>
        {isAdminOf(viewer, company.id) && people.length > 0 && <div><ShiftDialog companyId={company.id} people={people} tz={tz} /></div>}
        {(sh.data ?? []).length === 0 && <EmptyState title={sx.noShifts} />}
        {dayRows.length === 0 ? ((sh.data ?? []).length === 0 ? null : <EmptyState title={sx.noData} />) : (
          <Section title={sx.dailyTitle} actions={<Button asChild variant="outline" size="sm"><a href={printHref} target="_blank" rel="noreferrer"><FileDown />{sx.downloadPdf}</a></Button>}>
            <div className="grid gap-3 p-4">
              <p className="text-sm text-muted-foreground">{sx.dailyHint}</p>
              <EmployeeDayCards rows={dayRows} shiftRows={rep.data ?? []} shiftLabels={shiftLabels} t={t} locale={locale} testId="shift-daily" />
            </div>
          </Section>
        )}
        <p className="text-xs text-muted-foreground">{sx.note}</p>
      </>
    );
  }

  // ------------------------------------------------------------- whatsapp
  if (tab === "whatsapp") {
    const [resp, ld, rs, wn] = await Promise.all([
      supabase.rpc("report_whatsapp_response", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_leads_per_day", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_response_speed", { p_company_id: company.id, p_from: period.from, p_to: period.to }),
      supabase.rpc("report_waiting_now", { p_company_id: company.id }),
    ]);
    const { data, error } = resp;
    if (error) throw error;
    if (ld.error) throw ld.error;
    if (rs.error) throw rs.error;
    if (wn.error) throw wn.error;
    const speed = (rs.data ?? []) as SpeedRow[];
    return (
      <>
        {header}
        <Section title={t.reports.leadsPerDay}><LeadsPerDayChart rows={(ld.data ?? []) as LeadsDayRow[]} /></Section>
        <Section title={t.reports.speed.title}>
          <ResponseSpeedTiles overall={speed.find((r) => r.day === null)} t={t} locale={locale} />
          <p className="mt-2 text-xs text-muted-foreground">{t.reports.speed.note}</p>
        </Section>
        <Section title={t.reports.speed.waitingNow}><WaitingNow rows={(wn.data ?? []) as WaitingRow[]} t={t} locale={locale} /></Section>
        <Section title={t.reports.speed.daily}><SpeedDailyTable rows={speed} t={t} locale={locale} /></Section>
        {(data ?? []).length === 0 ? <EmptyState title={t.reports.noData} /> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {[t.reports.employee, t.reports.kpi.turnsAnswered, t.reports.kpi.avgResponse, t.reports.kpi.medianResponse,
                    t.reports.kpi.within15m, t.reports.kpi.avgBusiness, t.reports.kpi.medianBusiness, t.reports.kpi.within15mBusiness,
                    t.reports.kpi.unanswered].map((h) => (
                    <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {(data ?? []).map((r, i) => (
                  <tr key={r.user_id ?? `unattributed-${i}`}>
                    <td className="px-3 py-2 font-medium">{r.user_id ? r.full_name : t.reports.unattributed}</td>
                    <td className="ltr-nums px-3 py-2">{n(r.turns_answered)}</td>
                    <td className="ltr-nums px-3 py-2">{formatDuration(r.avg_response_seconds, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{formatDuration(r.median_response_seconds, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{formatPercent(r.answered_within_15m, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{formatDuration(r.avg_business_seconds, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{formatDuration(r.median_business_seconds, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{formatPercent(r.business_within_15m, locale)}</td>
                    <td className="ltr-nums px-3 py-2">{n(r.unanswered_turns)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t.reports.whatsappNote}</p>
        {(data ?? []).length > 0 && (data ?? []).every((r) => r.avg_business_seconds == null) && (
          <p className="text-xs text-muted-foreground">
            {t.reports.businessHoursNotSet}{" "}
            {isAdminOf(viewer, company.id) && <Link href={`/admin/companies/${company.id}/hours`} className="text-primary hover:underline">{t.hours.title}</Link>}
          </p>
        )}
      </>
    );
  }

  // -------------------------------------------------------------- targets
  const { data, error } = await supabase.rpc("report_target_progress", { p_company_id: company.id, p_on: period.to });
  if (error) throw error;
  const names = new Map<string, string>([
    ...members.map((m) => [m.userId, m.fullName] as [string, string]),
    ...(teams.data ?? []).map((x) => [x.id, x.name] as [string, string]),
  ]);
  return (
    <>
      {header}
      <Section
        title={t.reports.targets}
        actions={manager && (
          <TargetDialog companyId={company.id} people={peopleOptions(members)} teams={teamOptions}
            trigger={<Button size="sm"><Plus />{t.reports.newTarget}</Button>} />
        )}
      >
        <TargetProgress rows={(data ?? []) as TargetRow[]} names={names} t={t} locale={locale} targetCurrency={(await supabase.rpc("company_target_currency", { p_company_id: company.id })).data ?? "EGP"} />
      </Section>
      <p className="text-xs text-muted-foreground">{t.reports.targetsNote}</p>
    </>
  );
}

function Definitions({ t }: { t: { reports: { definitions: string } } }) {
  return <p className="text-xs text-muted-foreground">{t.reports.definitions}</p>;
}
