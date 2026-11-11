import { z } from "zod";
import { MAX_TIERS } from "../lib/commission.ts";

/** Fractions: min 0.8 = 80 % of the amount target; rate 0.03 = 3 %. Same limits as set_commission_tiers. */
export const tiersSchema = z.object({
  companyId: z.uuid(),
  tiers: z.array(z.object({ min: z.number().min(0).max(10), rate: z.number().min(0).max(1) })).max(MAX_TIERS),
});
export type TiersInput = z.input<typeof tiersSchema>;

/** One employee, one calendar month (any day of it), the two targets; null or 0 removes a target. */
const optionalNumber = z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) { ctx.addIssue({ code: "custom", message: "target.invalid_value" }); return z.NEVER; }
  return n;
});
export const monthlyTargetSchema = z.object({
  companyId: z.uuid(),
  userId: z.uuid(),
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountEgp: optionalNumber,
  customers: optionalNumber,
});
export type MonthlyTargetInput = z.input<typeof monthlyTargetSchema>;
