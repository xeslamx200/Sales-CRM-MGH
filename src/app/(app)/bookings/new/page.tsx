import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { BookingForm } from "@/components/bookings/booking-form";
import { getViewer, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";

/** New booking: only workshops that have at least one active group can be chosen. */
export default async function NewBookingPage() {
  const viewer = await getViewer();
  const { t } = viewer;
  const supabase = await createClient();
  const companyIds = viewer.activeCompany ? [viewer.activeCompany.id] : viewer.scopeCompanyIds;
  const [offerings, groups] = await Promise.all([
    supabase.from("company_offerings").select("id, company_id, name").in("company_id", companyIds).eq("is_active", true).order("name"),
    supabase.from("workshop_groups").select("offering_id").in("company_id", companyIds).eq("is_active", true),
  ]);
  if (offerings.error) throw offerings.error;
  if (groups.error) throw groups.error;
  const withGroups = new Set((groups.data ?? []).map((g) => g.offering_id));
  const workshops = (offerings.data ?? []).filter((o) => withGroups.has(o.id)).map((o) => ({ id: o.id, companyId: o.company_id, name: o.name }));
  return (
    <>
      <PageHeader title={t.bookings.newBooking} description={t.bookings.subtitle}
        actions={<Button asChild variant="outline"><Link href="/bookings"><ArrowLeft className="rtl:rotate-180" />{t.bookings.title}</Link></Button>} />
      {workshops.length === 0 ? (
        <EmptyState title={t.bookings.noGroups} description={t.bookings.noGroupsHelp}
          action={isAnyAdmin(viewer) ? <Button asChild><Link href="/admin/offerings">{t.bookings.goAddGroups}</Link></Button> : undefined} />
      ) : <BookingForm workshops={workshops} />}
    </>
  );
}
