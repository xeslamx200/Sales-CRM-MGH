import Link from "next/link";
import { Download, FileSpreadsheet, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { FilterBar } from "@/components/app/filter-bar";
import { StatusBadge } from "@/components/app/status-badge";
import { BookingsTable, DiscBadge, type BookingRow } from "@/components/bookings/bookings-table";
import { ApproveDiscountDialog, RejectDiscountDialog } from "@/components/bookings/booking-actions";
import { SectionTabs } from "@/components/bookings/section-tabs";
import { can, getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { oneOf, str, uuid } from "@/lib/search-params";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";

const TABS = ["bookings", "approvals"] as const;
const PAY = ["paid", "partially_paid", "unpaid", "pending_approval", "rejected", "cancelled"] as const;
const DISC = ["none", "pending", "approved", "rejected"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Bookings of the active company (managers and admins see all, others their own) and the queue of discount requests. */
export default async function BookingsPage({ searchParams }: PageProps<"/bookings">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const b = t.bookings;
  const sp = await searchParams;
  const tab = oneOf(sp, "tab", TABS) ?? "bookings";
  const company = viewer.activeCompany ?? (viewer.companies.length === 1 ? viewer.companies[0] : null);
  const tz = company?.timezone ?? "UTC";
  const header = (
    <>
      <PageHeader title={t.nav.bookings} description={b.oneFlowHint}
        actions={company && can(viewer, company.id, "create_bookings") && <Button asChild><Link href="/bookings/new"><Plus />{b.newBookingPayment}</Link></Button>} />
      <SectionTabs active={tab === "approvals" ? "approvals" : "bookings"} t={t} />
    </>
  );
  if (!company) return <>{header}<EmptyState title={t.reports.selectCompany} /></>;
  const supabase = await createClient();

  if (tab === "approvals") {
    const status = oneOf(sp, "status", ["pending", "all"] as const) ?? "pending";
    const { data, error } = await supabase.rpc("discount_requests_list", { p_company_id: company.id, p_status: status === "all" ? undefined : "pending" });
    if (error) throw error;
    const rows = data ?? [];
    return (
      <>
        {header}
        <FilterBar filters={[{ type: "select", name: "status", label: b.colStatus, allLabel: b.filterPending, options: [{ value: "all", label: b.filterAll }] }]} />
        {rows.length === 0 ? <EmptyState title={b.approvalsEmpty} /> : (
          <ul className="grid gap-3" data-testid="approvals-list">
            {rows.map((r) => (
              <li key={r.request_id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/bookings/${r.booking_id}`} className="font-semibold hover:text-primary hover:underline">{r.customer_name}</Link>
                    <p className="text-sm text-muted-foreground" dir="auto">{r.offering_name} · {r.group_name}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <DiscBadge status={r.status} t={t} />
                    <StatusBadge tone={r.required_level === "admin" ? "danger" : "warning"}>{b.requiredLevel}: {b.level[r.required_level as keyof typeof b.level]}</StatusBadge>
                  </div>
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <Item label={b.original} value={formatCurrency(Number(r.list_price), r.currency, locale)} />
                  <Item label={b.discountAmount} value={`${formatCurrency(Number(r.requested_amount), r.currency, locale)} (${formatNumber(Number(r.effective_percent), locale)}%)`} />
                  <Item label={b.ifApproved} value={formatCurrency(Number(r.calculated_final), r.currency, locale)} />
                  <Item label={b.requestedBy} value={`${r.requested_by_name} · ${formatDate(r.requested_at, tz, locale)}`} />
                </dl>
                <p className="mt-2 text-sm" dir="auto"><span className="text-muted-foreground">{b.discountReason}: </span>{r.reason}</p>
                {r.status !== "pending" && r.decided_by_name && (
                  <p className="mt-1 text-xs text-muted-foreground">{r.status === "approved" ? b.approvedBy : b.rejectedReason}: {r.decided_by_name}{r.decision_note ? ` — ${r.decision_note}` : ""}</p>
                )}
                {r.status === "pending" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {r.can_decide ? (<><ApproveDiscountDialog requestId={r.request_id} /><RejectDiscountDialog requestId={r.request_id} /></>)
                      : r.is_mine ? <><span className="text-xs text-muted-foreground">{b.yourRequest} · {fmt(b.waitingFor, { level: b.level[r.required_level as keyof typeof b.level] })}</span><RejectDiscountDialog requestId={r.request_id} /></>
                      : <span className="text-xs text-muted-foreground">{b.canNotDecide}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const offering = uuid(sp, "offering"), group = uuid(sp, "group");
  const status = oneOf(sp, "status", PAY);
  const dstatus = oneOf(sp, "dstatus", DISC);
  const currency = (str(sp, "currency", 3) ?? "").toUpperCase();
  const from = str(sp, "from", 10), to = str(sp, "to", 10);
  const customer = (str(sp, "customer", 80) ?? "").trim().toLowerCase();
  const [offs, grps, rowsRes] = await Promise.all([
    supabase.from("company_offerings").select("id, name").eq("company_id", company.id).order("name"),
    supabase.from("workshop_groups").select("id, name, offering_id").eq("company_id", company.id).order("starts_on"),
    supabase.rpc("customer_payment_rows", {
      p_company_id: company.id, p_offering_id: offering ?? undefined, p_group_id: group ?? undefined, p_status: status ?? undefined,
      p_currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined, p_from: from && DAY.test(from) ? from : undefined, p_to: to && DAY.test(to) ? to : undefined,
    }),
  ]);
  for (const r of [offs, grps, rowsRes]) if (r.error) throw r.error;
  const rows = ((rowsRes.data ?? []) as unknown as BookingRow[]).filter((r) => (!dstatus || r.discount_status === dstatus) && (!customer || r.customer_name.toLowerCase().includes(customer)));
  const currencies = [...new Set((rowsRes.data ?? []).map((r) => r.currency))].sort();
  // per-currency totals of the ACTIVE bookings shown (never summed across currencies)
  const totals = new Map<string, { final: number; confirmed: number; pending: number; remaining: number }>();
  for (const r of rows) {
    if (r.booking_status === "cancelled") continue;
    const x = totals.get(r.currency) ?? { final: 0, confirmed: 0, pending: 0, remaining: 0 };
    x.final += Number(r.final_price); x.confirmed += Number(r.confirmed); x.pending += Number(r.pending); x.remaining += Math.max(0, Number(r.remaining) - Number(r.pending));
    totals.set(r.currency, x);
  }
  const qs = new URLSearchParams({ company: company.id });
  for (const [k, v] of [["offering", offering], ["group", group], ["status", status], ["currency", currency || null], ["from", from], ["to", to], ["customer", customer || null]] as const) if (v) qs.set(k, v);
  return (
    <>
      {header}
      {(!company || can(viewer, company.id, "export_data")) && <div className="flex flex-wrap items-center justify-end gap-2">
        <Button asChild variant="outline" size="sm"><a href={`/api/export/customer-payments?${qs}&format=csv`}><Download />{b.exportCsv}</a></Button>
        <Button asChild variant="outline" size="sm"><a href={`/api/export/customer-payments?${qs}&format=xlsx`}><FileSpreadsheet />{b.exportExcel}</a></Button>
      </div>}
      <FilterBar filters={[
        { type: "search", name: "customer", placeholder: b.customerSearch },
        { type: "select", name: "offering", label: b.filterWorkshop, allLabel: b.allWorkshops, options: (offs.data ?? []).map((o) => ({ value: o.id, label: o.name })) },
        { type: "select", name: "group", label: b.filterGroup, allLabel: b.allGroups, options: (grps.data ?? []).filter((g) => !offering || g.offering_id === offering).map((g) => ({ value: g.id, label: g.name })) },
        { type: "select", name: "status", label: b.filterStatus, allLabel: b.allStatuses, options: PAY.map((s) => ({ value: s, label: b.payStatus[s] })) },
        { type: "select", name: "dstatus", label: b.colDiscountStatus, allLabel: b.allStatuses, options: DISC.map((s) => ({ value: s, label: b.discStatus[s] })) },
        { type: "select", name: "currency", label: b.filterCurrency, allLabel: b.allCurrencies, options: currencies.map((c) => ({ value: c, label: c })) },
        { type: "date", name: "from", label: b.filterFrom },
        { type: "date", name: "to", label: b.filterTo },
      ]} />
      {totals.size > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="currency-totals">
          {[...totals].sort(([x], [y]) => x.localeCompare(y)).map(([cur, x]) => (
            <div key={cur} className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-sm font-semibold">{cur}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{b.colFinal}</dt><dd className="ltr-nums text-end">{formatCurrency(x.final, cur, locale)}</dd>
                <dt className="text-muted-foreground">{b.colConfirmed}</dt><dd className="ltr-nums text-end">{formatCurrency(x.confirmed, cur, locale)}</dd>
                <dt className="text-muted-foreground">{b.colPending}</dt><dd className="ltr-nums text-end">{formatCurrency(x.pending, cur, locale)}</dd>
                <dt className="font-medium">{b.colRemaining}</dt><dd className="ltr-nums text-end font-medium">{formatCurrency(x.remaining, cur, locale)}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{b.totalsNote} {b.remainingNote}</p>
      <BookingsTable rows={rows} t={t} locale={locale} tz={tz} />
    </>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="ltr-nums">{value}</dd></div>;
}
