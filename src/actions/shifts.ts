"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, runAction, type ActionResult } from "@/server/action";
import { clearShiftSchema, shiftSchema, type ClearShiftInput, type ShiftInput } from "@/schemas/shifts";

// Company admins only (the database enforces it, validates the values, keeps the history and writes the audit log).

export async function saveShift(input: ShiftInput): Promise<ActionResult<null>> {
  return runAction(shiftSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_employee_shift", {
      p_company_id: d.companyId, p_user_id: d.userId, p_starts: d.starts, p_ends: d.ends, p_weekdays: d.weekdays, p_from: (d.from ?? null) as unknown as string,
    }));
    revalidatePath("/reports");
    return null;
  });
}

export async function endShift(input: ClearShiftInput): Promise<ActionResult<null>> {
  return runAction(clearShiftSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("clear_employee_shift", { p_company_id: d.companyId, p_user_id: d.userId }));
    revalidatePath("/reports");
    return null;
  });
}
