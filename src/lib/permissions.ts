/** Switches and hideable pages of a custom role (company_roles). Must match save_company_role in migration 1006. */
export const PERMISSION_KEYS = ["send_messages", "create_leads", "import_leads", "create_bookings", "record_payments", "export_data"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const HIDEABLE_PAGES = ["/inbox", "/leads", "/contacts", "/bookings", "/workshops", "/performance", "/tasks", "/reports"] as const;
export type HideablePage = (typeof HIDEABLE_PAGES)[number];

/** A person's custom role as the application sees it: pages hidden from them and the switches turned off. */
export type CustomRole = { id: string; name: string; hiddenNav: string[]; denied: PermissionKey[] };

export function parseDenied(permissions: unknown): PermissionKey[] {
  if (typeof permissions !== "object" || permissions === null) return [];
  return PERMISSION_KEYS.filter((k) => (permissions as Record<string, unknown>)[k] === false);
}

/** Which menu entry a page belongs to (payments and customer payments are tabs of Bookings). */
export function sectionOf(pathname: string): string {
  for (const p of ["/payments", "/customer-payments"]) if (pathname === p || pathname.startsWith(p + "/")) return "/bookings";
  return "/" + (pathname.split("/")[1] ?? "");
}
