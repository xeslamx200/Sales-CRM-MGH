import Link from "next/link";
import { ImageIcon, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { FilterBar } from "@/components/app/filter-bar";
import { DataTable, type Column } from "@/components/app/data-table";
import { StatusBadge, type Tone } from "@/components/app/status-badge";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { oneOf, uuid } from "@/lib/search-params";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";
import { ReviewButtons } from "./review-buttons";
import { SectionTabs } from "@/components/bookings/section-tabs";

const STATUSES = ["pending", "confirmed", "rejected"] as const;
const TONE: Record<(typeof STATUSES)[number], Tone> = { pending: "warning", confirmed: "success", rejected: "danger" };
const LIMIT = 300;

type Row = {
  id: string; company_id: string; amount: number; currency: string; amount_egp: number; fx_rate_to_egp: number; kind: string; paid_on: string;
  status: (typeof STATUSES)[number]; note: string | null; review_note: string | null; created_by: string; reviewed_at: string | null;
  contact: { id: string; full_name: string; phone_e164: string | null } | null;
  offering: { id: string; name: string; price_egp: number | null } | null;
  creator: { full_name: string } | null; reviewer: { full_name: string } | null;
};

/**
 * Payments. Agents see the payments they recorded; managers and admins see every payment of their company and decide on them.
 * Only CONFIRMED payments count in the total. All amounts in the totals are EGP, at the rate frozen in each payment.
 */
export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const status = oneOf(sp, "status", STATUSES);
  const offeringId = uuid(sp, "offering");
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const supabase = await createClient();

  let q = supabase.from("payments").select(
    "id, company_id, amount, currency, amount_egp, fx_rate_to_egp, kind, paid_on, status, note, review_note, created_by, reviewed_at, "
    + "contact:contacts!payments_contact_id_fkey(id, full_name, phone_e164), offering:company_offerings!payments_offering_id_company_id_fkey(id, name, price_egp), "
    + "creator:profiles!payments_created_by_fkey(full_name), reviewer:profiles!payments_reviewed_by_fkey(full_name)",
  ).in("company_id", viewer.scopeCompanyIds);
  if (status) q = q.eq("status", status);
  if (offeringId) q = q.eq("offering_id", offeringId);
  const [{ data, error }, { data: offerings }] = await Promise.all([
    q.order("created_at", { ascending: false }).limit(LIMIT),
    supabase.from("company_offerings").select("id, name").in("company_id", viewer.scopeCompanyIds).order("name"),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Row[];

  // proof images (one link per payment: the first file)
  const proofOf = new Map<string, string>();
  // Who may decide is enforced by the database (review_payment); this only decides which buttons to show.
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  // proof links and review permissions in one round trip
  const [files, verdicts, policies] = await Promise.all([
    rows.length
      ? supabase.from("attachments").select("id, entity_id").eq("entity_type", "payment").in("entity_id", rows.map((r) => r.id)).order("created_at").then((r) => r.data ?? [])
      : Promise.resolve([] as { id: string; entity_id: string }[]),
    Promise.all(companyIds.map(async (id) => [id, (await supabase.rpc("can_review_payments", { p_company_id: id })).data === true] as const)),
    supabase.from("payment_approval_policy").select("company_id").in("company_id", companyIds.length ? companyIds : [viewer.id]),
  ]);
  for (const f of files) if (!proofOf.has(f.entity_id)) proofOf.set(f.entity_id, f.id);
  const mayReview = new Set(verdicts.filter(([, ok]) => ok).map(([id]) => id));
  const restricted = new Set((policies.data ?? []).map((p) => p.company_id));

  const sum = (s: string) => rows.filter((r) => r.status === s).reduce((a, r) => a + Number(r.amount_egp), 0);
  const eg = (n: number) => formatCurrency(n, "EGP", locale);

  const columns: Column<Row>[] = [
    { key: "date", header: t.payments.colDate, cell: (r) => <span className="whitespace-nowrap">{formatDate(r.paid_on, tz, locale)}</span> },
    { key: "customer", header: t.payments.colCustomer, cell: (r) => (
      <div className="min-w-0">
        {r.contact ? <Link href={`/contacts/${r.contact.id}`} className="font-medium text-foreground hover:text-primary hover:underline">{r.contact.full_name}</Link> : "—"}
        {r.contact?.phone_e164 && <p className="ltr-nums text-xs text-muted-foreground">{r.contact.phone_e164}</p>}
      </div>
    ) },
    { key: "workshop", header: t.payments.colWorkshop, cell: (r) => r.offering?.name ?? "—" },
    { key: "amount", header: t.payments.colAmount, cell: (r) => (
      <div>
        <span className="ltr-nums font-medium">{formatNumber(Number(r.amount), locale)} {r.currency}</span>
        {r.currency !== "EGP" && <p className="ltr-nums text-xs text-muted-foreground">× {formatNumber(Math.round(Number(r.fx_rate_to_egp) * 10000) / 10000, locale)}</p>}
      </div>
    ) },
    { key: "total", header: t.payments.colTotal, cell: (r) => <span className="ltr-nums font-semibold">{eg(Number(r.amount_egp))}</span> },
    { key: "kind", header: t.payments.colKind, cell: (r) => (r.kind === "full" ? t.payments.kindFull : t.payments.kindPartial) },
    { key: "status", header: t.payments.colStatus, cell: (r) => (
      <div className="flex flex-col items-start gap-0.5">
        <StatusBadge tone={TONE[r.status]}>{t.payments.status[r.status]}</StatusBadge>
        {r.reviewer && <span className="text-xs text-muted-foreground">{fmt(t.payments.reviewedBy, { name: r.reviewer.full_name })}</span>}
        {r.review_note && <span className="max-w-48 text-xs text-muted-foreground" dir="auto">{r.review_note}</span>}
      </div>
    ) },
    { key: "proof", header: t.payments.colProof, cell: (r) => proofOf.has(r.id)
      ? <Button asChild variant="ghost" size="xs"><a href={`/api/attachments/${proofOf.get(r.id)}`} target="_blank" rel="noopener noreferrer"><ImageIcon />{t.payments.viewProof}</a></Button>
      : <span className="text-xs text-destructive">{t.payments.noProof}</span> },
    { key: "by", header: t.payments.colBy, cell: (r) => r.creator?.full_name ?? "—" },
    { key: "actions", header: <span className="sr-only">{t.common.actions}</span>, cell: (r) => (
      <ReviewButtons id={r.id} status={r.status}
        canReview={mayReview.has(r.company_id) && (r.created_by !== viewer.id || isAdminOf(viewer, r.company_id))}
        canReverse={mayReview.has(r.company_id) && (restricted.has(r.company_id) || isAdminOf(viewer, r.company_id))} />
    ) },
  ];

  return (
    <>
      <PageHeader title={t.nav.bookings} description={t.bookings.oneFlowHint}
        actions={<Button asChild><Link href="/bookings/new"><Plus />{t.bookings.newBookingPayment}</Link></Button>} />
      <SectionTabs active="payments" t={t} />
      <div className="grid gap-3 sm:grid-cols-3">
        {([["totalConfirmed", sum("confirmed"), "bg-[#e8f6ec] text-success"], ["totalPending", sum("pending"), "bg-accent text-[color:var(--brand-gold-ink)]"], ["totalRejected", sum("rejected"), "bg-destructive/10 text-destructive"]] as const).map(([k, v, chip]) => (
          <div key={k} className="flex items-start justify-between gap-3 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5">
            <div>
              <p className="text-xs text-muted-foreground">{t.payments[k]}</p>
              <p className="ltr-nums mt-1 text-2xl font-semibold tracking-tight">{eg(v)}</p>
            </div>
            <span className={`flex size-10 items-center justify-center rounded-full ${chip}`}><Wallet className="size-5" /></span>
          </div>
        ))}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">{t.payments.totalsNote}{rows.length >= LIMIT && ` (${LIMIT}+)`}</p>
      <FilterBar filters={[
        { type: "select", name: "status", label: t.payments.filterStatus, allLabel: t.payments.allStatuses, options: STATUSES.map((s) => ({ value: s, label: t.payments.status[s] })) },
        { type: "select", name: "offering", label: t.payments.filterWorkshop, allLabel: t.payments.allWorkshops, options: (offerings ?? []).map((o) => ({ value: o.id, label: o.name })) },
      ]} />
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} empty={{ title: t.payments.empty }} />
      <p className="text-xs text-muted-foreground"><Link href="/payments/new" className="underline hover:text-primary">{t.bookings.legacyPaymentLink}</Link></p>
    </>
  );
}
