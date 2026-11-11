import Link from "next/link";
import { Banknote, ShoppingBag, UserPlus, Wallet } from "lucide-react";
import { PeriodPicker } from "@/components/reports/period-picker";
import { StatTile } from "@/components/dashboard/stat-tile";
import { RevenueHero, type HeroPoint } from "@/components/dashboard/revenue-hero";
import { GoalCard, LatestBookingsCard, TopWorkshopsCard, WorkshopShareCard } from "@/components/dashboard/side-cards";
import type { DashboardData } from "@/server/dashboard-data";
import type { Dictionary, Locale } from "@/i18n";
import { compactMoney, dayPart, deltaPct } from "@/lib/dashboard-math";
import { formatNumber } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const PRESETS = ["last_7_days", "last_30_days", "this_month"] as const;

/** Greeting, a live count of open chats and the period pills (7 days / 30 days / this month, or a custom range in the picker). */
export function DashboardHeader({ name, companyName, tz, t, locale, openChats, period, now }: {
  name: string; companyName: string; tz: string; t: Dictionary; locale: Locale; openChats: number;
  period: { preset: string; from: string; to: string }; now: Date;
}) {
  const d = t.dash;
  const part = dayPart(now, tz);
  const greeting = part === "morning" ? d.greetMorning : part === "afternoon" ? d.greetAfternoon : d.greetEvening;
  const label = { last_7_days: d.period7, last_30_days: d.period30, this_month: d.periodMonth } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting}{locale === "ar" ? "،" : ","} {name.split(" ")[0]} 👋</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {d.subtitle.replace("{company}", companyName)}
          <Link href="/inbox" className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-[color:var(--brand-gold-ink)]">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-600" aria-hidden />{d.openChats.replace("{n}", formatNumber(openChats, locale))}
          </Link>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex rounded-xl bg-card p-1 shadow-[0_1px_2px_rgba(11,31,68,0.06)] ring-1 ring-foreground/5" aria-label={d.periodNav} data-testid="period-pills">
          {PRESETS.map((p) => (
            <Link key={p} href={`/?period=${p}`} aria-current={period.preset === p ? "page" : undefined}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", period.preset === p ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label[p]}
            </Link>
          ))}
        </nav>
        <PeriodPicker preset={period.preset as never} from={period.from} to={period.to} />
      </div>
    </div>
  );
}

/** The workshop company's dashboard: revenue from bookings and payments, always one currency per figure. */
export function WorkshopDashboard({ data, t, locale, now, hidden = [] }: { data: DashboardData; t: Dictionary; locale: Locale; now: number; hidden?: readonly string[] }) {
  const show = (w: string) => !hidden.includes(w);
  const d = t.dash;
  const money = data.kpis.filter((r) => r.currency !== null);
  const totals = data.kpis.find((r) => r.currency === null);
  const prevTotals = data.prevKpis.find((r) => r.currency === null);
  const ranked = [...money].sort((a, b) => (b.collected ?? 0) + (b.booked_value ?? 0) - ((a.collected ?? 0) + (a.booked_value ?? 0)));
  const P = ranked[0]?.currency?.trim() ?? "";
  const cur = ranked[0] ?? null;
  const prevCur = data.prevKpis.find((r) => r.currency?.trim() === P) ?? null;
  const others = ranked.slice(1);

  const dayVal = (day: string, key: "collected" | "booked_value" | "bookings", onlyP: boolean, rows = data.daily) =>
    rows.filter((r) => r.day === day && (!onlyP || r.currency.trim() === P)).reduce((s, r) => s + Number(r[key]), 0);
  const collectedSpark = data.days.map((x) => dayVal(x, "collected", true));
  const bookedSpark = data.days.map((x) => dayVal(x, "booked_value", true));
  const bookingsSpark = data.days.map((x) => dayVal(x, "bookings", false));
  const leadsMap = new Map(data.leadsPerDay.map((r) => [r.day, r.total]));
  const leadsSpark = data.days.map((x) => leadsMap.get(x) ?? 0);

  const avg = cur && (cur.bookings ?? 0) > 0 ? (cur.booked_value ?? 0) / cur.bookings : 0;
  const prevAvg = prevCur && (prevCur.bookings ?? 0) > 0 ? (prevCur.booked_value ?? 0) / prevCur.bookings : 0;
  const short = new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-u-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" });
  const points: HeroPoint[] = data.days.map((x, i) => ({
    day: x, label: short.format(new Date(`${x}T12:00:00Z`)), current: dayVal(x, "collected", true),
    previous: data.prevDays[i] ? dayVal(data.prevDays[i], "collected", true, data.prevDaily) : null,
  }));

  const inP = data.breakdown.filter((r) => r.currency.trim() === P);
  const allIds = [...new Set(data.breakdown.map((r) => r.offering_id))];
  const share = inP.map((r) => ({ id: r.offering_id, name: r.offering_name, value: Number(r.booked_value) })).filter((r) => r.value > 0);
  const top = [...inP].sort((a, b) => Number(b.booked_value) - Number(a.booked_value)).slice(0, 5)
    .map((r) => ({ id: r.offering_id, name: r.offering_name, bookings: Number(r.bookings), booked: Number(r.booked_value), collected: Number(r.collected) }));
  const recent = data.recent.map((r) => ({ id: r.booking_id, name: r.customer_name, sub: `${r.offering_name} · ${r.group_name}`, amount: Number(r.final_price), currency: r.currency.trim(), at: r.booked_at }));
  const otherNote = others.length ? d.otherCurrencies.replace("{list}", others.map((o) => compactMoney(o.collected ?? 0, o.currency ?? "", locale)).join(" · ")) : undefined;
  const n = (v: number | null | undefined) => formatNumber(v ?? 0, locale);

  return (
    <div className="flex flex-col gap-4" data-testid="workshop-dashboard">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile testId="tile-collected" label={d.kpiCollected} value={P ? compactMoney(cur?.collected ?? 0, P, locale) : "—"} hint={otherNote}
          delta={deltaPct(cur?.collected ?? 0, prevCur?.collected ?? 0)} locale={locale} icon={Wallet} values={collectedSpark} />
        <StatTile testId="tile-bookings" label={d.kpiBookings} value={n(totals?.bookings)} hint={`${t.workshopDash.cancelled}: ${n(totals?.cancelled)}`}
          delta={deltaPct(totals?.bookings ?? 0, prevTotals?.bookings ?? 0)} locale={locale} icon={ShoppingBag} values={bookingsSpark} />
        <StatTile testId="tile-leads" label={d.kpiLeads} value={n(totals?.leads_created)} hint={`${t.workshopDash.leadsBooked}: ${n(totals?.leads_booked)}`}
          delta={deltaPct(totals?.leads_created ?? 0, prevTotals?.leads_created ?? 0)} locale={locale} icon={UserPlus} values={leadsSpark} />
        <StatTile testId="tile-avg" label={d.kpiAvg} value={P ? compactMoney(avg, P, locale) : "—"} hint={P ? `${t.workshopDash.booked}: ${compactMoney(cur?.booked_value ?? 0, P, locale)}` : undefined}
          delta={deltaPct(avg, prevAvg)} locale={locale} icon={Banknote} values={bookedSpark} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        {!show("revenue_chart") ? <div className="hidden xl:block" /> : P ? <RevenueHero points={points} currency={P} total={cur?.collected ?? 0} delta={deltaPct(cur?.collected ?? 0, prevCur?.collected ?? 0)} title={d.revenue} currencyNote={otherNote} />
          : <div className="rounded-2xl bg-card p-6 text-sm text-muted-foreground ring-1 ring-foreground/5">{t.workshopDash.noBookings}</div>}
        <div className="flex min-w-0 flex-col gap-4">
          {show("workshop_share") && <WorkshopShareCard rows={share} allIds={allIds} currency={P} t={t} locale={locale} />}
          {show("latest_bookings") && <LatestBookingsCard rows={recent} t={t} locale={locale} now={now} />}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        {show("top_workshops") ? <TopWorkshopsCard rows={top} allIds={allIds} currency={P} t={t} locale={locale} /> : <div className="hidden xl:block" />}
        {show("goal") && <GoalCard goal={data.goal} t={t} locale={locale} />}
      </div>
      <p className="text-xs text-muted-foreground">{t.workshopDash.note}</p>
    </div>
  );
}
