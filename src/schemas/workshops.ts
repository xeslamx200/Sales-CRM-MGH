import { z } from "zod";
import { parseSessionDates } from "../lib/workshop-config.ts";

const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[,\s]/g, "")));

/** One price: workshop x country x attendance. The price is required here; deactivating uses its own action. */
export const workshopPriceSchema = z.object({
  offeringId: z.uuid(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/),
  attendance: z.enum(["online", "offline"]),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  price: z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = num(v);
    if (v === "" || !Number.isFinite(n) || n <= 0 || n > 1_000_000_000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
      ctx.addIssue({ code: "custom", message: "price.invalid_value" });
      return z.NEVER;
    }
    return n;
  }),
});
export type WorkshopPriceInput = z.input<typeof workshopPriceSchema>;

export const deactivatePriceSchema = z.object({
  offeringId: z.uuid(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/),
  attendance: z.enum(["online", "offline"]),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
});
export type DeactivatePriceInput = z.input<typeof deactivatePriceSchema>;

/** A group: name, the exact session dates (one per line, YYYY-MM-DD), optional capacity and attendance. */
export const workshopGroupSchema = z.object({
  id: z.uuid().optional(),
  offeringId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  // The form edits text (one date per line); the transformed list is what reaches (and re-validates in) the server action.
  sessions: z.union([z.string(), z.array(z.string())]).transform((v, ctx) => {
    const d = parseSessionDates(Array.isArray(v) ? v.join("\n") : v);
    if (!d) { ctx.addIssue({ code: "custom", message: "group.invalid_value" }); return z.NEVER; }
    return d;
  }),
  capacity: z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
    if (v == null || v === "") return null;
    const n = num(v);
    if (!Number.isInteger(n) || n < 1 || n > 10000) { ctx.addIssue({ code: "custom", message: "group.invalid_value" }); return z.NEVER; }
    return n;
  }),
  attendance: z.enum(["", "online", "offline"]).nullable().optional().transform((v) => (v ? v : null)),
  isActive: z.boolean(),
});
export type WorkshopGroupInput = z.input<typeof workshopGroupSchema>;
