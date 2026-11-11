"use server";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, type ActionResult } from "@/server/action";
import { targetSchema } from "@/schemas/crm";
import type { TablesInsert } from "@/types/database";

/** Managers set targets for people/teams they manage; RLS + guard decide. */
export async function createTarget(input: z.input<typeof targetSchema>): Promise<ActionResult<null>> {
  return runAction(targetSchema, input, async (d) => {
    const supabase = await createClient();
    const row = {
      company_id: d.companyId, metric: d.metric, period_start: d.periodStart, period_end: d.periodEnd,
      target_value: d.targetValue,
      user_id: d.scope === "user" ? d.userId : null,
      team_id: d.scope === "team" ? d.teamId : null,
    } as TablesInsert<"sales_targets">; // created_by is set by the database
    check(await supabase.from("sales_targets").insert(row));
    revalidatePath("/reports");
    revalidatePath("/");
    return null;
  });
}
