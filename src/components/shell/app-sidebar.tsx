"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, Building2, CheckSquare, Contact, Copy, LayoutDashboard, MessageCircle, BookOpen, Phone, ScrollText, Target, Users, UsersRound, Trophy, Workflow, CalendarCheck, GraduationCap, SlidersHorizontal } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";
import { useI18n } from "@/components/i18n-provider";

export type NavAccess = { anyAdmin: boolean; anyManager: boolean; superAdmin: boolean };

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number };

export function AppSidebar({ access, unreadInbox, hiddenHrefs = [], brandLogo = null }: { access: NavAccess; unreadInbox: number; hiddenHrefs?: readonly string[]; brandLogo?: { src: string; plate: boolean } | null }) {
  const { t, dir } = useI18n();
  const pathname = usePathname();
  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    // Payments and Customer payments are tabs of the one "Bookings & payments" section
    if (href === "/bookings") return ["/bookings", "/payments", "/customer-payments"].some((p) => pathname === p || pathname.startsWith(p + "/"));
    return pathname === href || pathname.startsWith(href + "/");
  };

  const main: Item[] = [
    { href: "/", label: t.nav.dashboard, icon: LayoutDashboard },
    { href: "/inbox", label: t.nav.inbox, icon: MessageCircle, badge: unreadInbox || undefined },
  ];
  const sales: Item[] = [
    { href: "/leads", label: t.nav.leads, icon: Target },
    { href: "/contacts", label: t.nav.contacts, icon: Contact },
    { href: "/bookings", label: t.nav.bookings, icon: CalendarCheck },
    { href: "/workshops", label: t.nav.workshops, icon: GraduationCap },
    { href: "/performance", label: t.nav.performance, icon: Trophy },
    { href: "/tasks", label: t.nav.tasks, icon: CheckSquare },
    { href: "/reports", label: t.nav.reports, icon: BarChart3 },
  ];
  const admin: Item[] = [
    ...(access.anyAdmin ? [{ href: "/admin/settings", label: t.nav.settings, icon: SlidersHorizontal }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/companies", label: t.nav.companies, icon: Building2 }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/users", label: t.nav.users, icon: Users }] : []),
    ...(access.anyManager ? [{ href: "/admin/teams", label: t.nav.teams, icon: UsersRound }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/whatsapp", label: t.nav.whatsappNumbers, icon: Phone }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/pipelines", label: t.nav.pipelines, icon: Workflow }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/offerings", label: t.nav.offerings, icon: BookOpen }] : []),
    ...(access.anyAdmin ? [{ href: "/admin/audit", label: t.nav.audit, icon: ScrollText }] : []),
    ...(access.anyManager ? [{ href: "/contacts/duplicates", label: t.nav.duplicates, icon: Copy }] : []),
    ...(access.superAdmin ? [{ href: "/admin/system", label: t.nav.system, icon: Activity }] : []),
  ];

  const group = (label: string | null, all: Item[]) => {
    const items = all.filter((i) => !hiddenHrefs.includes(i.href));   // menu only: the pages and data stay
    return items.length === 0 ? null : (
      <SidebarGroup>
        {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}
                  className="h-9 rounded-xl px-3 text-sidebar-foreground/85 hover:bg-white/8 hover:text-white data-[active=true]:bg-white/10 data-[active=true]:font-medium data-[active=true]:text-white data-[active=true]:ring-1 data-[active=true]:ring-sidebar-primary/60 data-[active=true]:shadow-[0_0_18px_rgba(249,200,70,0.12)] data-[active=true]:[&>svg]:text-sidebar-primary">
                  <Link href={item.href}>
                    <item.icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
                {item.badge ? <SidebarMenuBadge className="ltr-nums">{item.badge}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  };

  return (
    <Sidebar side={dir === "rtl" ? "right" : "left"} collapsible="icon" variant="floating">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="h-16 justify-center hover:bg-transparent">
              <Link href="/" aria-label={t.app.name}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the company's own logo (same-origin route) or the static default, transparent PNG */}
                <img src={brandLogo?.src ?? "/mgh-logo.png"} alt={t.app.name} data-testid="sidebar-logo"
                  className={`h-12 w-auto max-w-full object-contain group-data-[collapsible=icon]:h-6 ${brandLogo?.plate ? "rounded-lg bg-white px-3 py-1" : ""}`} />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {group(null, main)}
        {group(t.nav.sales, sales)}
        {group(t.nav.admin, admin)}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
