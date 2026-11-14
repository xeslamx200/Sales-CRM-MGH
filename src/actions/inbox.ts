"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, must, AppError, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { sendReply, type SendOutcome } from "@/server/whatsapp/send";
import { Constants } from "@/types/database";

const sendSchema = z.object({
  conversationId: z.uuid(),
  body: z.string().trim().min(1).max(4096),
  clientRequestId: z.uuid(),
});

export async function sendMessage(input: z.input<typeof sendSchema>): Promise<ActionResult<SendOutcome>> {
  return runAction(sendSchema, input, async ({ conversationId, body, clientRequestId }) => {
    const out = await sendReply(conversationId, body, clientRequestId);
    revalidatePath("/inbox");
    return out;
  });
}

const resendSchema = z.object({ messageId: z.uuid(), clientRequestId: z.uuid() });

/** A failed message stays failed (history); resending creates a new message. */
export async function resendMessage(input: z.input<typeof resendSchema>): Promise<ActionResult<SendOutcome>> {
  return runAction(resendSchema, input, async ({ messageId, clientRequestId }) => {
    const supabase = await createClient();
    const { data: m } = await supabase.from("messages").select("conversation_id, body, status, direction")
      .eq("id", messageId).maybeSingle();
    if (!m || m.direction !== "outbound" || m.status !== "failed" || !m.body) throw new AppError("auth.forbidden");
    const out = await sendReply(m.conversation_id, m.body, clientRequestId);
    revalidatePath("/inbox");
    return out;
  });
}

const statusSchema = z.object({ conversationId: z.uuid(), status: z.enum(Constants.public.Enums.conversation_status) });

export async function setConversationStatus(input: z.input<typeof statusSchema>): Promise<ActionResult<null>> {
  return runAction(statusSchema, input, async ({ conversationId, status }) => {
    const supabase = await createClient();
    check(await supabase.from("conversations").update({ status }).eq("id", conversationId).select("id").single());
    revalidatePath("/inbox");
    return null;
  });
}

const assignSchema = z.object({ conversationId: z.uuid(), ownerId: z.uuid().nullable(), reason: z.string().max(1000).optional() });

/** Claim (self), release (null) or assign; the database decides who may do what. */
export async function assignConversation(input: z.input<typeof assignSchema>): Promise<ActionResult<null>> {
  return runAction(assignSchema, input, async ({ conversationId, ownerId, reason }) => {
    const supabase = await createClient();
    check(await supabase.rpc("assign_conversation", {
      p_conversation_id: conversationId, p_owner_id: ownerId as string, p_reason: reason,
    }));
    revalidatePath("/inbox");
    return null;
  });
}

const readSchema = z.object({ conversationId: z.uuid() });

/** Clearing the unread counter is the only change users can make to it. */
export async function markConversationRead(input: z.input<typeof readSchema>): Promise<ActionResult<null>> {
  return runAction(readSchema, input, async ({ conversationId }) => {
    const supabase = await createClient();
    check(await supabase.from("conversations").update({ unread_count: 0 }).eq("id", conversationId).gt("unread_count", 0));
    // no revalidatePath here: it re-rendered the whole inbox after every conversation opened; the live check (InboxLive) picks the new counters up
    return null;
  });
}

const moveSchema = z.object({ conversationId: z.uuid(), companyId: z.uuid(), reason: z.string().trim().min(1).max(1000) });

/** Move to another company; the database requires manager rights in both. */
export async function moveConversationCompany(input: z.input<typeof moveSchema>): Promise<ActionResult<null>> {
  return runAction(moveSchema, input, async ({ conversationId, companyId, reason }) => {
    const supabase = await createClient();
    check(await supabase.rpc("move_conversation_company", { p_conversation_id: conversationId, p_company_id: companyId, p_reason: reason }));
    revalidatePath("/inbox");
    return null;
  });
}

const leadFromConversationSchema = z.object({ conversationId: z.uuid() });

/**
 * Open lead for the conversation's contact in its company, created if none
 * is open. Runs with the user's session: the lead guard decides ownership.
 */
export async function leadFromConversation(input: z.input<typeof leadFromConversationSchema>): Promise<ActionResult<{ leadId: string; created: boolean }>> {
  return runAction(leadFromConversationSchema, input, async ({ conversationId }) => {
    const supabase = await createClient();
    // One atomic, idempotent database call: repeated clicks, or a click racing the
    // automatic intake, return the existing lead. created_by is set by the database.
    const rows = must(await supabase.rpc("lead_from_conversation", { p_conversation_id: conversationId }));
    const row = rows[0];
    if (!row) throw new AppError("generic");
    revalidatePath("/leads");
    revalidatePath("/inbox");
    return { leadId: row.lead_id, created: row.created };
  });
}

const noteSchema = z.object({ conversationId: z.uuid(), body: z.string().trim().min(1).max(5000) });

/** Internal notes live in their own table and can never be sent to the customer. */
export async function addNote(input: z.input<typeof noteSchema>): Promise<ActionResult<null>> {
  return runAction(noteSchema, input, async ({ conversationId, body }) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    // RLS requires author_id = auth.uid(); the value comes from the session.
    check(await supabase.from("conversation_notes").insert({ conversation_id: conversationId, body, author_id: viewer.id }));
    revalidatePath("/inbox");
    return null;
  });
}

/** "Mark all as read": clears the unread counter of every conversation this person can see in the given companies (RLS decides; clearing is the only change allowed). */
export async function markAllConversationsRead(input: { companyIds: string[] }): Promise<ActionResult<{ cleared: number }>> {
  return runAction(z.object({ companyIds: z.array(z.uuid()).min(1).max(20) }), input, async ({ companyIds }) => {
    const supabase = await createClient();
    const { data, error } = await supabase.from("conversations").update({ unread_count: 0 }).in("company_id", companyIds).gt("unread_count", 0).select("id");
    if (error) throw error;
    revalidatePath("/inbox");
    return { cleared: (data ?? []).length };
  });
}
