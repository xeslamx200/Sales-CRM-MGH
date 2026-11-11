import { z } from "zod";

const digits = (v: string) => v.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/٫/g, ".").replace(/٬/g, ",").replace(/\s/g, "");

/** A positive amount with at most 2 decimals from a text input (Arabic digits ok; a comma only as a proper thousands separator) or a number; null if empty. */
export function parseMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  let n: number;
  if (typeof v === "number") n = v;
  else {
    const t = digits(String(v));
    n = /^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(t) ? Number(t.replace(/,/g, "")) : NaN;
  }
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return NaN;
  return Math.round(n * 100) / 100;
}

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null));

export type BookingMessages = { discount: string; reason: string; money: string };

/**
 * A booking: an existing customer, one specific group, a country and an attendance type. The price and its currency are NEVER sent: the database
 * reads them from the price matrix and freezes them. The discount is a request: its value is validated here, but the authorization level is decided
 * by the database (up to 10 % applies at once, above waits for a manager / admin).
 */
export function buildBookingSchema(m: BookingMessages) {
  return z.object({
    contactId: z.uuid(),
    groupId: z.uuid(),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/),
    attendance: z.enum(["online", "offline"]),
    discountType: z.enum(["none", "fixed", "percent"]),
    discountValue: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => parseMoney(v)),
    discountReason: text(300),
    note: text(1000),
    /** Optional first payment recorded together with the booking (booking currency; the database refuses more than what remains). */
    paidNow: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => parseMoney(v)),
  }).superRefine((d, ctx) => {
    if (d.paidNow != null && Number.isNaN(d.paidNow)) ctx.addIssue({ code: "custom", path: ["paidNow"], message: m.money });
    if (d.discountType === "none") return;
    if (d.discountValue == null || Number.isNaN(d.discountValue) || (d.discountType === "percent" && d.discountValue > 100)) ctx.addIssue({ code: "custom", path: ["discountValue"], message: m.discount });
    if (!d.discountReason || d.discountReason.length < 3) ctx.addIssue({ code: "custom", path: ["discountReason"], message: m.reason });
  });
}
export const bookingSchema = buildBookingSchema({ discount: "booking.invalid_discount", reason: "booking.discount_reason_required", money: "payment.invalid_amount" });
export type BookingInput = z.input<typeof bookingSchema>;

export function buildBookingPaymentSchema(m: { amount: string }) {
  return z.object({
    bookingId: z.uuid(),
    amount: z.union([z.number(), z.string()]).transform((v, ctx) => {
      const n = parseMoney(v);
      if (n == null || Number.isNaN(n)) { ctx.addIssue({ code: "custom", message: m.amount }); return z.NEVER; }
      return n;
    }),
    paidOn: isoDate,
    note: text(1000),
  });
}
export const bookingPaymentSchema = buildBookingPaymentSchema({ amount: "payment.invalid_amount" });
export type BookingPaymentInput = z.input<typeof bookingPaymentSchema>;

export const cancelBookingSchema = z.object({ bookingId: z.uuid(), reason: z.string().trim().min(3).max(300) });
export type CancelBookingInput = z.input<typeof cancelBookingSchema>;

export function buildDiscountRequestSchema(m: BookingMessages) {
  return z.object({
    bookingId: z.uuid(),
    type: z.enum(["fixed", "percent"]),
    value: z.union([z.number(), z.string()]).transform((v, ctx) => {
      const n = parseMoney(v);
      if (n == null || Number.isNaN(n)) { ctx.addIssue({ code: "custom", message: m.discount }); return z.NEVER; }
      return n;
    }),
    reason: z.string().trim().min(3, m.reason).max(300),
  }).superRefine((d, ctx) => { if (d.type === "percent" && d.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: m.discount }); });
}
export const discountRequestSchema = buildDiscountRequestSchema({ discount: "booking.invalid_discount", reason: "booking.discount_reason_required", money: "payment.invalid_amount" });
export type DiscountRequestInput = z.input<typeof discountRequestSchema>;

export const approveDiscountSchema = z.object({ requestId: z.uuid(), note: text(300) });
export type ApproveDiscountInput = z.input<typeof approveDiscountSchema>;
export const rejectDiscountSchema = z.object({ requestId: z.uuid(), reason: z.string().trim().min(3).max(300) });
export type RejectDiscountInput = z.input<typeof rejectDiscountSchema>;

export const workshopOptionsSchema = z.object({ offeringId: z.uuid() });
