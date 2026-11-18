import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { DiscBadge, PayBadge } from "@/components/bookings/bookings-table";
import { ApproveBookingDialog, ApproveDiscountDialog, CancelBookingDialog, RejectBookingDialog, RecordPaymentDialog, RejectDiscountDialog, RequestDiscountDialog, EditBookingDialog, EditPaymentDialog } from "@/components/bookings/booking-actions";
import { FileText, ImageIcon } from "lucide-react";
import { AddProofButton } from "@/components/bookings/proof-field";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { countryName } from "@/lib/workshop-config.ts";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAY_TONE = { pending: "warning", confirmed: "success", rejected: "danger" } as const;

/** One booking: the frozen price, the discount and its approval state, the money (booking currency) and the payments. */
export default async function BookingPage({ params }: PageProps<"/bookings/[id]">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const b = t.bookings;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const detail = await supabase.rpc("booking_detail", { p_booking_id: id });
  if (detail.error || !detail.data?.[0]) notFound();
  const r = detail.data[0];
  const { data: own } = await supabase.from("workshop_bookings").select("company_id, booking_kind, session_date, payment_mode, remind_on").eq("id", id).maybeSingle();
  const companyId = own?.company_id;
  const tz = viewer.companies.find((c) => c.id === companyId)?.timezone ?? "UTC";
  const mayEdit = viewer.isSuperAdmin;   // only the super admin corrects prices and payments (the database checks it again)
  const [pays, reqs, edits] = await Promise.all([
    supabase.rpc("booking_payments", { p_booking_id: id }),
    companyId ? supabase.rpc("discount_requests_list", { p_company_id: companyId }) : Promise.resolve({ data: [], error: null }),
    mayEdit || isAdminOf(viewer, companyId) ? supabase.rpc("booking_edit_history", { p_booking_id: id }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (pays.error) throw pays.error;
  const payIds = (pays.data ?? []).map((p) => p.payment_id);
  const editablePayments = (pays.data ?? []).filter((p) => p.status !== "rejected").map((p) => ({ id: p.payment_id, amount: Number(p.amount), status: p.status, paidOn: p.paid_on }));
  const proofs = new Map<string, { id: string; mime: string }>();
  if (payIds.length) {
    const { data: files } = await supabase.from("attachments").select("id, entity_id, mime_type").eq("entity_type", "payment").in("entity_id", payIds).order("created_at");
    for (const f of files ?? []) if (!proofs.has(f.entity_id)) proofs.set(f.entity_id, { id: f.id, mime: f.mime_type });
  }
  const req = (reqs.data ?? []).find((x) => x.request_id === r.request_id) ?? null;
  const cur = r.currency;
  const m = (v: number | null) => (v == null ? "—" : formatCurrency(Number(v), cur, locale));
  const active = r.booking_status === "booked";
  const awaiting = r.booking_status === "pending_approval";
  const mayApprove = isAdminOf(viewer, companyId);
  const hasMoney = Number(r.pending) > 0 || Number(r.confirmed) > 0;
  const remainingToPay = Math.max(0, Number(r.final_price) - Number(r.confirmed) - Number(r.pending));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  return (
    <>
      <PageHeader
        title={r.customer_name}
        description={`${r.offering_name} · ${r.group_name}`}
        actions={<Button asChild variant="outline"><Link href="/bookings"><ArrowLeft className="rtl:rotate-180" />{b.title}</Link></Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={b.detailTitle}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Item label={b.customer} value={r.customer_name} />
            <Item label={b.colPhone} value={r.phone ?? "—"} ltr />
            <Item label={b.colEmail} value={r.email ?? "—"} ltr />
            <Item label={b.workshop} value={r.offering_name} />
            <Item label={b.group} value={<><span dir="auto">{r.group_name}</span> · <span className="ltr-nums" dir="ltr">{formatDate(r.group_starts_on, "UTC", locale)}</span></>} />
            <Item label={b.country} value={countryName(r.country, locale)} />
            <Item label={b.attendance} value={r.attendance === "online" ? b.online : b.offline} />
            <Item label={b.kind} value={own?.booking_kind === "session" ? `${b.kindSession}${own.session_date ? ` · ${formatDate(own.session_date, "UTC", locale)}` : ""}` : b.kindFull} />
            <Item label={b.paymentMode} value={own?.payment_mode === "deposit" ? b.payDeposit : b.payFull} />
            {own?.payment_mode === "deposit" && own.remind_on && <Item label={b.remindLabel} value={formatDate(own.remind_on, "UTC", locale)} />}
            <Item label={b.colBooked} value={formatDate(r.booked_at, tz, locale)} />
            <Item label={b.recordedBy} value={r.recorded_by} />
            <Item label={b.colStatus} value={b.bookingStatus[r.booking_status as keyof typeof b.bookingStatus] ?? r.booking_status} />
          </dl>
        </Section>

        <Section title={b.financials} actions={<PayBadge status={r.payment_status} t={t} />}>
          <dl className="grid gap-2 text-sm" data-testid="financials">
            <Line label={`${b.currencyOfBooking}`} value={cur} />
            <Line label={b.original} value={m(r.list_price)} />
            <Line label={b.discountAmount} value={Number(r.discount_amount) > 0 ? `− ${m(r.discount_amount)}` : "—"} />
            <Line label={b.finalPrice} value={m(r.final_price)} strong />
            <Line label={b.colConfirmed} value={m(r.confirmed)} />
            <Line label={b.colPending} value={m(r.pending)} />
            <Line label={b.colRejected} value={m(r.rejected)} />
            <Line label={b.colRemaining} value={m(Math.max(0, Number(r.remaining) - Number(r.pending)))} strong />
            {Number(r.pending) > 0 && <Line label={b.untilApproved} value={m(r.remaining)} />}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">{b.totalsNote}</p>
          {active && (
            <div className="mt-3 flex flex-wrap gap-2">
              {remainingToPay > 0 && <RecordPaymentDialog bookingId={id} currency={cur} today={today} />}
              <CancelBookingDialog bookingId={id} />
              {mayEdit && <EditBookingDialog bookingId={id} price={Number(r.list_price)} currency={cur} paymentMode={own?.payment_mode === "deposit" ? "deposit" : "full"} remindOn={own?.remind_on ?? ""} currencyLocked={hasMoney} payments={editablePayments} />}
            </div>
          )}
          {awaiting && (
            <div className="mt-3 grid gap-2" data-testid="awaiting-approval">
              <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">{b.awaitingNote}</p>
              <div className="flex flex-wrap gap-2">
                {mayApprove && <ApproveBookingDialog bookingId={id} />}
                <RejectBookingDialog bookingId={id} />
                {mayEdit && <EditBookingDialog bookingId={id} price={Number(r.list_price)} currency={cur} paymentMode={own?.payment_mode === "deposit" ? "deposit" : "full"} remindOn={own?.remind_on ?? ""} currencyLocked={hasMoney} payments={editablePayments} />}
              </div>
            </div>
          )}
          {Number(r.confirmed) + Number(r.pending) > Number(r.final_price) && (
            <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="overpaid-banner">{fmt(b.overpaidNote, { amount: m(Number(r.confirmed) + Number(r.pending) - Number(r.final_price)) })}</p>
          )}
          {active && !hasMoney && Number(r.rejected) === 0 && (
            <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="no-payment-yet">{b.noPaymentYet}</p>
          )}
          {active && hasMoney && <p className="mt-2 text-xs text-muted-foreground">{b.cancelHint}</p>}
        </Section>
      </div>

      <Section title={b.discountTitle} actions={<DiscBadge status={r.discount_status} t={t} />}>
        {r.discount_status === "none" ? <p className="text-sm text-muted-foreground">{b.noDiscount}</p> : (
          <div className="grid gap-3 text-sm" data-testid="discount-card">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <Item label={b.discountRequested} value={r.requested_type === "percent" ? `${formatNumber(Number(r.requested_value), locale)}%` : m(r.requested_value)} ltr />
              <Item label={b.effectivePercent} value={`${formatNumber(Number(r.requested_percent), locale)}%`} ltr />
              <Item label={b.discountAmount} value={m(r.requested_amount)} ltr />
              <Item label={b.ifApproved} value={m(r.requested_final)} ltr />
              <Item label={b.requiredLevel} value={b.level[r.required_level as keyof typeof b.level] ?? "—"} />
              <Item label={b.requestedBy} value={r.requested_by_name ?? "—"} />
            </dl>
            <p dir="auto"><span className="text-muted-foreground">{b.discountReason}: </span>{r.discount_reason ?? "—"}</p>
            {req && req.status !== "pending" && req.decided_by_name && (
              <p className="text-xs text-muted-foreground">{req.status === "approved" ? b.approvedBy : b.rejectedReason}: {req.decided_by_name}{req.decided_at ? ` · ${formatDate(req.decided_at, tz, locale)}` : ""}{req.decision_note ? ` — ${req.decision_note}` : ""}</p>
            )}
            {r.discount_status === "pending" && req && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="warning">{fmt(b.waitingFor, { level: b.level[r.required_level as keyof typeof b.level] ?? "" })}</StatusBadge>
                {req.can_decide ? (<><ApproveDiscountDialog requestId={req.request_id} /><RejectDiscountDialog requestId={req.request_id} /></>)
                  : req.is_mine ? <><span className="text-xs text-muted-foreground">{b.yourRequest}</span><RejectDiscountDialog requestId={req.request_id} /></> : <span className="text-xs text-muted-foreground">{b.canNotDecide}</span>}
              </div>
            )}
          </div>
        )}
        {active && (r.discount_status === "none" || r.discount_status === "rejected") && <div className="mt-3"><RequestDiscountDialog bookingId={id} /></div>}
      </Section>

      <Section title={b.paymentsTitle}>
        {(pays.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{b.noPayments}</p> : (
          <div className="relative overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>{[b.paidOn, b.amount, b.colStatus, t.payments.colProof, b.recordedBy, b.reviewedBy, b.note].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}{mayEdit && <th className="w-10 px-3 py-2"><span className="sr-only">{b.editPayment}</span></th>}</tr></thead>
              <tbody className="divide-y">
                {(pays.data ?? []).map((p) => (
                  <tr key={p.payment_id}>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(p.paid_on, "UTC", locale)}</td>
                    <td className="ltr-nums whitespace-nowrap px-3 py-2 font-medium">{formatCurrency(Number(p.amount), p.currency, locale)}</td>
                    <td className="px-3 py-2"><StatusBadge tone={PAY_TONE[p.status as keyof typeof PAY_TONE] ?? "neutral"}>{t.payments.status[p.status as "pending" | "confirmed" | "rejected"] ?? p.status}</StatusBadge></td>
                    <td className="px-3 py-2">
                      {proofs.has(p.payment_id)
                        ? <Button asChild variant="ghost" size="xs"><a href={`/api/attachments/${proofs.get(p.payment_id)?.id}`} target="_blank" rel="noopener noreferrer">{proofs.get(p.payment_id)?.mime === "application/pdf" ? <FileText /> : <ImageIcon />}{t.payments.viewProof}</a></Button>
                        : <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-destructive">{t.payments.noProof}</span><AddProofButton paymentId={p.payment_id} /></div>}
                    </td>
                    <td className="px-3 py-2">{p.recorded_by}</td>
                    <td className="px-3 py-2">{p.reviewed_by ?? "—"}</td>
                    <td className="px-3 py-2" dir="auto">{p.review_note ?? p.note ?? "—"}</td>
                    {mayEdit && <td className="px-3 py-2">{p.status !== "rejected" && <EditPaymentDialog bookingId={id} paymentId={p.payment_id} amount={Number(p.amount)} currency={p.currency} />}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(mayEdit || isAdminOf(viewer, companyId)) && (edits.data ?? []).length > 0 && (
        <Section title={b.editHistory}>
          <ul className="divide-y text-sm" data-testid="edit-history">
            {(edits.data ?? []).map((e) => {
              const o = e.old_values as Record<string, string | number | null>;
              const n = e.new_values as Record<string, string | number | null>;
              const fmtMoney = (v: string | number | null | undefined, c: string | number | null | undefined) => (v == null ? "—" : formatCurrency(Number(v), String(c ?? cur), locale));
              return (
                <li key={e.id} className="grid gap-1 py-2">
                  <span className="text-xs text-muted-foreground">{formatDate(e.edited_at, tz, locale)} · {b.historyBy} {e.edited_by_name ?? "—"}</span>
                  {e.entity_type === "booking" ? (
                    <span>
                      <b>{b.editHistoryBooking}:</b>{" "}
                      <span className="ltr-nums">{fmtMoney(o.final_price, o.currency)} → {fmtMoney(n.final_price, n.currency)}</span>
                      {o.payment_mode !== n.payment_mode || o.remind_on !== n.remind_on
                        ? ` · ${o.payment_mode === "deposit" ? b.payDeposit : b.payFull}${o.remind_on ? ` (${formatDate(String(o.remind_on), "UTC", locale)})` : ""} → ${n.payment_mode === "deposit" ? b.payDeposit : b.payFull}${n.remind_on ? ` (${formatDate(String(n.remind_on), "UTC", locale)})` : ""}`
                        : ""}
                    </span>
                  ) : (
                    <span><b>{b.editHistoryPayment}:</b> <span className="ltr-nums">{fmtMoney(o.amount, o.currency)} → {fmtMoney(n.amount, n.currency)}</span></span>
                  )}
                  <span dir="auto" className="text-muted-foreground">{b.editReason}: {e.reason}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

function Item({ label, value, ltr }: { label: string; value: React.ReactNode; ltr?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={ltr ? "ltr-nums" : undefined} dir={ltr ? "ltr" : "auto"}>{value}</dd></div>;
}
function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex items-baseline justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className={`ltr-nums ${strong ? "text-base font-semibold" : ""}`}>{value}</dd></div>;
}
