"use client";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { Delta } from "@/components/dashboard/stat-tile";
import { compactMoney } from "@/lib/dashboard-math";
import { formatCurrency } from "@/lib/format.ts";

export type HeroPoint = { day: string; label: string; current: number; previous: number | null };

const GOLD = "var(--brand-gold)";
const PREV = "#9db3d6";

/**
 * The headline chart: collected revenue per day for the chosen period (gold line) against the previous period of the same length (dashed).
 * Two series, so a legend is shown; a table view gives every value. Money of ONE currency only.
 */
export function RevenueHero({ points, currency, total, delta, title, currencyNote }: { points: HeroPoint[]; currency: string; total: number; delta: number | null; title: string; currencyNote?: string }) {
  const { t, locale, dir } = useI18n();
  const d = t.dash;
  const [table, setTable] = useState(false);
  const rtl = dir === "rtl";
  const money = (v: number) => formatCurrency(v, currency, locale);

  return (
    <section className="flex h-full flex-col rounded-2xl bg-gradient-to-br from-[var(--brand-navy)] to-[var(--brand-navy-3)] p-5 text-white shadow-[0_12px_32px_rgba(11,31,68,0.25)]" aria-label={title} data-testid="revenue-hero">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm text-white/70">{title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="ltr-nums text-4xl font-semibold tracking-tight">{compactMoney(total, currency, locale)}</span>
            <span className="[&_span]:!bg-white/10 [&_span]:!text-white"><Delta pct={delta} locale={locale} label={d.vsPrevious} /></span>
            {delta !== null && <span className="text-xs text-white/60">{d.vsPrevious}</span>}
          </div>
          {currencyNote && <p className="mt-1 text-xs text-white/60">{currencyNote}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <ul className="flex items-center gap-4 text-xs text-white/80" aria-label={d.legend}>
            <li className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: GOLD }} />{d.thisPeriod}</li>
            <li className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: PREV }} />{d.previous}</li>
          </ul>
          <Button variant="ghost" size="sm" className="text-white/80 hover:bg-white/10 hover:text-white" onClick={() => setTable((v) => !v)} aria-pressed={table}>
            <Table2 />{table ? t.reports.showChart : t.reports.showTable}
          </Button>
        </div>
      </div>

      {table ? (
        <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-white/15">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--brand-navy)]">
              <tr><th className="px-3 py-2 text-start font-medium">{t.common.date}</th><th className="px-3 py-2 text-start font-medium">{d.thisPeriod}</th><th className="px-3 py-2 text-start font-medium">{d.previous}</th></tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {points.map((p) => (
                <tr key={p.day}>
                  <td className="ltr-nums px-3 py-1.5">{p.day}</td>
                  <td className="ltr-nums px-3 py-1.5">{money(p.current)}</td>
                  <td className="ltr-nums px-3 py-1.5 text-white/70">{p.previous == null ? "—" : money(p.previous)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 h-72 min-h-0 flex-1" dir="ltr" role="img" aria-label={`${title}: ${compactMoney(total, currency, locale)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 12, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="heroGold" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GOLD} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={GOLD} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 11, fill: "rgba(255,255,255,0.65)" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.15)" }} minTickGap={24} />
              <YAxis orientation={rtl ? "right" : "left"} width={52} tick={{ fontSize: 11, fill: "rgba(255,255,255,0.65)" }} tickLine={false} axisLine={false}
                tickFormatter={(v) => new Intl.NumberFormat("en", { notation: "compact" }).format(Number(v))} />
              <Tooltip cursor={{ stroke: "rgba(255,255,255,0.35)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as HeroPoint;
                  return (
                    <div className="rounded-lg border border-white/15 bg-[var(--brand-navy-3)] px-3 py-2 text-xs text-white shadow-lg" dir={dir}>
                      <div className="mb-1 ltr-nums font-medium">{p.day}</div>
                      <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-3" style={{ background: GOLD }} />{d.thisPeriod}: <b className="ltr-nums">{money(p.current)}</b></div>
                      {p.previous != null && <div className="flex items-center gap-2 text-white/80"><span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: PREV }} />{d.previous}: <b className="ltr-nums">{money(p.previous)}</b></div>}
                    </div>
                  );
                }} />
              <Area type="monotone" dataKey="previous" stroke={PREV} strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} activeDot={false} isAnimationActive={false} connectNulls />
              <Area type="monotone" dataKey="current" stroke={GOLD} strokeWidth={2} fill="url(#heroGold)" dot={false}
                activeDot={{ r: 5, fill: GOLD, stroke: "var(--brand-navy)", strokeWidth: 2 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
