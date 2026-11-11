import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { FilterBar } from "@/components/app/filter-bar";
import { BookingsTable, type BookingRow } from "@/components/bookings/bookings-table";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { uuid } from "@/lib/search-params";
import { countryName } from "@/lib/workshop-config.ts";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Money = { currency: string; collected: number; pending: number; rejected: number; outstanding: number; total_final: number; total_list: number; discounts: number };

/** One workshop: overview (prices, groups), statistics (money per currency, never summed across currencies) and its bookings with CSV / Excel export. */
export default async function WorkshopPage({ params, searchParams }: PageProps<"/workshops/[id]">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const b = t.bookings;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const groupFilter = uuid(sp, "group");
  const supabase = await createClient();
  const { data: off } = await supabase.from("company_offerings").select("id, company_id, name, kind, is_active").eq("id", id).maybeSingle();
  if (!off) notFound();
  const tz = viewer.companies.find((c) => c.id === off.company_id)?.timezone ?? "UTC";
  const [prices, groups, gstats, stats, list] = await Promise.all([
    supabase.from("workshop_prices").select("id, country, attendance, currency, price, is_active").eq("offering_id", id).order("country").order("attendance"),
    supabase.from("workshop_groups").select("id, name, sessions, capacity, attendance, is_active").eq("offering_id", id).order("starts_on"),
    supabase.rpc("workshop_group_stats", { p_offering_id: id }),
    supabase.rpc("workshop_stats", { p_offering_id: id }),
    supabase.rpc("workshop_bookings_list", { p_offering_id: id, p_group_id: groupFilter ?? undefined }),
  ]);
  for (const r of [prices, groups, gstats, stats, list]) if (r.error) throw r.error;
  const s = stats.data?.[0];
  const money = ((s?.by_currency ?? []) as unknown as Money[]);
  const booked = new Map((gstats.data ?? []).map((x) => [x.group_id, Number(x.booked)]));
  const att = (a: string | null) => (a === "online" ? b.online : a === "offline" ? b.offline : "—");
  const qs = groupFilter ? `&group=${groupFilter}` : "";
  const exp = (fmt: "csv" | "xlsx") => `/api/export/workshop/${id}?format=${fmt}${qs}`;
  const num = (v: number | undefined) => formatNumber(Number(v ?? 0), locale);
  const cards: [string, number | undefined][] = [
    [b.statTotal, s?.total_bookings], [b.statActive, s?.active_bookings], [b.statCancelled, s?.cancelled_bookings], [b.statCustomers, s?.customers],
    [b.statPaid, s?.paid], [b.statPartial, s?.partially_paid], [b.statUnpaid, s?.unpaid], [b.statPendingApproval, s?.pending_approval], [b.statRejected, s?.rejected],
    [b.statOnline, s?.online_participants], [b.statOffline, s?.offline_participants], [b.statDiscounted, s?.discounted_bookings],
    [b.statPendingDiscounts, s?.pending_discounts], [b.statRejectedDiscounts, s?.rejected_discounts],
  ];

  return (
    <>
      <PageHeader title={off.name} description={b.wkSub}
        actions={<Button asChild variant="outline"><Link href="/workshops"><ArrowLeft className="rtl:rotate-180" />{b.wkTitle}</Link></Button>} />

      <Section title={b.wkOverview}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">{b.wkPrices}</h3>
            {(prices.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{b.wkNoPrices}</p> : (
              <ul className="divide-y rounded-lg border text-sm" data-testid="prices-list">
                {(prices.data ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span>{countryName(p.country, locale)} · {att(p.attendance)}</span>
                    <span className={`ltr-nums font-medium ${p.is_active ? "" : "text-muted-foreground line-through"}`}>{formatCurrency(Number(p.price), p.currency, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">{b.wkGroups}</h3>
            {(groups.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t.workshopConfig.noGroups}</p> : (
              <ul className="divide-y rounded-lg border text-sm" data-testid="groups-list">
                {(groups.data ?? []).map((g) => {
                  const n = booked.get(g.id) ?? 0;
                  const pct = g.capacity ? Math.min(100, Math.round((n / g.capacity) * 100)) : null;
                  return (
                    <li key={g.id} className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium" dir="auto">{g.name}</span>
                        <StatusBadge tone={g.is_active ? "success" : "neutral"}>{g.is_active ? t.common.active : b.wkInactive}</StatusBadge>
                      </div>
                      <p className="ltr-nums text-xs text-muted-foreground">{g.sessions.map((d) => formatDate(d, "UTC", locale)).join(" · ")} · {att(g.attendance)}</p>
                      <p className="mt-1 text-xs">{b.occupancy}: <b className="ltr-nums">{formatNumber(n, locale)}{g.capacity ? ` / ${formatNumber(g.capacity, locale)}` : ` (${b.unlimited})`}</b></p>
                      {pct != null && <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section title={b.wkStats}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="stat-cards">
          {cards.map(([label, v]) => (
            <div key={label} className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="ltr-nums mt-1 text-xl font-semibold">{num(v)}</p>
            </div>
          ))}
        </div>
        <h3 className="mb-2 mt-5 text-sm font-medium">{b.perCurrency}</h3>
        {money.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
          <div className="relative overflow-x-auto rounded-lg border" data-testid="currency-table">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>{[b.colCurrency, b.cList, b.cDisc, b.cFinal, b.cColl, b.cPend, b.cRej, b.cOut].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y">
                {money.map((c) => {
                  const f = (v: number) => formatCurrency(Number(v), c.currency, locale);
                  return (
                    <tr key={c.currency}>
                      <td className="px-3 py-2 font-semibold">{c.currency}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2">{f(c.total_list)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2">{f(c.discounts)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2">{f(c.total_final)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2 font-medium">{f(c.collected)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2">{f(c.pending)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2">{f(c.rejected)}</td>
                      <td className="ltr-nums whitespace-nowrap px-3 py-2 font-medium">{f(c.outstanding)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{b.currencyNote}</p>
        <p className="text-xs text-muted-foreground">{b.visibilityNote}</p>
      </Section>

      <Section title={b.wkBookings} actions={
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline"><a href={exp("csv")}><Download />{b.exportCsv}</a></Button>
          <Button asChild size="sm" variant="outline"><a href={exp("xlsx")}><FileSpreadsheet />{b.exportExcel}</a></Button>
        </div>
      }>
        <FilterBar className="mb-3" filters={[{ type: "select", name: "group", label: b.filterGroup, allLabel: b.allGroups, options: (groups.data ?? []).map((g) => ({ value: g.id, label: g.name })) }]} />
        <BookingsTable rows={(list.data ?? []) as unknown as BookingRow[]} t={t} locale={locale} tz={tz} showWorkshop={false} />
      </Section>
    </>
  );
}
