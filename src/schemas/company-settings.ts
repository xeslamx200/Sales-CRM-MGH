import { z } from "zod";

/** Menu entries an admin may hide (the database allow-list is the same; Dashboard, Inbox, Reports and the administration pages cannot be hidden). */
export const HIDEABLE_NAV = ["/leads", "/tasks", "/performance", "/workshops", "/bookings"] as const;

/** Dashboard sections an admin may hide (the database allow-list is the same; the four headline figures and the page header cannot be hidden). */
export const HIDEABLE_WIDGETS = ["revenue_chart", "workshop_share", "latest_bookings", "top_workshops", "goal", "leads_per_day", "response_speed", "targets", "whatsapp_load"] as const;
export type Widget = (typeof HIDEABLE_WIDGETS)[number];

export const approversSchema = z.object({ companyId: z.uuid(), userIds: z.array(z.uuid()).min(1).max(10) });
export type ApproversInput = z.input<typeof approversSchema>;

export const companyOnlySchema = z.object({ companyId: z.uuid() });
export type CompanyOnlyInput = z.input<typeof companyOnlySchema>;

/** One default monthly target: for the whole company (userId null) or for one employee. A null or zero amount removes it. */
export const targetDefaultSchema = z.object({
  companyId: z.uuid(),
  userId: z.uuid().nullable(),
  amount: z.number().min(0).max(1_000_000_000).nullable(),
});
export type TargetDefaultInput = z.input<typeof targetDefaultSchema>;

export const targetCurrencySchema = z.object({ companyId: z.uuid(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) });
export type TargetCurrencyInput = z.input<typeof targetCurrencySchema>;

export const exclusionSchema = z.object({
  companyId: z.uuid(),
  userId: z.uuid(),
  excluded: z.boolean(),
  reason: z.string().trim().max(300).nullable().optional(),
});
export type ExclusionInput = z.input<typeof exclusionSchema>;

export const uiSettingsSchema = z.object({
  companyId: z.uuid(),
  hiddenNav: z.array(z.enum(HIDEABLE_NAV)),
  dashboardMode: z.enum(["standard", "workshop"]),
  hiddenWidgets: z.array(z.enum(HIDEABLE_WIDGETS)).default([]),
});
export type UiSettingsInput = z.input<typeof uiSettingsSchema>;
