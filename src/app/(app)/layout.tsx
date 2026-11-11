import { cookies } from "next/headers";
import { Suspense } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { getCompanyUiSettings } from "@/server/company-settings";
import { getBranding, logoUrl } from "@/server/branding";
import { brandCssVars, brandStyleText } from "@/lib/brand";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { StatusBadge } from "@/components/app/status-badge";
import { CompanySwitcher } from "@/components/shell/company-switcher";
import { GlobalSearch } from "@/components/shell/global-search";
import { NotificationsPopover } from "@/components/shell/notifications-popover";
import { UserMenu } from "@/components/shell/user-menu";
import { LanguageToggle } from "@/components/shell/language-toggle";
import { getViewer, isAnyAdmin, isAnyManager } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  const supabase = await createClient();
  const cookieStore = await cookies();

  // Everything below runs with the user's session; RLS limits each count.
  const [notifications, unreadNotifications, unreadInbox] = await Promise.all([
    supabase.from("notifications")
      .select("id, title, body, entity_type, entity_id, read_at, created_at")
      .eq("user_id", viewer.id).order("created_at", { ascending: false }).limit(20),
    supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("user_id", viewer.id).is("read_at", null),
    supabase.from("conversations").select("id", { count: "exact", head: true })
      .in("company_id", viewer.scopeCompanyIds).gt("unread_count", 0).eq("is_simulated", false),
  ]);

  const uiSettings = await getCompanyUiSettings(supabase, viewer.activeCompany);
  const brand = await getBranding(supabase, viewer.activeCompany?.id);
  const timeZone = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  return (
    <SidebarProvider defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}>
      {brand.custom && <style dangerouslySetInnerHTML={{ __html: brandStyleText(brandCssVars(brand.colors)) }} />}
      <AppSidebar
        access={{ anyAdmin: isAnyAdmin(viewer), anyManager: isAnyManager(viewer), superAdmin: viewer.isSuperAdmin }}
        unreadInbox={unreadInbox.count ?? 0}
        hiddenHrefs={uiSettings.hiddenNav}
        brandLogo={viewer.activeCompany && brand.hasLogo ? { src: logoUrl(viewer.activeCompany.id, brand.version), plate: brand.logoPlate } : brand.logoPlate ? { src: "/mgh-logo.png", plate: true } : null}
      />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
          <SidebarTrigger label={viewer.t.common.toggleSidebar} />
          <Separator orientation="vertical" className="h-5" />
          <CompanySwitcher
            companies={viewer.companies.map((c) => ({ id: c.id, name: c.name, isSandbox: c.isSandbox }))}
            activeId={viewer.activeCompany?.id ?? null}
            canSelectAll={viewer.isSuperAdmin}
          />
          <div className="mx-2 hidden flex-1 justify-center md:flex">
            <Suspense>
              <GlobalSearch />
            </Suspense>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <LanguageToggle current={viewer.locale} signedIn />
            <NotificationsPopover items={notifications.data ?? []} unread={unreadNotifications.count ?? 0} timeZone={timeZone} />
            <UserMenu name={viewer.fullName} email={viewer.email} />
          </div>
        </header>
        {viewer.activeCompany?.isSandbox && (
          <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <StatusBadge tone="warning" className="me-2">{viewer.t.common.sandbox}</StatusBadge>
            {viewer.t.shell.sandboxBanner}
          </div>
        )}
        <div className="border-b px-4 py-2">
          <Breadcrumbs />
        </div>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
          {viewer.companies.length === 0 ? <NoCompany text={viewer.t.shell.noCompany} /> : children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NoCompany({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text}</p>;
}
