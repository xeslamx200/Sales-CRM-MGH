"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { AppError, runAction, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { storeChatExport } from "@/server/whatsapp/chat-import";

// Import a chat from a WhatsApp "Export chat" file into a real Kapso number. Super admin only (checked here, not only when the page renders).
// The rows go through public.kapso_import_history (migration 997): the conversation and contact are found or created like an inbound message, a message
// that already exists is never touched, nothing becomes unread, no lead and no notification is created. The ids are made from the content, so
// importing the same file twice stores nothing twice.

const messageSchema = z.object({
  sender: z.string().trim().min(1).max(200),
  local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  text: z.string().max(4096),
  media: z.boolean(),
});
const importSchema = z.object({
  accountId: z.uuid(),
  phone: z.string().trim().regex(/^\+?\d{7,15}$/),
  customerName: z.string().trim().max(200).nullable(),
  businessSender: z.string().trim().min(1).max(200),
  timeZone: z.string().trim().min(1).max(60),
  /** position of the first message of this chunk in the whole file (keeps the ids of a re-import the same) */
  offset: z.number().int().min(0).max(200_000),
  messages: z.array(messageSchema).min(1).max(1000),
});

export type ChatImportResult = { inserted: number; duplicate: number; failed: number; conversationId: string | null };

export async function importChatExport(input: z.input<typeof importSchema>): Promise<ActionResult<ChatImportResult>> {
  return runAction(importSchema, input, async (d) => {
    const viewer = await getViewer();
    if (!viewer.isSuperAdmin) throw new AppError("auth.forbidden");
    try { new Intl.DateTimeFormat("en", { timeZone: d.timeZone }); } catch { throw new AppError("validation"); }
    const digits = d.phone.replace(/\D/g, "");
    if (digits.startsWith("0")) throw new AppError("validation");
    const out = await storeChatExport({ ...d, digits });
    revalidatePath("/inbox");
    return out;
  });
}
