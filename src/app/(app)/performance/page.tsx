import Link from "next/link";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { getViewer, isAdminOf, isManagerOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { todayBounds } from "@/server/crm";
import { str } from "@/lib/search-params";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format.ts";
import { commissionOf, nextTier, parseMonth, shiftMonth, type Tier } from "@/lib/commission.ts";
import { fmt } from "@/i18n";
import { cn } from "@/lib/utils";
import { TargetDialog, TiersDialog } from "./performance-dialogs";

const card = "rounded-2xl bg-card shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5";

function Bar({ value, label }: { value: number | null; label: string }) {
  const pct = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div className="mt-1 h-2 w-full rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={label}>
      <div className={cn("h-2 rounded-full", (value ?? 0) >= 1 ? "bg-success" : "bg-primary")} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/**
 * Monthly targets and commission per employee. Everything is computed by the database (report_monthly_commission): the confirmed payments an
 * employee recorded with a payment date inside the month, against their targets, and the commission tier reached. Visibility follows the other
 * reports: admins see every employee, a team manager their team, everyone else only themselves.
 */
export default async function PerformancePage({ searchParams }: PageProps<"/performance">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const company = viewer.activeCompany;
  if (!company) {
    return <><PageHeader title={t.performance.title} description={t.performance.subtitle} /><EmptyState icon={Trophy} title={t.performance.selectCompany} /></>;
  }
  const sp = await searchParams;
  const tz = company.timezone ?? "UTC";
  const today = todayBounds(tz).date;
  const month = parseMonth(str(sp, "month")) ?? `${today.slice(0, 7)}-01`;
  const supabase = await createClient();
  const [perf, tiersRes] = await Promise.all([
    supabase.rpc("report_monthly_commission", { p_company_id: company.id, p_month: month }),
    supabase.from("commission_tiers").select("min_attainment, rate").eq("company_id", company.id).order("min_attainment"),
  ]);
  if (perf.error) throw perf.error;
  const rows = perf.data ?? [];
  const tiers: Tier[] = (tiersRes.data ?? []).map((x) => ({ min: Number(x.min_attainment), rate: Number(x.rate) }));
  const cur = (await supabase.rpc("company_target_currency", { p_company_id: company.id })).data ?? "EGP";   // the currency the targets are written in (987)
  const eg = (n: number) => formatCurrency(n, cur, locale);
  const pctText = (f: number) => formatPercent(f, locale);
  const isAdmin = isAdminOf(viewer, company.id);
  const isManager = isManagerOf(viewer, company.id);
  const sum = (k: "achieved_amount" | "commission_egp") => rows.reduce((a, r) => a + Number(r[k]), 0);
  const canSetTarget = (userId: string) => isAdmin || (isManager && userId !== viewer.id);
  const nav = (delta: number) => `/performance?month=${shiftMonth(month, delta).slice(0, 7)}`;
  const monthLabel = new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}T00:00:00Z`));

  return (
    <>
      <PageHeader
        title={t.performance.title}
        description={`${company.name} · ${t.performance.subtitle}`}
        actions={
          <div className="flex items-center gap-1">
            <Button asChild variant="outline" size="icon-sm" aria-label={t.performance.prevMonth}><Link href={nav(-1)}><ChevronRight className="rtl:rotate-0 ltr:rotate-180" /></Link></Button>
            <span className="min-w-32 text-center text-sm font-medium" aria-live="polite">{monthLabel}</span>
            <Button asChild variant="outline" size="icon-sm" aria-label={t.performance.nextMonth}><Link href={nav(1)}><ChevronLeft className="rtl:rotate-0 ltr:rotate-180" /></Link></Button>
          </div>
        }
      />

      {rows.length > 1 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={cn(card, "p-4")}><p className="text-xs text-muted-foreground">{t.performance.totalCollected}</p><p className="ltr-nums mt-1 text-2xl font-semibold">{eg(sum("achieved_amount"))}</p></div>
          <div className={cn(card, "p-4")}><p className="text-xs text-muted-foreground">{t.performance.totalCommission}</p><p className="ltr-nums mt-1 text-2xl font-semibold text-success">{eg(sum("commission_egp"))}</p></div>
        </div>
      )}

      {rows.length === 0 ? <EmptyState icon={Trophy} title={t.performance.empty} /> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((r) => {
            const target = r.target_amount == null ? null : Number(r.target_amount);
            const achieved = Number(r.achieved_amount);
            const next = nextTier(tiers, target, achieved);
            const mine = r.user_id === viewer.id;
            return (
              <article key={r.user_id} className={cn(card, "flex flex-col gap-3 p-4", mine && rows.length > 1 && "ring-primary/30")} aria-label={r.full_name}>
                <header className="flex items-center justify-between gap-2">
                  <h2 className="min-w-0 truncate font-semibold">{mine && rows.length === 1 ? t.performance.mine : r.full_name}{mine && rows.length > 1 && " ·"}{mine && rows.length > 1 && <span className="ms-1 text-xs font-normal text-muted-foreground">{t.performance.mine}</span>}</h2>
                  {canSetTarget(r.user_id) && (
                    <TargetDialog currency={cur} companyId={company.id} userId={r.user_id} name={r.full_name} month={month} amount={target} customers={r.target_customers == null ? null : Number(r.target_customers)} />
                  )}
                </header>

                {r.target_source && (
                  <p className="-mt-1 text-xs text-muted-foreground">
                    {t.performance.targetSourceLabel}: <span className="font-medium text-foreground">{t.performance.targetSource[r.target_source as keyof typeof t.performance.targetSource] ?? r.target_source}</span>
                  </p>
                )}
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{t.performance.colAmount}</span>
                    <span className="ltr-nums"><b className="text-base">{eg(achieved)}</b>{target != null ? <> / {eg(target)} · <b>{pctText(Number(r.amount_attainment))}</b></> : <span className="ms-2 text-xs text-muted-foreground">{t.performance.noTarget}</span>}</span>
                  </div>
                  <Bar value={r.amount_attainment == null ? null : Number(r.amount_attainment)} label={t.performance.colAmount} />
                </div>

                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{t.performance.colCustomers}</span>
                    <span className="ltr-nums"><b className="text-base">{formatNumber(Number(r.achieved_customers), locale)}</b>{r.target_customers != null ? <> / {formatNumber(Number(r.target_customers), locale)} · <b>{pctText(Number(r.customers_attainment))}</b></> : <span className="ms-2 text-xs text-muted-foreground">{t.performance.noTarget}</span>}</span>
                  </div>
                  <Bar value={r.customers_attainment == null ? null : Number(r.customers_attainment)} label={t.performance.colCustomers} />
                </div>

                <div className="flex flex-wrap items-end justify-between gap-2 rounded-xl bg-accent px-3 py-2.5">
                  <div className="text-sm">
                    <p className="text-xs text-muted-foreground">{t.performance.colRate}</p>
                    <p className="ltr-nums font-semibold">{r.target_amount == null ? t.performance.noTarget : r.tier_min == null ? t.performance.tierNone : pctText(Number(r.rate))}</p>
                  </div>
                  <div className="text-end">
                    <p className="text-xs text-muted-foreground">{t.performance.colCommission}</p>
                    <p className="ltr-nums text-xl font-semibold text-success">{eg(Number(r.commission_egp))}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{target == null || tiers.length === 0 ? "" : next ? fmt(t.performance.nextTier, { amount: eg(next.missingEgp), rate: pctText(next.tier.rate) }) : t.performance.topTier}</span>
                  {Number(r.pending_amount) > 0 && <span>{t.performance.colPending}: <b className="ltr-nums text-foreground">{eg(Number(r.pending_amount))}</b></span>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className={cn(card, "flex flex-col gap-3 p-4")} aria-label={t.performance.rules}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Trophy className="size-4 text-muted-foreground" />{t.performance.rules}</h2>
          {isAdmin && <TiersDialog companyId={company.id} tiers={tiers} />}
        </div>
        {tiers.length === 0 ? <p className="text-sm text-muted-foreground">{t.performance.rulesEmpty}</p> : (
          <ul className="flex flex-col gap-1 text-sm">
            {tiers.map((x) => <li key={x.min}>{fmt(t.performance.ruleLine, { min: pctText(x.min), rate: pctText(x.rate) })} <span className="ltr-nums text-xs text-muted-foreground">({fmt(t.performance.ruleExample, { collected: eg(10000 * x.min), commission: eg(commissionOf(10000 * x.min, x.rate)) })})</span></li>)}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t.performance.commissionNote}</p>
      </section>
    </>
  );
}
