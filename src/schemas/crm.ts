import { z } from "zod";
import { Constants } from "@/types/database";

const E = Constants.public.Enums;

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const money = z.union([z.number(), z.string()])
  .nullable().optional()
  .transform((v, ctx) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999) {
      ctx.addIssue({ code: "custom", message: "invalid" });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  });
/** "YYYY-MM-DDTHH:mm" wall-clock time in the company's zone (converted server-side). */
const localDateTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable().optional()
  .or(z.literal("").transform(() => null));
const uuidOrNull = z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

// ---------------------------------------------------------------- contacts
export const contactCreateSchema = z.object({
  companyId: z.uuid(),
  fullName: z.string().trim().min(1).max(200),
  phone: optionalText(30),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional().or(z.literal("").transform(() => null)),
});

export const contactUpdateSchema = z.object({
  id: z.uuid(),
  fullName: z.string().trim().min(1).max(200),
  phone: optionalText(30),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional().or(z.literal("").transform(() => null)),
});

export const contactCompanySchema = z.object({
  id: z.uuid(),
  relationship: z.enum(E.contact_relationship),
  ownerId: uuidOrNull,
  notes: optionalText(5000),
});

export const mergeSchema = z.object({ keepId: z.uuid(), mergeId: z.uuid() });
export const reviewSchema = z.object({ reviewId: z.uuid() });

// ------------------------------------------------------------------- leads
export const leadCreateSchema = z.object({
  companyId: z.uuid(),
  fullName: z.string().trim().min(1).max(200),
  phone: optionalText(30),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional().or(z.literal("").transform(() => null)),
  title: optionalText(200),
  source: z.enum(E.lead_source),
  campaign: optionalText(200),
  priority: z.enum(E.priority_level),
  estimatedValue: money,
  ownerId: uuidOrNull,
  nextFollowUpAt: localDateTime,
  notes: optionalText(10000),
});

export const leadUpdateSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  source: z.enum(E.lead_source),
  campaign: optionalText(200),
  referralSource: optionalText(200),
  priority: z.enum(E.priority_level),
  estimatedValue: money,
  nextFollowUpAt: localDateTime,
  notes: optionalText(10000),
});

export const leadStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum(E.lead_status).exclude(["converted"]),
});

export const leadInterestSchema = z.object({
  id: z.uuid(),
  interest: z.enum(E.lead_interest),
});

export const leadOfferingSchema = z.object({
  id: z.uuid(),
  offeringId: z.uuid().nullable(),
});

export const assignSchema = z.object({
  id: z.uuid(),
  ownerId: uuidOrNull,
  reason: optionalText(1000),
});

export const archiveSchema = z.object({ id: z.uuid(), archived: z.boolean() });

// -------------------------------------------------------------- activities
export const activitySchema = z.object({
  companyId: z.uuid(),
  leadId: uuidOrNull,
  contactId: uuidOrNull,
  type: z.enum(E.activity_type),
  occurredAt: localDateTime,
  durationMinutes: z.coerce.number().int().min(0).max(1440).nullable().optional(),
  outcome: optionalText(200),
  body: optionalText(10000),
});

// ------------------------------------------------------------------- tasks
export const taskCreateSchema = z.object({
  companyId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: optionalText(5000),
  dueAt: localDateTime,
  priority: z.enum(E.priority_level),
  assignedTo: uuidOrNull,
  leadId: uuidOrNull,
  contactId: uuidOrNull,
});

export const taskCompleteSchema = z.object({ id: z.uuid(), outcome: optionalText(5000) });
export const taskStatusSchema = z.object({ id: z.uuid(), status: z.enum(["open", "in_progress", "canceled"]) });
export const taskReassignSchema = z.object({ id: z.uuid(), assignedTo: uuidOrNull, dueAt: localDateTime });

// ----------------------------------------------------------------- targets
export const targetSchema = z.object({
  companyId: z.uuid(),
  metric: z.enum(E.target_metric),
  scope: z.enum(["company", "team", "user"]),
  teamId: uuidOrNull,
  userId: uuidOrNull,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  targetValue: z.coerce.number().positive().max(999_999_999_999),
}).refine((v) => v.periodEnd >= v.periodStart, { path: ["periodEnd"], message: "invalid" })
  .refine((v) => v.scope !== "team" || v.teamId, { path: ["teamId"], message: "required" })
  .refine((v) => v.scope !== "user" || v.userId, { path: ["userId"], message: "required" });
