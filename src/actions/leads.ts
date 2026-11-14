"use server";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, must, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { requirePermission } from "@/server/auth/permissions";
import { companyTz, localToUtc, phoneOrNull, recordCompany } from "@/server/crm";
import {
  archiveSchema, assignSchema, leadCreateSchema, leadInterestSchema, leadOfferingSchema, leadStatusSchema,
  leadUpdateSchema,
} from "@/schemas/crm";
import type { TablesInsert } from "@/types/database";

// All writes use the user's session. The database sets created_by, enforces
// who may assign whom, records status/assignment history and audit rows.

export async function createLead(
  input: z.input<typeof leadCreateSchema>,
): Promise<ActionResult<{ leadId: string; matchedExisting: boolean; openLeads: number }>> {
  return runAction(leadCreateSchema, input, async (d) => {
    await requirePermission(d.companyId, "create_leads");
    const viewer = await getViewer();
    const supabase = await createClient();
    const [contact] = must(await supabase.rpc("find_or_create_contact", {
      p_company_id: d.companyId, p_full_name: d.fullName,
      p_phone_e164: phoneOrNull(d.phone) ?? undefined, p_email: d.email ?? undefined,
    }));
    const row = {
      company_id: d.companyId,
      contact_id: contact.contact_id,
      title: d.title ?? d.fullName,
      source: d.source,
      campaign: d.campaign,
      priority: d.priority,
      estimated_value: d.estimatedValue,
      owner_id: d.ownerId,
      next_follow_up_at: localToUtc(d.nextFollowUpAt, companyTz(viewer, d.companyId)),
      notes: d.notes,
    } as TablesInsert<"leads">; // created_by is set by the database
    const lead = must(await supabase.from("leads").insert(row).select("id").single());
    revalidatePath("/leads");
    return { leadId: lead.id, matchedExisting: contact.matched_existing, openLeads: contact.open_leads_in_company };
  });
}

export async function updateLead(input: z.input<typeof leadUpdateSchema>): Promise<ActionResult<null>> {
  return runAction(leadUpdateSchema, input, async (d) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    const companyId = await recordCompany(supabase, "leads", d.id);
    check(await supabase.from("leads").update({
      title: d.title, source: d.source, campaign: d.campaign, referral_source: d.referralSource,
      priority: d.priority, estimated_value: d.estimatedValue, notes: d.notes,
      next_follow_up_at: localToUtc(d.nextFollowUpAt, companyTz(viewer, companyId)),
    }).eq("id", d.id).select("id").single());
    revalidatePath(`/leads/${d.id}`);
    return null;
  });
}

export async function setLeadStatus(input: z.input<typeof leadStatusSchema>): Promise<ActionResult<null>> {
  return runAction(leadStatusSchema, input, async ({ id, status }) => {
    const supabase = await createClient();
    check(await supabase.from("leads").update({ status }).eq("id", id).select("id").single());
    revalidatePath(`/leads/${id}`);
    revalidatePath("/leads");
    return null;
  });
}

/**
 * Interest is its own field: only this column is written, so the lead status and its
 * conversion rules are untouched. Who may edit is decided by RLS on leads.
 */
export async function setLeadInterest(input: z.input<typeof leadInterestSchema>): Promise<ActionResult<null>> {
  return runAction(leadInterestSchema, input, async ({ id, interest }) => {
    const supabase = await createClient();
    check(await supabase.from("leads").update({ interest }).eq("id", id).select("id").single());
    revalidatePath(`/leads/${id}`);
    revalidatePath("/leads");
    revalidatePath("/inbox");
    return null;
  });
}

/** The database validates company and activity and records that an employee chose it. */
export async function setLeadOffering(input: z.input<typeof leadOfferingSchema>): Promise<ActionResult<null>> {
  return runAction(leadOfferingSchema, input, async ({ id, offeringId }) => {
    const supabase = await createClient();
    check(await supabase.from("leads").update({ offering_id: offeringId }).eq("id", id).select("id").single());
    revalidatePath(`/leads/${id}`);
    revalidatePath("/leads");
    revalidatePath("/inbox");
    return null;
  });
}

export async function assignLead(input: z.input<typeof assignSchema>): Promise<ActionResult<null>> {
  return runAction(assignSchema, input, async ({ id, ownerId, reason }) => {
    const supabase = await createClient();
    check(await supabase.rpc("assign_lead", {
      p_lead_id: id, p_owner_id: ownerId as string, p_reason: reason ?? undefined,
    }));
    revalidatePath(`/leads/${id}`);
    revalidatePath("/leads");
    return null;
  });
}

export async function archiveLead(input: z.input<typeof archiveSchema>): Promise<ActionResult<null>> {
  return runAction(archiveSchema, input, async ({ id, archived }) => {
    const supabase = await createClient();
    // archived_at/archived_by are stamped by the database.
    check(await supabase.from("leads").update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", id).select("id").single());
    revalidatePath(`/leads/${id}`);
    revalidatePath("/leads");
    return null;
  });
}

