"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, runAction, type ActionResult } from "@/server/action";
import {
  deactivatePriceSchema, workshopGroupSchema, workshopPriceSchema,
  type DeactivatePriceInput, type WorkshopGroupInput, type WorkshopPriceInput,
} from "@/schemas/workshops";

// Company admins only. The database enforces it (set_workshop_price / set_workshop_group), validates the values, writes the change history and
// the audit log. Prices and groups are deactivated, never deleted.

export async function setWorkshopPrice(input: WorkshopPriceInput): Promise<ActionResult<null>> {
  return runAction(workshopPriceSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_workshop_price", {
      p_offering_id: d.offeringId, p_country: d.country, p_attendance: d.attendance, p_currency: d.currency, p_price: d.price,
    }));
    revalidatePath(`/admin/offerings/${d.offeringId}`);
    return null;
  });
}

export async function deactivateWorkshopPrice(input: DeactivatePriceInput): Promise<ActionResult<null>> {
  return runAction(deactivatePriceSchema, input, async (d) => {
    const supabase = await createClient();
    // price = null deactivates (the row and its history stay)
    check(await supabase.rpc("set_workshop_price", {
      p_offering_id: d.offeringId, p_country: d.country, p_attendance: d.attendance, p_currency: d.currency, p_price: null as unknown as number,
    }));
    revalidatePath(`/admin/offerings/${d.offeringId}`);
    return null;
  });
}

export async function saveWorkshopGroup(input: WorkshopGroupInput): Promise<ActionResult<null>> {
  return runAction(workshopGroupSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_workshop_group", {
      p_group_id: (d.id ?? null) as unknown as string, p_offering_id: d.offeringId, p_name: d.name, p_sessions: d.sessions,
      p_capacity: (d.capacity ?? null) as unknown as number, p_attendance: (d.attendance ?? null) as unknown as string, p_active: d.isActive,
    }));
    revalidatePath(`/admin/offerings/${d.offeringId}`);
    return null;
  });
}
