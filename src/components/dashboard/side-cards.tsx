import Link from "next/link";
import { Initials } from "@/components/inbox/initials";
import type { Dictionary, Locale } from "@/i18n";
import { colorFor } from "@/lib/dashboard-math";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format.ts";

const card = "min-w-0 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_8px_24px_rgba(11,31,68,0.05)] ring-1 ring-foreground/5";

export type ShareRow = { id: string; name: string; value: number };

/**
 * Share of the booked revenue per workshop: the ring shows the top workshop's share at a glance (segments are separated by a 2px gap) and the ranked
 * bars below carry the comparison with the values written next to them. A workshop keeps its colour whatever its rank.
 */
export function WorkshopShareCard({ rows, allIds, currency, t, locale }: { rows: ShareRow[]; allIds: string[]; currency: string; t: Dictionary; locale: Locale }) {
  const d = t.dash;
  const total = rows.reduce((s, r) => s + r.value, 0);
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 3);
  const other = sorted.slice(3).reduce((s, r) => s + r.value, 0);
  const R = 40, C = 2 * Math.PI * R, GAP = 2;
  const segs = [...top.map((r) => ({ id: r.id, value: r.value, color: colorFor(r.id, allIds) })), ...(other > 0 ? [{ id: "other", value: other, color: "#a9b4c8" }] : [])];
  let acc = 0;
  return (
    <section className={card} aria-label={d.byWorkshop} data-testid="workshop-share">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{d.byWorkshop}</h2>
        <span className="text-xs text-muted-foreground ltr-nums">{currency}</span>
      </div>
      {total <= 0 ? <p className="text-sm text-muted-foreground">{t.workshopDash.noBookings}</p> : (
        <div className="flex items-center gap-4">
          <div className="relative size-28 shrink-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r={R} fill="none" stroke="#eef1f7" strokeWidth="14" />
              {segs.map((s) => {
                const len = Math.max(0, (s.value / total) * C - GAP);
                const el = <circle key={s.id} cx="50" cy="50" r={R} fill="none" stroke={s.color} strokeWidth="14" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} />;
                acc += (s.value / total) * C;
                return el;
              })}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="ltr-nums text-xl font-semibold">{formatPercent(top[0].value / total, locale)}</span>
            </div>
          </div>
          <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
            {top.map((r) => (
              <li key={r.id} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5"><span className="size-2 shrink-0 rounded-full" style={{ background: colorFor(r.id, allIds) }} /><span className="truncate">{r.name}</span></span>
                  <span className="ltr-nums font-medium">{formatPercent(r.value / total, locale)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[#eef1f7]"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.value / total) * 100)}%`, background: colorFor(r.id, allIds) }} /></div>
              </li>
            ))}
            {other > 0 && <li className="flex items-center justify-between text-xs text-muted-foreground"><span>{d.other}</span><span className="ltr-nums">{formatPercent(other / total, locale)}</span></li>}
          </ul>
        </div>
      )}
    </section>
  );
}

export type RecentRow = { id: string; name: string; sub: string; amount: number; currency: string; at: string };

function ago(at: string, locale: Locale, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  const rtf = new Intl.RelativeTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
  if (secs < 60) return rtf.format(0, "second");
  if (secs < 3600) return rtf.format(-Math.floor(secs / 60), "minute");
  if (secs < 86400) return rtf.format(-Math.floor(secs / 3600), "hour");
  return rtf.format(-Math.floor(secs / 86400), "day");
}

/** The latest bookings of the period: who, which workshop, how much, how long ago. */
export function LatestBookingsCard({ rows, t, locale, now }: { rows: RecentRow[]; t: Dictionary; locale: Locale; now: number }) {
  const d = t.dash;
  return (
    <section className={card} aria-label={d.latest} data-testid="latest-bookings">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{d.latest}</h2>
        <Link href="/bookings" className="text-xs text-primary hover:underline">{t.nav.bookings}</Link>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{d.noLatest}</p> : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/bookings/${r.id}`} className="flex items-center gap-3 rounded-xl bg-muted/50 px-3 py-2 hover:bg-muted">
                <Initials name={r.name} strong className="size-9 text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>
                </span>
                <span className="text-end">
                  <span className="block ltr-nums text-sm font-semibold">{formatCurrency(r.amount, r.currency, locale)}</span>
                  <span className="block text-xs text-muted-foreground">{ago(r.at, locale, now)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type TopRow = { id: string; name: string; bookings: number; booked: number; collected: number };

/** The workshops of the period ranked by booked revenue, one currency, with the share as a bar and every value written out. */
export function TopWorkshopsCard({ rows, allIds, currency, t, locale }: { rows: TopRow[]; allIds: string[]; currency: string; t: Dictionary; locale: Locale }) {
  const d = t.dash;
  const max = Math.max(1, ...rows.map((r) => r.booked));
  return (
    <section className={card} aria-label={d.topWorkshops} data-testid="top-workshops">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{d.topWorkshops}</h2>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground ltr-nums">{currency}</span>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t.workshopDash.noBookings}</p> : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-start font-medium">{t.workshopDash.workshop}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.workshopDash.bookings}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.workshopDash.collected}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t.workshopDash.booked}</th>
                <th className="w-1/4 px-2 py-1.5" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-2"><span className="flex items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: colorFor(r.id, allIds) }} /><span className="font-medium">{r.name}</span></span></td>
                  <td className="ltr-nums px-2 py-2">{formatNumber(r.bookings, locale)}</td>
                  <td className="ltr-nums whitespace-nowrap px-2 py-2">{formatCurrency(r.collected, currency, locale)}</td>
                  <td className="ltr-nums whitespace-nowrap px-2 py-2 font-medium">{formatCurrency(r.booked, currency, locale)}</td>
                  <td className="px-2 py-2" aria-hidden><div className="h-1.5 rounded-full bg-[#eef1f7]"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.booked / max) * 100)}%`, background: colorFor(r.id, allIds) }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Progress of the month's collected amount against the sum of the employees' targets (a single ratio, so a ring is enough). */
export function GoalCard({ goal, t, locale }: { goal: { actual: number; target: number; currency: string; people: number } | null; t: Dictionary; locale: Locale }) {
  const d = t.dash;
  const pct = goal && goal.target > 0 ? goal.actual / goal.target : 0;
  const R = 40, C = 2 * Math.PI * R;
  return (
    <section className="flex flex-col justify-center rounded-2xl bg-gradient-to-br from-[var(--brand-navy)] to-[var(--brand-navy-3)] p-5 text-white shadow-[0_12px_32px_rgba(11,31,68,0.25)]" aria-label={d.goal} data-testid="goal-card">
      <h2 className="mb-3 text-sm text-white/70">{d.goal}</h2>
      {!goal ? (
        <p className="text-sm text-white/80">{d.noGoal} <Link href="/performance" className="underline">{t.nav.performance}</Link></p>
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative size-28 shrink-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="10" />
              <circle cx="50" cy="50" r={R} fill="none" stroke="var(--brand-gold)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${Math.min(1, pct) * C} ${C}`} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="ltr-nums text-2xl font-semibold" data-testid="goal-percent">{formatPercent(pct, locale)}</span>
              <span className="text-[10px] text-white/60">{d.ofGoal}</span>
            </div>
          </div>
          <div className="min-w-0">
            <div className="ltr-nums text-sm text-white/70">{formatCurrency(goal.actual, goal.currency, locale)} / {formatCurrency(goal.target, goal.currency, locale)}</div>
            <div className="mt-1 text-xs text-white/60">{d.goalPeople.replace("{n}", formatNumber(goal.people, locale))}</div>
          </div>
        </div>
      )}
    </section>
  );
}
