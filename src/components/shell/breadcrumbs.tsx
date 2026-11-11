"use client";
import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useI18n } from "@/components/i18n-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Breadcrumbs derived from the URL. Record ids are shown as "Details". */
export function Breadcrumbs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const labels: Record<string, string> = {
    inbox: t.nav.inbox, leads: t.nav.leads, contacts: t.nav.contacts, tasks: t.nav.tasks,
    reports: t.nav.reports, admin: t.nav.admin, companies: t.nav.companies, settings: t.nav.settings, users: t.nav.users, teams: t.nav.teams,
    whatsapp: t.nav.whatsappNumbers, profile: t.nav.profile, duplicates: t.nav.duplicates, search: t.common.search,
    import: t.common.import, new: t.common.create, system: t.nav.system, pipelines: t.nav.pipelines, offerings: t.nav.offerings, audit: t.nav.audit, hours: t.hours.title,
    bookings: t.nav.bookings, workshops: t.nav.workshops, "customer-payments": t.nav.customerPayments, payments: t.nav.payments, performance: t.nav.performance,
  };
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return <span className="text-sm font-medium">{t.nav.dashboard}</span>;
  }
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden md:block">
          <BreadcrumbLink asChild><Link href="/">{t.nav.dashboard}</Link></BreadcrumbLink>
        </BreadcrumbItem>
        {segments.map((seg, i) => {
          const href = "/" + segments.slice(0, i + 1).join("/");
          const label = UUID.test(seg) ? t.common.details : labels[seg] ?? seg;
          const last = i === segments.length - 1;
          // "/admin" has no page of its own, nor has a company id (only its sub-pages do).
          const linkable = !last && seg !== "admin" && !(UUID.test(seg) && segments[i - 1] === "companies");
          return (
            <Fragment key={href}>
              <BreadcrumbSeparator className="hidden md:block rtl:rotate-180" />
              <BreadcrumbItem className={last ? undefined : "hidden md:block"}>
                {last ? <BreadcrumbPage>{label}</BreadcrumbPage>
                  : linkable ? <BreadcrumbLink asChild><Link href={href}>{label}</Link></BreadcrumbLink>
                  : <span>{label}</span>}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
