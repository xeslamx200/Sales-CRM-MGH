"use server";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, must, type ActionResult } from "@/server/action";
import { phoneOrNull } from "@/server/crm";
import {
  contactCompanySchema, contactCreateSchema, contactUpdateSchema, mergeSchema, reviewSchema,
} from "@/schemas/crm";

/** Exact phone match links the existing contact; otherwise creates one (RPC). */
export async function createContact(
  input: z.input<typeof contactCreateSchema>,
): Promise<ActionResult<{ contactId: string; matchedExisting: boolean; possibleDuplicates: number }>> {
  return runAction(contactCreateSchema, input, async (d) => {
    const supabase = await createClient();
    const [r] = must(await supabase.rpc("find_or_create_contact", {
      p_company_id: d.companyId, p_full_name: d.fullName,
      p_phone_e164: phoneOrNull(d.phone) ?? undefined, p_email: d.email ?? undefined,
    }));
    revalidatePath("/contacts");
    return { contactId: r.contact_id, matchedExisting: r.matched_existing, possibleDuplicates: r.possible_duplicates };
  });
}

/** Identity fields. Changing the phone needs manager rights in every linked company (DB rule). */
export async function updateContact(input: z.input<typeof contactUpdateSchema>): Promise<ActionResult<null>> {
  return runAction(contactUpdateSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.from("contacts").update({
      full_name: d.fullName, phone_e164: phoneOrNull(d.phone), email: d.email,
    }).eq("id", d.id).select("id").single());
    revalidatePath(`/contacts/${d.id}`);
    return null;
  });
}

/** Company-specific relationship, owner and notes (never shared across companies). */
export async function updateContactCompany(input: z.input<typeof contactCompanySchema>): Promise<ActionResult<null>> {
  return runAction(contactCompanySchema, input, async (d) => {
    const supabase = await createClient();
    const row = check(await supabase.from("contact_companies").update({
      relationship: d.relationship, owner_id: d.ownerId, notes: d.notes,
    }).eq("id", d.id).select("contact_id").single());
    if (row) revalidatePath(`/contacts/${row.contact_id}`);
    return null;
  });
}

export async function mergeContacts(input: z.input<typeof mergeSchema>): Promise<ActionResult<null>> {
  return runAction(mergeSchema, input, async ({ keepId, mergeId }) => {
    const supabase = await createClient();
    check(await supabase.rpc("merge_contacts", { p_keep_id: keepId, p_merge_id: mergeId }));
    revalidatePath("/contacts/duplicates");
    revalidatePath(`/contacts/${keepId}`);
    return null;
  });
}

export async function dismissDuplicate(input: z.input<typeof reviewSchema>): Promise<ActionResult<null>> {
  return runAction(reviewSchema, input, async ({ reviewId }) => {
    const supabase = await createClient();
    check(await supabase.rpc("dismiss_duplicate_review", { p_review_id: reviewId }));
    revalidatePath("/contacts/duplicates");
    return null;
  });
}
