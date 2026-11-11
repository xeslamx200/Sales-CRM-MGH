"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, type ActionResult } from "@/server/action";
import { offeringSchema, type OfferingInput } from "@/schemas/admin";

// Company admins only: enforced by RLS on company_offerings (insert/update
// policies) and by app.guard_offering, which normalises and bounds keywords.
// Offerings are deactivated, never deleted (no delete privilege exists).

export async function saveOffering(input: OfferingInput): Promise<ActionResult<null>> {
  return runAction(offeringSchema, input, async (d) => {
    const supabase = await createClient();
    const row = { name: d.name, kind: d.kind, keywords: d.keywords, is_active: d.isActive, price_egp: d.priceEgp };
    if (d.id) {
      check(await supabase.from("company_offerings").update(row).eq("id", d.id).select("id").single());
    } else {
      check(await supabase.from("company_offerings").insert({ company_id: d.companyId, ...row }).select("id").single());
    }
    revalidatePath("/admin/offerings");
    revalidatePath("/inbox");
    revalidatePath("/payments");
    return null;
  });
}
