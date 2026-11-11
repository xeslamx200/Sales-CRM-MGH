import { z } from "zod";
import { Constants } from "@/types/database";

const roles = Constants.public.Enums.app_role;
const waStatuses = Constants.public.Enums.wa_account_status;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const companySchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  timezone: z.string().trim().refine(isValidTimeZone),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  isActive: z.boolean(),
  /** Set when a company is created and immutable afterwards (the database refuses a change). */
  isSandbox: z.boolean().default(false),
});

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  fullName: z.string().trim().min(1).max(200),
  companyId: z.uuid(),
  role: z.enum(roles),
});

export const membershipUpdateSchema = z.object({
  id: z.uuid(),
  role: z.enum(roles),
  isActive: z.boolean(),
});

export const profileActiveSchema = z.object({ userId: z.uuid(), isActive: z.boolean() });

export const teamSchema = z.object({
  id: z.uuid().optional(),
  companyId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  managerId: z.uuid().nullable(),
  isActive: z.boolean(),
});

export const teamMemberSchema = z.object({ teamId: z.uuid(), companyId: z.uuid(), userId: z.uuid() });

export const waAccountSchema = z.object({
  id: z.uuid().optional(),
  defaultCompanyId: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(5).max(30),
  phoneNumberId: z.string().trim().max(128).nullable().or(z.literal("").transform(() => null)),
  wabaId: z.string().trim().regex(/^\d{5,30}$/).nullable().or(z.literal("").transform(() => null)),
  status: z.enum(waStatuses),
  /** Chosen when the number is created; the database refuses a change once it has conversations. */
  provider: z.enum(["meta", "kapso"]).default("meta"),
  /** Kapso only, chosen at creation: a real number of a real company ("production") or a sandbox number of a sandbox company. */
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
  connectionMode: z.enum(["cloud_api", "coexistence"]).nullable().default(null),
  /** Creation only (afterwards the switch on the number card): may employees send from the CRM? Needs an active number. */
  outboundEnabled: z.boolean().default(false),
}).superRefine((v, ctx) => {
  // Meta's ids are numeric; a Kapso sandbox id is whatever Kapso shows (letters, digits, . _ : -) and required.
  const pattern = v.provider === "kapso" ? /^[A-Za-z0-9._:-]{1,128}$/ : /^\d{5,30}$/;
  if (v.phoneNumberId === null ? v.provider === "kapso" : !pattern.test(v.phoneNumberId)) {
    ctx.addIssue({ code: "custom", path: ["phoneNumberId"], message: "invalid" });
  }
  if (v.provider === "kapso" && v.wabaId !== null && v.environment === "sandbox") ctx.addIssue({ code: "custom", path: ["wabaId"], message: "invalid" });
  if (!v.id && v.provider === "kapso" && v.environment === "production" && v.connectionMode === null) ctx.addIssue({ code: "custom", path: ["connectionMode"], message: "required" });
  if (v.outboundEnabled && !(v.provider === "kapso" && v.environment === "production" && v.status === "active")) ctx.addIssue({ code: "custom", path: ["outboundEnabled"], message: "invalid" });
});

export const waSendingSchema = z.object({ accountId: z.uuid(), enabled: z.boolean() });

export const waGrantSchema = z.object({ accountId: z.uuid(), userId: z.uuid(), canReply: z.boolean() });
export const waRevokeSchema = z.object({ accountId: z.uuid(), userId: z.uuid() });

/** Keywords arrive as free text (one per line or comma-separated); the database normalises and bounds them. */
export const offeringSchema = z.object({
  id: z.uuid().optional(),
  companyId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(Constants.public.Enums.offering_kind),
  // The form edits text; the transformed list is what reaches (and re-validates in) the server action.
  keywords: z.union([z.string().max(2000), z.array(z.string().max(80)).max(60)])
    .transform((v) => [...new Set((Array.isArray(v) ? v : v.split(/[\n,،;]+/)).map((k) => k.trim()).filter(Boolean))]),
  /** Price in EGP (optional; used by Payments to work out the remaining amount). Empty = no price. */
  priceEgp: z.union([z.number(), z.string()]).nullable().optional().transform((v, ctx) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, "").replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
      ctx.addIssue({ code: "custom", message: "invalid" });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  }),
  isActive: z.boolean(),
});
export type OfferingInput = z.input<typeof offeringSchema>;
