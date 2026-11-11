"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, type ActionResult } from "@/server/action";

// Company admins only — enforced by RLS on company_business_hours /
// company_holidays and by set_business_hours (invoker).

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const interval = z.object({ weekday: z.number().int().min(0).max(6), opens: z.string().regex(TIME), closes: z.string().regex(TIME) })
  .refine((i) => i.opens < i.closes, { message: "business_hours.invalid" });

const hoursSchema = z.object({ companyId: z.uuid(), hours: z.array(interval).max(28) });
export async function saveBusinessHours(input: z.input<typeof hoursSchema>): Promise<ActionResult<null>> {
  return runAction(hoursSchema, input, async ({ companyId, hours }) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_business_hours", { p_company_id: companyId, p_hours: hours }));
    revalidatePath(`/admin/companies/${companyId}/hours`);
    return null;
  });
}

const holidaySchema = z.object({ companyId: z.uuid(), day: z.iso.date(), name: z.string().trim().min(1).max(120) });
export async function addHoliday(input: z.input<typeof holidaySchema>): Promise<ActionResult<null>> {
  return runAction(holidaySchema, input, async ({ companyId, day, name }) => {
    const supabase = await createClient();
    check(await supabase.from("company_holidays").upsert({ company_id: companyId, day, name }).select("day").single());
    revalidatePath(`/admin/companies/${companyId}/hours`);
    return null;
  });
}

const removeSchema = z.object({ companyId: z.uuid(), day: z.iso.date() });
export async function removeHoliday(input: z.input<typeof removeSchema>): Promise<ActionResult<null>> {
  return runAction(removeSchema, input, async ({ companyId, day }) => {
    const supabase = await createClient();
    check(await supabase.from("company_holidays").delete().eq("company_id", companyId).eq("day", day).select("day").single());
    revalidatePath(`/admin/companies/${companyId}/hours`);
    return null;
  });
}
