import { formatCurrency, formatDuration, formatNumber, formatPercent } from "@/lib/format.ts";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database";
import type { Dictionary, Locale } from "@/i18n";

type Fns = Database["public"]["Functions"];
export type EmployeeDayRow = Fns["report_employee_day"]["Returns"][number];
export type ShiftActivityRow = Fns["report_shift_activity"]["Returns"][number];

type Props = {
  rows: EmployeeDayRow[];
  shiftRows: ShiftActivityRow[];
  /** "10:00–19:00 · Sun · Mon ..." per employee */
  shiftLabels: Record<string, string>;
  t: Dictionary;
  locale: Locale;
  testId?: string;
  /** printable: one employee per page */
  print?: boolean;
};

const hm = (v: string | null) => (v ? v.slice(0, 5) : "—");

function Stat({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "warn" | "good" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-background px-3 py-2 print:break-inside-avoid">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("ltr-nums text-lg font-semibold leading-tight", tone === "warn" && "text-amber-800", tone === "good" && "text-emerald-700")}>{children}</span>
    </div>
  );
}

/**
 * The daily report, one card per employee and one block per day with everything the employee did that day (WhatsApp chats and replies, reply speed,
 * leads, interested customers, bookings and payments with their totals per currency). Money is never added across currencies.
 */
export function EmployeeDayCards({ rows, shiftRows, shiftLabels, t, locale, testId, print }: Props) {
  const sx = t.shifts;
  const n = (v: number) => formatNumber(v, locale);
  const money = (j: unknown) => {
    const entries = Object.entries((j ?? {}) as Record<string, number | string>);
    return entries.length === 0 ? null : entries.map(([cur, amt]) => <span key={cur} className="block whitespace-nowrap text-sm font-medium">{formatCurrency(Number(amt), cur, locale)}</span>);
  };
  const weekday = (day: string) => new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-u-nu-latn", { weekday: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  const shiftOf = new Map(shiftRows.map((r) => [`${r.user_id}|${r.day}`, r]));

  const people = new Map<string, { name: string; days: EmployeeDayRow[] }>();
  for (const r of rows) {
    const key = r.user_id ?? "none";
    const p = people.get(key) ?? { name: r.user_id ? (r.full_name ?? "—") : sx.unassigned, days: [] };
    p.days.push(r);
    people.set(key, p);
  }

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {[...people].map(([key, p], idx) => {
        const real = key !== "none";
        let working = 0, absent = 0, inn = 0, out = 0;
        for (const d of p.days) {
          const s = real ? shiftOf.get(`${key}|${d.day}`) : undefined;
          if (d.working_day) working++;
          const did = (s?.in_shift ?? 0) + (s?.out_of_shift ?? 0);
          if (d.working_day && did === 0 && d.chats_opened + d.turns_answered + d.leads_created + d.bookings_count + d.payments_count === 0) absent++;
          inn += s?.in_shift ?? 0; out += s?.out_of_shift ?? 0;
        }
        return (
          <section key={key} className={cn("rounded-xl border bg-card", print && idx > 0 && "print:break-before-page")} data-testid="employee-card">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <h3 className="text-base font-semibold">{p.name}</h3>
                {real && <p className="ltr-nums text-xs text-muted-foreground">{shiftLabels[key] ?? sx.noShiftSet}</p>}
              </div>
              {real && working > 0 && (
                <p className="text-xs text-muted-foreground">
                  {sx.workDays}: <b className="ltr-nums text-foreground">{n(working)}</b> · {sx.absent}: <b className={cn("ltr-nums", absent > 0 ? "text-destructive" : "text-foreground")}>{n(absent)}</b>
                  {inn + out > 0 && <> · {sx.outPct}: <b className="ltr-nums text-foreground">{formatPercent(out / (inn + out), locale)}</b></>}
                </p>
              )}
            </header>
            <div className="flex flex-col divide-y">
              {p.days.map((d) => {
                const s = real ? shiftOf.get(`${key}|${d.day}`) : undefined;
                const nothing = d.chats_opened + d.turns_answered + d.turns_waiting + d.leads_created + d.interested_leads + d.bookings_count + d.payments_count === 0 && (s?.in_shift ?? 0) + (s?.out_of_shift ?? 0) === 0;
                return (
                  <div key={d.day} className="px-4 py-3 print:break-inside-avoid" data-testid="employee-day">
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="ltr-nums text-sm font-semibold">{d.day}</span>
                      <span className="text-sm text-muted-foreground">{weekday(d.day)}</span>
                      {real && d.has_shift && <span className="ltr-nums text-xs text-muted-foreground">{d.working_day ? `${sx.shift}: ${hm(d.shift_starts)}–${hm(d.shift_ends)}` : sx.dayOff}</span>}
                      {real && d.working_day && nothing && <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{sx.absentDay}</span>}
                    </div>
                    {nothing ? <p className="text-sm text-muted-foreground">{sx.noActivityDay}</p> : (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                        <Stat label={sx.chatsOpened}>{n(d.chats_opened)}</Stat>
                        {real && <Stat label={sx.chatsReplied}>{n(d.chats_replied)}</Stat>}
                        {real && <Stat label={sx.answered}>{n(d.turns_answered)}</Stat>}
                        <Stat label={sx.waiting} tone={d.turns_waiting > 0 ? "warn" : undefined}>{n(d.turns_waiting)}</Stat>
                        {real && <Stat label={sx.avgReply}>{formatDuration(d.avg_reply_seconds, locale)}</Stat>}
                        {real && <Stat label={sx.repliesSent}>{n((s?.replies_in ?? 0) + (s?.replies_out ?? 0))}</Stat>}
                        {real && <Stat label={sx.leads}>{n(d.leads_created)}</Stat>}
                        {real && <Stat label={sx.interested} tone={d.interested_leads > 0 ? "good" : undefined}>{n(d.interested_leads)}</Stat>}
                        {real && <Stat label={sx.bookingsCount}>{n(d.bookings_count)}<span className="mt-0.5 block font-normal">{money(d.bookings_amounts)}</span></Stat>}
                        {real && <Stat label={sx.paymentsCount}>{n(d.payments_count)}<span className="mt-0.5 block font-normal">{money(d.payments_amounts)}</span></Stat>}
                        {real && s && <Stat label={sx.inShift} tone="good">{n(s.in_shift)}</Stat>}
                        {real && s && <Stat label={sx.outShift} tone={s.out_of_shift > 0 ? "warn" : undefined}>{n(s.out_of_shift)}</Stat>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
