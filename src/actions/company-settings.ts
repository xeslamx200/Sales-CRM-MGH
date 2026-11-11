"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, runAction, type ActionResult } from "@/server/action";
import {
  approversSchema, companyOnlySchema, exclusionSchema, targetCurrencySchema, targetDefaultSchema, uiSettingsSchema,
  type ApproversInput, type CompanyOnlyInput, type ExclusionInput, type TargetCurrencyInput, type TargetDefaultInput, type UiSettingsInput,
} from "@/schemas/company-settings";

// Company admins only. Every rule is enforced (and audited) by the database function; these actions only validate the shape of the input.

function refresh() {
  revalidatePath("/admin/settings");
  revalidatePath("/performance");
  revalidatePath("/payments");
  revalidatePath("/bookings");
  revalidatePath("/", "layout");
}

/** Only these people may approve payments (replaces the list). */
export async function saveApprovers(input: ApproversInput): Promise<ActionResult<null>> {
  return runAction(approversSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_payment_approvers", { p_company_id: d.companyId, p_user_ids: d.userIds }));
    refresh();
    return null;
  });
}

/** Back to "every manager may approve". */
export async function clearApprovers(input: CompanyOnlyInput): Promise<ActionResult<null>> {
  return runAction(companyOnlySchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("clear_payment_approval_policy", { p_company_id: d.companyId }));
    refresh();
    return null;
  });
}

/** Default monthly target (company-wide or for one employee) in the company's target currency. */
export async function saveTargetDefault(input: TargetDefaultInput): Promise<ActionResult<null>> {
  return runAction(targetDefaultSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_target_default", {
      p_company_id: d.companyId, p_user_id: d.userId as unknown as string, p_amount_egp: d.amount as unknown as number,
    }));
    refresh();
    return null;
  });
}

export async function saveTargetCurrency(input: TargetCurrencyInput): Promise<ActionResult<null>> {
  return runAction(targetCurrencySchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_company_target_currency", { p_company_id: d.companyId, p_currency: d.currency }));
    refresh();
    return null;
  });
}

/** Leave a person out of (or put them back into) sales performance and commission. */
export async function saveExclusion(input: ExclusionInput): Promise<ActionResult<null>> {
  return runAction(exclusionSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_performance_exclusion", {
      p_company_id: d.companyId, p_user_id: d.userId, p_excluded: d.excluded, p_reason: (d.reason || null) as unknown as string,
    }));
    refresh();
    return null;
  });
}

/** Hidden menu items and the dashboard type of the company. */
export async function saveUiSettings(input: UiSettingsInput): Promise<ActionResult<null>> {
  return runAction(uiSettingsSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_company_ui_settings_v2", { p_company_id: d.companyId, p_hidden_nav: d.hiddenNav, p_dashboard_mode: d.dashboardMode, p_hidden_widgets: d.hiddenWidgets }));
    refresh();
    return null;
  });
}
