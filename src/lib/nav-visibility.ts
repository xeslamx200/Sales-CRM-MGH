/**
 * Built-in defaults for a company that has never saved its display settings on the Company settings page (they win once saved).
 * Nothing is hidden by default; MGH sells fixed-price workshops through Bookings, so its dashboard shows booking revenue.
 */
const WORKSHOP_DASHBOARD_BY_DEFAULT: readonly string[] = ["mgh", "nahj"];

export function hiddenNavFor(companySlug: string | null | undefined): readonly string[] {
  void companySlug;
  return [];
}

/** Companies that sell workshops show booking and payment revenue on the dashboard. */
export function usesWorkshopRevenue(companySlug: string | null | undefined): boolean {
  return !!companySlug && WORKSHOP_DASHBOARD_BY_DEFAULT.includes(companySlug);
}
