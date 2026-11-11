/**
 * Discount authorization policy (pure). The database is the source of truth (migration 986: app.discount_required_level and friends); this file only
 * PREVIEWS the policy in the booking form and labels it. Same arithmetic: exact integer cents, never a rounded percentage.
 *
 *    0 %  .. 10 %   employee  - applies at once
 *  > 10 %  .. 25 %   manager   - the booking is created at the full price and the discount waits for approval
 *  > 25 %  .. 100 %  admin     - same, but only a company admin may approve (100 % is always admin)
 */
export type DiscountType = "none" | "fixed" | "percent";
export type DiscountLevel = "none" | "employee" | "manager" | "admin";

export const EMPLOYEE_MAX_PERCENT = 10;
export const MANAGER_MAX_PERCENT = 25;

const cents = (n: number) => Math.round(n * 100);

/** The discount amount in the booking currency (2 decimals), as the database computes it. */
export function discountAmount(type: DiscountType, value: number, list: number): number {
  if (type === "fixed") return cents(value) / 100;
  if (type === "percent") return Math.round((cents(list) * cents(value)) / 10000) / 100;   // round(list * value / 100, 2) on exact cents
  return 0;
}

/** Effective percentage of the original price (a fixed amount is divided by the original price). */
export function effectivePercent(type: DiscountType, value: number, list: number): number {
  if (type === "percent") return value;
  if (type === "fixed" && list > 0) return Math.round((cents(value) * 1_000_000) / cents(list)) / 10000;
  return 0;
}

/** The authorization level a discount needs; compared on products, so 10.01 % is manager and 25.01 % is admin. */
export function requiredLevel(type: DiscountType, value: number, list: number): DiscountLevel {
  if (type === "none" || !(value > 0)) return "none";
  const v = cents(value);
  if (type === "percent") return v <= EMPLOYEE_MAX_PERCENT * 100 ? "employee" : v <= MANAGER_MAX_PERCENT * 100 ? "manager" : "admin";
  const l = cents(list);
  return v * 100 <= l * EMPLOYEE_MAX_PERCENT ? "employee" : v * 100 <= l * MANAGER_MAX_PERCENT ? "manager" : "admin";
}

/** Does the discount take effect when the booking is created? Above 10 % it waits for an approver. */
export const appliesImmediately = (level: DiscountLevel) => level === "none" || level === "employee";

export type BookingPreview = { list: number; discount: number; final: number; level: DiscountLevel; percent: number; valid: boolean };

/** What the form shows: original price, discount, final price, who must approve. `valid` = the database would accept the discount values. */
export function previewBooking(list: number | null, type: DiscountType, value: number | null): BookingPreview | null {
  if (list == null || !(list > 0)) return null;
  if (type === "none") return { list, discount: 0, final: list, level: "none", percent: 0, valid: true };
  const v = value ?? NaN;
  const valid = Number.isFinite(v) && v > 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 && (type === "fixed" ? cents(v) <= cents(list) : v <= 100) && discountAmount(type, v, list) > 0;
  if (!valid) return { list, discount: 0, final: list, level: "none", percent: 0, valid: false };
  const level = requiredLevel(type, v, list);
  const amount = discountAmount(type, v, list);
  return { list, discount: amount, final: Math.round(cents(list) - cents(amount)) / 100, level, percent: effectivePercent(type, v, list), valid: true };
}
