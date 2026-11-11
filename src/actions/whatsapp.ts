"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { runAction, AppError, type ActionResult } from "@/server/action";
import { createClient } from "@/server/supabase/server";
import { prepareOutboundUpload, verifyOutboundUpload } from "@/server/whatsapp/media";
import { sendOutbound, type SendOutcome } from "@/server/whatsapp/send";
import { syncTemplates, testConnection } from "@/server/whatsapp/templates";

const prepareSchema = z.object({
  conversationId: z.uuid(),
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().max(120),
  size: z.number().int().positive(),
});

/** One-time signed URL for uploading an attachment to send (browser → private Storage). */
export async function prepareMediaUpload(input: z.input<typeof prepareSchema>): Promise<ActionResult<{ path: string; token: string }>> {
  return runAction(prepareSchema, input, (d) => prepareOutboundUpload(d));
}

const sendMediaSchema = z.object({
  conversationId: z.uuid(),
  path: z.string().max(400),
  mimeType: z.string().max(120),
  filename: z.string().trim().min(1).max(200),
  caption: z.string().trim().max(1024).nullable(),
  clientRequestId: z.uuid(),
});

export async function sendMedia(input: z.input<typeof sendMediaSchema>): Promise<ActionResult<SendOutcome>> {
  return runAction(sendMediaSchema, input, async (d) => {
    const { size } = await verifyOutboundUpload(d.conversationId, d.path, d.mimeType);
    const out = await sendOutbound(d.conversationId, d.clientRequestId, {
      kind: "media", storagePath: d.path, mimeType: d.mimeType, filename: d.filename, size, caption: d.caption || null,
    });
    revalidatePath("/inbox");
    return out;
  });
}

const templateSchema = z.object({
  conversationId: z.uuid(),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-zA-Z_]{2,15}$/),
  params: z.array(z.string().trim().min(1).max(1024)).max(20),
  clientRequestId: z.uuid(),
});

/** Approved template — the only way to message a customer after 24 h. */
export async function sendTemplate(input: z.input<typeof templateSchema>): Promise<ActionResult<SendOutcome>> {
  return runAction(templateSchema, input, async (d) => {
    const out = await sendOutbound(d.conversationId, d.clientRequestId, { kind: "template", name: d.name, language: d.language, params: d.params });
    revalidatePath("/inbox");
    return out;
  });
}

const accountSchema = z.object({ accountId: z.uuid() });

/** Templates and the connection test talk to Meta's Graph API; they make no sense for a Kapso sandbox number. */
async function requireMetaNumber(accountId: string): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.from("whatsapp_accounts").select("provider").eq("id", accountId).maybeSingle();
  if (data && data.provider !== "meta") throw new AppError("whatsapp.provider_not_supported");
}

export async function syncWhatsappTemplates(input: z.input<typeof accountSchema>): Promise<ActionResult<{ count: number; approved: number }>> {
  return runAction(accountSchema, input, async ({ accountId }) => {
    await requireMetaNumber(accountId);
    const r = await syncTemplates(accountId);
    revalidatePath("/admin/whatsapp");
    return r;
  });
}

export async function testWhatsappConnection(input: z.input<typeof accountSchema>): Promise<ActionResult<{ ok: boolean; code?: string }>> {
  return runAction(accountSchema, input, async ({ accountId }) => {
    await requireMetaNumber(accountId);
    const r = await testConnection(accountId);
    revalidatePath("/admin/whatsapp");
    return r;
  });
}
