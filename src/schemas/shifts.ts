import { z } from "zod";

const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** A working shift: wall-clock start / end in the company's time zone, ISO weekdays (1 = Monday ... 7 = Sunday). An end before the start crosses midnight. */
export const shiftSchema = z.object({
  companyId: z.uuid(),
  userId: z.uuid(),
  starts: hhmm,
  ends: hhmm,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null)),
}).refine((d) => d.starts !== d.ends, { path: ["ends"], message: "shift.invalid_value" });
export type ShiftInput = z.input<typeof shiftSchema>;

export const clearShiftSchema = z.object({ companyId: z.uuid(), userId: z.uuid() });
export type ClearShiftInput = z.input<typeof clearShiftSchema>;
