import { Briefcase, CalendarCheck, CircleDollarSign, MessageCircleReply, UserPlus, Users } from "lucide-react";
import { Delta } from "@/components/dashboard/stat-tile";
import { Section } from "@/components/app/page-header";
import type { Dictionary, Locale } from "@/i18n";
import { compactMoney, deltaPct } from "@/lib/dashboard-math";
import { formatDuration, formatNumber } from "@/lib/format.ts";
import { cn } from "@/lib/utils";
import type { ComparisonData } from "@/server/comparison-data";

type Icon = React.ComponentType<{ className?: string }>;

/** A big figure, what it was in the previous period, and the change. Direction is shown by arrow and sign, never by colour alone. */
function CompareTile({ label, value, previous, delta, locale, icon: IconC, previousLabel }: {
  label: string; value: string; previous: string; delta: number | null; locale: Locale; icon: Icon; previousLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_8px_24px_rgba(11,31,68,0.05)] ring-1 ring-foreground/5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-[color:var(--brand-gold-ink)]"><IconC className="size-[18px]" /></span>
          <span className="truncate text-sm text-muted-foreground">{label}</span>
        </div>
        <Delta pct={delta} locale={locale} />
      </div>
      <div className="ltr-nums self-start text-3xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{previousLabel}: <span className="ltr-nums">{previous}</span></div>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <div className="relative min-w-0 max-w-full overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.length === 0 && <tr><td colSpan={head.length} className="px-3 py-6 text-center text-muted-foreground">{empty}</td></tr>}
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={cn("px-3 py-2", j > 0 && "ltr-nums")}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** Reports -> Comparison: this period against the previous one, the last six months, and breakdowns by workshop and by employee. Money stays per currency. */
export function Comparison({ data, t, locale, activeUserIds }: { data: ComparisonData; t: Dictionary; locale: Locale; activeUserIds?: ReadonlySet<string> }) {
  const c = t.compare;
  const n = (v: number | null | undefined) => formatNumber(v ?? 0, locale);
  const money = (v: number, cur: string) => compactMoney(v, cur, locale);
  const prevLabel = c.previous;
  const cur = [...new Set([...data.kpis, ...data.prevKpis].map((k) => (k.currency ?? "").trim()).filter(Boolean))].sort();
  const byCur = <R extends { currency: string | null }>(rows: R[], currency: string): R | undefined => rows.find((r) => (r.currency ?? "").trim() === currency);

  // ---- key figures
  const tiles: React.ReactNode[] = [];
  const add = (key: string, label: string, v: number, p: number, icon: Icon, fmt: (x: number) => string = n) =>
    tiles.push(<CompareTile key={key} label={label} value={fmt(v)} previous={fmt(p)} delta={deltaPct(v, p)} locale={locale} icon={icon} previousLabel={prevLabel} />);
  if (data.base) {
    add("leads", t.reports.kpi.leadsCreated, data.base.leads_created, data.basePrev?.leads_created ?? 0, UserPlus);
    add("acts", t.reports.kpi.activities, data.base.activities_logged, data.basePrev?.activities_logged ?? 0, CalendarCheck);
    add("tasks", t.reports.kpi.tasksCompleted, data.base.tasks_completed, data.basePrev?.tasks_completed ?? 0, Briefcase);
  }
  if (data.workshop) {
    for (const code of cur) {
      const a = byCur(data.kpis, code), b = byCur(data.prevKpis, code);
      add(`col-${code}`, `${c.collected} (${code})`, Number(a?.collected ?? 0), Number(b?.collected ?? 0), CircleDollarSign, (x) => money(x, code));
      add(`bk-${code}`, `${c.bookings} (${code})`, Number(a?.bookings ?? 0), Number(b?.bookings ?? 0), Users);
    }
  }
  const respNow = data.response.filter((r) => r.user_id), respOld = data.prevResponse.filter((r) => r.user_id);
  const answeredNow = respNow.reduce((s, r) => s + Number(r.turns_answered), 0), answeredOld = respOld.reduce((s, r) => s + Number(r.turns_answered), 0);
  add("answered", c.answeredChats, answeredNow, answeredOld, MessageCircleReply);

  // ---- period vs previous (table)
  const pair = (label: string, v: number, p: number, fmt: (x: number) => string = n): React.ReactNode[] => [label, fmt(v), fmt(p), <Delta key={label} pct={deltaPct(v, p)} locale={locale} />];
  const periodRows: React.ReactNode[][] = [];
  if (data.base) {
    periodRows.push(pair(t.reports.kpi.leadsCreated, data.base.leads_created, data.basePrev?.leads_created ?? 0));
    periodRows.push(pair(t.reports.kpi.activities, data.base.activities_logged, data.basePrev?.activities_logged ?? 0));
    periodRows.push(pair(t.reports.kpi.tasksCompleted, data.base.tasks_completed, data.basePrev?.tasks_completed ?? 0));
    periodRows.push(pair(t.reports.kpi.overdueTasks, data.base.overdue_tasks, data.basePrev?.overdue_tasks ?? 0));
  }
  if (data.workshop) {
    for (const code of cur) {
      const a = byCur(data.kpis, code), b = byCur(data.prevKpis, code);
      periodRows.push(pair(`${c.bookings} (${code})`, Number(a?.bookings ?? 0), Number(b?.bookings ?? 0)));
      periodRows.push(pair(`${c.customers} (${code})`, Number(a?.customers ?? 0), Number(b?.customers ?? 0)));
      periodRows.push(pair(`${c.bookedValue} (${code})`, Number(a?.booked_value ?? 0), Number(b?.booked_value ?? 0), (x) => money(x, code)));
      periodRows.push(pair(`${c.collected} (${code})`, Number(a?.collected ?? 0), Number(b?.collected ?? 0), (x) => money(x, code)));
      periodRows.push(pair(`${c.remaining} (${code})`, Number(a?.remaining ?? 0), Number(b?.remaining ?? 0), (x) => money(x, code)));
      const avg = (k: typeof a) => (k && Number(k.bookings) > 0 ? Number(k.booked_value ?? 0) / Number(k.bookings) : 0);
      periodRows.push(pair(`${c.avgBooking} (${code})`, avg(a), avg(b), (x) => money(x, code)));
    }
  }

  // ---- six months (per currency; never summed across currencies)
  const monthRows: React.ReactNode[][] = [];
  for (const code of cur.length ? cur : [""]) {
    data.months.forEach((m, i) => {
      const k = code ? byCur(m.kpis, code) : m.kpis[0];
      const prev = i > 0 ? (code ? byCur(data.months[i - 1].kpis, code) : data.months[i - 1].kpis[0]) : undefined;
      monthRows.push([
        code ? `${m.label} · ${code}` : m.label, n(Number(k?.bookings ?? 0)), code ? money(Number(k?.booked_value ?? 0), code) : "—", code ? money(Number(k?.collected ?? 0), code) : "—",
        <Delta key={m.key + code} pct={prev ? deltaPct(Number(k?.collected ?? 0), Number(prev.collected ?? 0)) : null} locale={locale} />,
      ]);
    });
  }

  // ---- by workshop
  const bdCur = new Map(data.breakdown.map((r) => [`${r.offering_id}|${r.currency.trim()}`, r]));
  const bdOld = new Map(data.prevBreakdown.map((r) => [`${r.offering_id}|${r.currency.trim()}`, r]));
  const bdKeys = [...new Set([...bdCur.keys(), ...bdOld.keys()])];
  const workshopRows = bdKeys.map((k) => {
    const a = bdCur.get(k), b = bdOld.get(k);
    const code = (a?.currency ?? b?.currency ?? "").trim();
    return { name: a?.offering_name ?? b?.offering_name ?? "—", code, v: Number(a?.collected ?? 0), p: Number(b?.collected ?? 0), bk: Number(a?.bookings ?? 0), pb: Number(b?.bookings ?? 0) };
  }).sort((x, y) => y.v - x.v);
  const wsRows = workshopRows.map((r) => [`${r.name} · ${r.code}`, n(r.bk), n(r.pb), money(r.v, r.code), money(r.p, r.code), <Delta key={r.name + r.code} pct={deltaPct(r.v, r.p)} locale={locale} />]);

  // ---- by employee
  const prevEmp = new Map(data.prevEmployees.map((e) => [e.user_id, e]));
  const respOf = new Map(data.response.filter((r) => r.user_id).map((r) => [r.user_id as string, r]));
  const respOldOf = new Map(data.prevResponse.filter((r) => r.user_id).map((r) => [r.user_id as string, r]));
  // people who left or were deactivated do not clutter the table (their figures stay in the totals above)
  const empRows = [...data.employees].filter((e) => !activeUserIds || activeUserIds.has(e.user_id)).sort((a, b) => b.leads_contacted + b.whatsapp_replies - (a.leads_contacted + a.whatsapp_replies)).map((e) => {
    const p = prevEmp.get(e.user_id);
    const r = respOf.get(e.user_id), ro = respOldOf.get(e.user_id);
    return [
      e.full_name, n(e.leads_created), n(e.leads_contacted), <span key="d1" className="inline-flex items-center gap-2">{n(e.whatsapp_replies)}<Delta pct={deltaPct(e.whatsapp_replies, p?.whatsapp_replies ?? 0)} locale={locale} /></span>,
      n(e.meetings_logged), n(e.follow_ups_completed),
      r?.median_response_seconds != null ? formatDuration(Number(r.median_response_seconds), locale) : "—",
      ro?.median_response_seconds != null ? formatDuration(Number(ro.median_response_seconds), locale) : "—",
    ];
  });

  return (
    <div className="grid min-w-0 grid-cols-1 gap-5" data-testid="comparison">
      <p className="text-sm text-muted-foreground">
        {c.hint} <span className="ltr-nums">{data.period.from} → {data.period.to}</span> · {prevLabel}: <span className="ltr-nums">{data.previous.from} → {data.previous.to}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{tiles}</div>
      <Section title={c.periodTable}><div className="p-3"><Table head={[c.metric, c.current, prevLabel, c.change]} rows={periodRows} empty={t.reports.noData} /></div></Section>
      {data.workshop && (
        <>
          <Section title={c.monthsTable}><div className="p-3"><Table head={[c.month, c.bookings, c.bookedValue, c.collected, c.change]} rows={monthRows} empty={t.reports.noData} /></div></Section>
          <Section title={c.byWorkshop}><div className="p-3"><Table head={[c.workshop, c.bookings, `${c.bookings} (${prevLabel})`, c.collected, `${c.collected} (${prevLabel})`, c.change]} rows={wsRows} empty={t.reports.noData} /></div></Section>
        </>
      )}
      <Section title={c.byEmployee}>
        <div className="p-3">
          <Table head={[t.reports.employee, t.reports.kpi.leadsCreated, t.reports.kpi.leadsContacted, t.reports.kpi.whatsappReplies, t.reports.kpi.meetings, t.reports.kpi.followUps, c.medianReply, `${c.medianReply} (${prevLabel})`]}
            rows={empRows} empty={t.reports.noData} />
        </div>
      </Section>
      <p className="text-xs text-muted-foreground">{c.footnote}</p>
    </div>
  );
}
