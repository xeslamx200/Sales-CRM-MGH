import Link from "next/link";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

export type SectionTab = "bookings" | "payments" | "approvals";

/** The one "Bookings & payments" section: the bookings with their money, the payments awaiting review, and the discount approvals. */
export function SectionTabs({ active, t }: { active: SectionTab; t: Dictionary }) {
  const tabs: [SectionTab, string, string][] = [
    ["bookings", "/bookings", t.bookings.tabBookings],
    ["payments", "/payments", t.bookings.tabPayments],
    ["approvals", "/bookings?tab=approvals", t.bookings.tabApprovals],
  ];
  return (
    <nav className="flex flex-wrap gap-1 border-b" aria-label={t.nav.bookings}>
      {tabs.map(([k, href, label]) => (
        <Link key={k} href={href} aria-current={active === k ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm", active === k ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
