"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, runAction, type ActionResult } from "@/server/action";
import { monthlyTargetSchema, tiersSchema, type MonthlyTargetInput, type TiersInput } from "@/schemas/performance";

/** Replace the commission tiers of a company (company admins; the database enforces it and the ordering rules). */
export async function saveCommissionTiers(input: TiersInput): Promise<ActionResult<null>> {
  return runAction(tiersSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_commission_tiers", { p_company_id: d.companyId, p_tiers: d.tiers }));
    revalidatePath("/performance");
    return null;
  });
}

/** Set or clear one employee's two targets for a month (company admins, or the employee's team manager). */
export async function setMonthlyTarget(input: MonthlyTargetInput): Promise<ActionResult<null>> {
  return runAction(monthlyTargetSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_monthly_target", {
      p_company_id: d.companyId, p_user_id: d.userId, p_month: d.month, p_amount_egp: d.amountEgp, p_customers: d.customers,
    }));
    revalidatePath("/performance");
    revalidatePath("/");
    return null;
  });
}
