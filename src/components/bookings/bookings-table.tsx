import Link from "next/link";
import { DataTable, type Column } from "@/components/app/data-table";
import { StatusBadge, type Tone } from "@/components/app/status-badge";
import type { Dictionary, Locale } from "@/i18n";
import { formatCurrency, formatDate } from "@/lib/format.ts";

/** The columns every booking list needs (a subset of workshop_bookings_list / customer_payment_rows). */
export type BookingRow = {
  booking_id: string; customer_name: string; offering_name?: string; group_name: string; currency: string; list_price: number; discount_amount: number;
  final_price: number; confirmed: number; pending: number; rejected: number; remaining: number; payment_status: string; booking_status: string;
  booked_at: string; discount_status: string; country?: string; attendance?: string; phone?: string | null;
};

const PAY_TONE: Record<string, Tone> = { paid: "success", partially_paid: "primary", unpaid: "neutral", pending_approval: "warning", rejected: "danger", cancelled: "neutral" };
const DISC_TONE: Record<string, Tone> = { none: "neutral", pending: "warning", approved: "success", rejected: "danger" };

export function PayBadge({ status, t }: { status: string; t: Dictionary }) {
  return <StatusBadge tone={PAY_TONE[status] ?? "neutral"}>{t.bookings.payStatus[status as keyof typeof t.bookings.payStatus] ?? status}</StatusBadge>;
}
export function DiscBadge({ status, t }: { status: string; t: Dictionary }) {
  if (status === "none") return <span className="text-xs text-muted-foreground">—</span>;
  return <StatusBadge tone={DISC_TONE[status] ?? "neutral"}>{t.bookings.discStatus[status as keyof typeof t.bookings.discStatus] ?? status}</StatusBadge>;
}

/** Money is shown in the booking's own currency, never converted or added across currencies. */
export function BookingsTable({ rows, t, locale, tz, showWorkshop = true }: { rows: BookingRow[]; t: Dictionary; locale: Locale; tz: string; showWorkshop?: boolean }) {
  const b = t.bookings;
  const m = (v: number, cur: string) => formatCurrency(Number(v), cur, locale);
  const columns: Column<BookingRow>[] = [
    { key: "customer", header: b.colCustomer, cell: (r) => (
      <div className="min-w-0">
        <Link href={`/bookings/${r.booking_id}`} className="font-medium text-foreground hover:text-primary hover:underline">{r.customer_name}</Link>
        {r.phone && <div className="ltr-nums text-xs text-muted-foreground" dir="ltr">{r.phone}</div>}
      </div>
    ) },
    ...(showWorkshop ? [{ key: "workshop", header: b.colWorkshop, cell: (r: BookingRow) => <span dir="auto">{r.offering_name}</span> }] : []),
    { key: "group", header: b.colGroup, cell: (r) => <span dir="auto">{r.group_name}</span> },
    { key: "orig", header: b.colOriginal, className: "ltr-nums whitespace-nowrap", cell: (r) => m(r.list_price, r.currency) },
    { key: "disc", header: b.colDiscount, className: "ltr-nums whitespace-nowrap", cell: (r) => (Number(r.discount_amount) > 0 ? m(r.discount_amount, r.currency) : "—") },
    { key: "final", header: b.colFinal, className: "ltr-nums whitespace-nowrap font-medium", cell: (r) => m(r.final_price, r.currency) },
    { key: "conf", header: b.colConfirmed, className: "ltr-nums whitespace-nowrap", cell: (r) => m(r.confirmed, r.currency) },
    { key: "pend", header: b.colPending, className: "ltr-nums whitespace-nowrap", cell: (r) => (Number(r.pending) > 0 ? m(r.pending, r.currency) : "—") },
    { key: "rej", header: b.colRejected, className: "ltr-nums whitespace-nowrap", cell: (r) => (Number(r.rejected) > 0 ? m(r.rejected, r.currency) : "—") },
    { key: "rem", header: b.colRemaining, className: "ltr-nums whitespace-nowrap font-medium", cell: (r) => {
      // what is still to be collected: the final price minus confirmed AND pending money; the confirmed-only figure is shown while something is pending
      const after = Math.max(0, Number(r.remaining) - Number(r.pending));
      return (
        <div>
          <div data-testid="remaining">{m(after, r.currency)}</div>
          {Number(r.pending) > 0 && <div className="text-xs font-normal text-muted-foreground">{b.untilApproved}: {m(r.remaining, r.currency)}</div>}
        </div>
      );
    } },
    { key: "status", header: b.colStatus, cell: (r) => <PayBadge status={r.payment_status} t={t} /> },
    { key: "dstatus", header: b.colDiscountStatus, cell: (r) => <DiscBadge status={r.discount_status} t={t} /> },
    { key: "date", header: b.colBooked, className: "whitespace-nowrap", cell: (r) => formatDate(r.booked_at, tz, locale) },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.booking_id} empty={{ title: b.empty }} />;
}
