"use server";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { companyTz, localToUtc, recordCompany } from "@/server/crm";
import {
  activitySchema, taskCompleteSchema, taskCreateSchema, taskReassignSchema, taskStatusSchema,
} from "@/schemas/crm";
import type { TablesInsert } from "@/types/database";

function revalidateRelated(d: { leadId?: string | null; contactId?: string | null }) {
  if (d.leadId) revalidatePath(`/leads/${d.leadId}`);
  if (d.contactId) revalidatePath(`/contacts/${d.contactId}`);
  revalidatePath("/tasks");
}

/** Calls, meetings, notes… The database sets actor_id to the session user. */
export async function logActivity(input: z.input<typeof activitySchema>): Promise<ActionResult<null>> {
  return runAction(activitySchema, input, async (d) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    const occurredAt = localToUtc(d.occurredAt, companyTz(viewer, d.companyId)) ?? new Date().toISOString();
    const row = {
      company_id: d.companyId, type: d.type, lead_id: d.leadId, contact_id: d.contactId,
      occurred_at: occurredAt,
      duration_seconds: d.durationMinutes != null ? d.durationMinutes * 60 : null,
      outcome: d.outcome, body: d.body,
    } as TablesInsert<"activities">;
    check(await supabase.from("activities").insert(row));
    revalidateRelated(d);
    return null;
  });
}

export async function createTask(input: z.input<typeof taskCreateSchema>): Promise<ActionResult<null>> {
  return runAction(taskCreateSchema, input, async (d) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    const row = {
      company_id: d.companyId, title: d.title, description: d.description,
      due_at: localToUtc(d.dueAt, companyTz(viewer, d.companyId)),
      priority: d.priority, assigned_to: d.assignedTo ?? viewer.id,
      lead_id: d.leadId, contact_id: d.contactId,
    } as TablesInsert<"tasks">; // created_by is set by the database
    check(await supabase.from("tasks").insert(row));
    revalidateRelated(d);
    return null;
  });
}

/** Completion is permanent; completed_at/completed_by are set by the database. */
export async function completeTask(input: z.input<typeof taskCompleteSchema>): Promise<ActionResult<null>> {
  return runAction(taskCompleteSchema, input, async ({ id, outcome }) => {
    const supabase = await createClient();
    const t = check(await supabase.from("tasks").update({ status: "completed", outcome })
      .eq("id", id).select("lead_id, contact_id").single());
    revalidateRelated({ leadId: t?.lead_id, contactId: t?.contact_id });
    return null;
  });
}

export async function setTaskStatus(input: z.input<typeof taskStatusSchema>): Promise<ActionResult<null>> {
  return runAction(taskStatusSchema, input, async ({ id, status }) => {
    const supabase = await createClient();
    const t = check(await supabase.from("tasks").update({ status }).eq("id", id)
      .select("lead_id, contact_id").single());
    revalidateRelated({ leadId: t?.lead_id, contactId: t?.contact_id });
    return null;
  });
}

export async function reassignTask(input: z.input<typeof taskReassignSchema>): Promise<ActionResult<null>> {
  return runAction(taskReassignSchema, input, async ({ id, assignedTo, dueAt }) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    const companyId = await recordCompany(supabase, "tasks", id);
    const t = check(await supabase.from("tasks").update({
      assigned_to: assignedTo, due_at: localToUtc(dueAt, companyTz(viewer, companyId)),
    }).eq("id", id).select("lead_id, contact_id").single());
    revalidateRelated({ leadId: t?.lead_id, contactId: t?.contact_id });
    return null;
  });
}
