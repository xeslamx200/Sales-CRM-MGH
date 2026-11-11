import { z } from "zod";
import { PAYMENT_CURRENCIES } from "../lib/fx.ts";

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null));
const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

/** Messages the form shows next to the fields (the client builds the schema with localized texts; the server uses stable keys). */
export type PaymentMessages = { amount: string; customer: string };

/**
 * One payment. The customer is either an existing contact (`contactId`) or a new one (`newName` + `newPhone`, created through
 * find_or_create_contact, which links an existing contact with the same phone instead of duplicating it). The company is never sent:
 * it is the workshop's company, and the exchange rate is never sent either: the database reads it.
 * Amount: positive, at most 2 decimals; arrives from a text input (string, Arabic digits accepted) or a number.
 */
export function buildPaymentSchema(m: PaymentMessages) {
  const amount = z.union([z.number(), z.string()]).transform((v, ctx) => {
    let n: number;
    if (typeof v === "number") n = v;
    else {
      // digits: Arabic-Indic -> ASCII, Arabic decimal / thousands marks -> . and ,; a comma is accepted ONLY as a proper thousands separator
      const t = v.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/٫/g, ".").replace(/٬/g, ",").replace(/\s/g, "");
      n = /^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(t) ? Number(t.replace(/,/g, "")) : NaN;
    }
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
      ctx.addIssue({ code: "custom", message: m.amount });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  });
  return z.object({
    offeringId: z.uuid(),
    contactId: z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
    newName: text(200),
    newPhone: text(30),
    amount,
    currency: z.enum(PAYMENT_CURRENCIES),
    kind: z.enum(["partial", "full"]),
    paidOn: isoDate,
    note: text(1000),
  }).superRefine((d, ctx) => {
    if (!d.contactId && !(d.newName && d.newPhone)) ctx.addIssue({ code: "custom", path: ["contactId"], message: m.customer });
  });
}
export const paymentSchema = buildPaymentSchema({ amount: "payment.invalid_amount", customer: "payment.customer_required" });
export type PaymentInput = z.input<typeof paymentSchema>;

export const reviewSchema = z.object({
  id: z.uuid(),
  decision: z.enum(["confirmed", "rejected"]),
  note: text(1000),
});
export type ReviewInput = z.input<typeof reviewSchema>;

export const searchSchema = z.object({ companyId: z.uuid(), q: z.string().trim().min(2).max(80) });
export const balanceSchema = z.object({ contactId: z.uuid(), offeringId: z.uuid() });
