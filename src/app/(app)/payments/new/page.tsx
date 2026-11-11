import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { currentRates } from "@/server/fx";
import { todayBounds } from "@/server/crm";
import { Wallet } from "lucide-react";
import { PaymentForm, type WorkshopOption } from "./payment-form";

/** Record a payment: the customer, the workshop booked, the amount in any currency (EGP total preview) and the proof image. */
export default async function NewPaymentPage() {
  const viewer = await getViewer();
  const { t } = viewer;
  const supabase = await createClient();
  const { data, error } = await supabase.from("company_offerings").select("id, company_id, name, price_egp")
    .in("company_id", viewer.scopeCompanyIds).eq("is_active", true).order("name");
  if (error) throw error;
  const names = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const multi = new Set((data ?? []).map((o) => o.company_id)).size > 1;
  const workshops: WorkshopOption[] = (data ?? []).map((o) => ({
    id: o.id, companyId: o.company_id, name: o.name, priceEgp: o.price_egp == null ? null : Number(o.price_egp),
    label: multi ? `${o.name} · ${names.get(o.company_id) ?? ""}` : o.name,
  }));
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const { table } = await currentRates();

  return (
    <>
      <PageHeader title={t.payments.formTitle} description={t.payments.formHint} />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="booking-notice">
        <p className="min-w-0 flex-1">{t.bookings.fromPaymentsNotice}</p>
        <Button asChild size="sm"><Link href="/bookings/new">{t.bookings.newBooking}</Link></Button>
      </div>
      {workshops.length === 0
        ? <EmptyState icon={Wallet} title={t.offerings.empty} />
        : <PaymentForm workshops={workshops} rates={table} today={todayBounds(tz).date} />}
    </>
  );
}
