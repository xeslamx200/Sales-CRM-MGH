"use server";
import { z } from "zod";
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
    // the price of one session lives on the same row: set (or cleared) right after the workshop price
    check(await supabase.rpc("set_workshop_session_price", { p_offering_id: d.offeringId, p_country: d.country, p_attendance: d.attendance, p_price: (d.sessionPrice ?? null) as unknown as number }));
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

const groupIdSchema = z.object({ offeringId: z.uuid(), groupId: z.uuid() });

/** Mark a group (a run of the course) finished - it stops taking bookings and shows as finished - or reopen it. History and bookings stay. */
export async function setWorkshopGroupFinished(input: { offeringId: string; groupId: string; finished: boolean }): Promise<ActionResult<null>> {
  return runAction(groupIdSchema.extend({ finished: z.boolean() }), input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_workshop_group_finished", { p_group_id: d.groupId, p_finished: d.finished }));
    revalidatePath(`/admin/offerings/${d.offeringId}`);
    revalidatePath("/workshops");
    return null;
  });
}

/** Delete a group nobody booked (the database refuses otherwise); the paired company's copy goes with it. */
export async function deleteWorkshopGroup(input: { offeringId: string; groupId: string }): Promise<ActionResult<null>> {
  return runAction(groupIdSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("delete_workshop_group", { p_group_id: d.groupId }));
    revalidatePath(`/admin/offerings/${d.offeringId}`);
    revalidatePath("/workshops");
    return null;
  });
}
