import "server-only";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/server/env";
import { AppError } from "@/server/action";
import { requirePermission } from "@/server/auth/permissions";
import { backoffMs, sendTextMessage, type SendResult } from "@/lib/whatsapp/cloud-api.ts";
import { OUTBOUND_MEDIA, isCredentialError, sendMediaMessage, sendTemplateMessage, uploadMedia } from "@/lib/whatsapp/graph.ts";
import { isRecipientAllowed, parseSendAllowlist, sendKapsoMedia, sendKapsoText, uploadKapsoMedia, type KapsoSendResult } from "@/lib/kapso/send.ts";
import { isOggOpus } from "@/lib/audio/ogg-opus.ts";
import { limitUser } from "@/server/rate-limit";
import { recordCredentialResult } from "@/server/whatsapp/health";
import { MEDIA_BUCKET } from "@/server/whatsapp/media";
import type { Json } from "@/types/database";

export type SendOutcome = { messageId: string; status: "sent" | "failed" | "queued"; errorCode?: string };

export type OutboundContent =
  | { kind: "text"; body: string }
  | { kind: "media"; storagePath: string; mimeType: string; filename: string; size: number; caption: string | null }
  | { kind: "template"; name: string; language: string; params: string[] };

/**
 * Send a WhatsApp message (text, image/document, or approved template).
 *
 * 1. queue_outbound runs with the USER's session: number grant + can_reply,
 *    ownership, account active, the 24-hour rule (templates excepted),
 *    idempotency by clientRequestId; the user is recorded as sender.
 * 2. The Graph API call uses the server-side token (never the browser).
 * 3. record_outbound_result (service role) stores Meta's id or the error;
 *    credential failures alert administrators.
 * Simulated (development) numbers never call Meta.
 */
export async function sendOutbound(conversationId: string, clientRequestId: string, content: OutboundContent): Promise<SendOutcome> {
  const supabase = await createClient();
  await limitUser(supabase, "send_message");
  const { data: conv } = await supabase.from("conversations")
    .select("id, company_id, customer_wa_id, customer_bsuid, account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(id, is_simulated, provider)")
    .eq("id", conversationId).maybeSingle();
  if (!conv || !conv.account) throw new AppError("conversation.not_found");
  await requirePermission(conv.company_id, "send_messages");   // a custom role can switch sending off
  const viaKapso = conv.account.provider === "kapso" && !conv.account.is_simulated;
  // A customer known only by BSUID has no phone (never derived from the BSUID). Only text and files through a Kapso account may go to the BSUID itself;
  // anything else (templates) is refused here and by the database.
  const byBsuid = !conv.customer_wa_id && Boolean(conv.customer_bsuid);
  if (!conv.customer_wa_id && !(byBsuid && viaKapso && content.kind !== "template")) throw new AppError("whatsapp.recipient_phone_unknown");
  if (viaKapso) {
    // Kapso: text and files (no templates yet), and only to allow-listed recipients. Both checks run BEFORE anything is queued (fail closed).
    if (content.kind === "template") throw new AppError("whatsapp.kapso_text_only");
    let allowed = false;
    try {
      const list = parseSendAllowlist(serverEnv("kapsoSend").KAPSO_SEND_ALLOWLIST);
      allowed = byBsuid ? list.all : isRecipientAllowed(list, conv.customer_wa_id); // a BSUID can only be matched by "*"
    } catch { /* not configured */ }
    if (!allowed) throw new AppError("whatsapp.send_not_allowed");
  }

  const messageType = content.kind === "media" ? OUTBOUND_MEDIA[content.mimeType]?.kind : content.kind;
  if (!messageType) throw new AppError("media.unsupported_type");
  const { data, error } = await supabase.rpc("queue_outbound", {
    p_conversation_id: conversationId,
    p_client_request_id: clientRequestId,
    p_message_type: messageType,
    p_body: content.kind === "text" ? content.body : content.kind === "media" ? content.caption ?? undefined : undefined,
    p_media: content.kind === "media"
      ? ({ storage_path: content.storagePath, mime_type: content.mimeType, filename: content.filename, size: content.size } as Json)
      : undefined,
    p_template: content.kind === "template"
      ? ({ name: content.name, language: content.language, params: content.params } as Json)
      : undefined,
  });
  if (error) throw error;
  const queued = data?.[0];
  if (!queued) throw new AppError("generic");
  if (queued.already_queued) {
    // Same submission twice (double click / retry): never send twice.
    const { data: m } = await supabase.from("messages").select("status").eq("id", queued.message_id).single();
    return { messageId: queued.message_id, status: m?.status === "failed" ? "failed" : m?.status === "queued" ? "queued" : "sent" };
  }

  const admin = createAdminClient();
  if (viaKapso && content.kind !== "template") {
    const apiKey = serverEnv("kapsoSend").KAPSO_API_KEY;
    const phoneNumberId = queued.phone_number_id ?? "";
    let sent: KapsoSendResult;
    if (content.kind === "text") {
      sent = await sendKapsoText({ phoneNumberId, apiKey, toWaId: byBsuid ? null : queued.to_wa_id, toBsuid: byBsuid ? conv.customer_bsuid : null, body: content.body });
    } else {
      const kind = OUTBOUND_MEDIA[content.mimeType].kind;
      const file = await admin.storage.from(MEDIA_BUCKET).download(content.storagePath);
      const bytes = file.data ? new Uint8Array(await file.data.arrayBuffer()) : null;
      // OGG must really carry Opus, or WhatsApp refuses the voice note after the message already looks sent
      const opus = content.mimeType === "audio/ogg" && bytes !== null && isOggOpus(bytes);
      if (!bytes) {
        sent = { ok: false, kind: "definite", code: "media_missing", message: "Upload not found", httpStatus: null };
      } else if (content.mimeType === "audio/ogg" && !opus) {
        sent = { ok: false, kind: "definite", code: "invalid_audio", message: "Not an OGG/Opus recording", httpStatus: null };
      } else {
        const up = await uploadKapsoMedia({ phoneNumberId, apiKey, bytes, mimeType: content.mimeType, filename: content.filename });
        sent = up.ok
          ? await sendKapsoMedia({ phoneNumberId, apiKey, toWaId: byBsuid ? null : queued.to_wa_id, toBsuid: byBsuid ? conv.customer_bsuid : null, kind, mediaId: up.mediaId, caption: content.caption, filename: content.filename, voice: opus })
          : { ok: false, kind: "definite", code: up.code, message: up.message, httpStatus: up.httpStatus };   // nothing reached the customer
      }
    }
    if (sent.ok) {
      const { error: recErr } = await admin.rpc("record_outbound_result", { p_message_id: queued.message_id, p_wa_message_id: sent.waMessageId });
      if (recErr) console.error("[kapso-send] could not record result", { code: (recErr as { code?: string }).code });
      return { messageId: queued.message_id, status: "sent" };
    }
    if (sent.kind === "unconfirmed") {
      // Outcome unknown and Kapso has no idempotency key: never resend. The row stays queued; a whatsapp.message.sent webhook may confirm it,
      // otherwise expire_unconfirmed_outbound() marks it failed after 15 minutes so a person can decide.
      const { error: unErr } = await admin.rpc("record_outbound_unconfirmed", { p_message_id: queued.message_id });
      if (unErr) console.error("[kapso-send] could not mark unconfirmed", { code: (unErr as { code?: string }).code });
      console.warn("[kapso-send] unconfirmed", { code: sent.code, http: sent.httpStatus });
      return { messageId: queued.message_id, status: "queued" };
    }
    const { error: recErr } = await admin.rpc("record_outbound_result", {
      p_message_id: queued.message_id, p_wa_message_id: null as unknown as string, p_error_code: sent.code, p_error_message: sent.message,
    });
    if (recErr) console.error("[kapso-send] could not record result", { code: (recErr as { code?: string }).code });
    return { messageId: queued.message_id, status: "failed", errorCode: sent.code };
  }
  let result: SendResult;
  if (conv.account.is_simulated) {
    result = { ok: true, waMessageId: `sim.${queued.message_id}` };
  } else {
    const env = serverEnv("whatsapp");
    const common = { phoneNumberId: queued.phone_number_id ?? "", accessToken: env.WHATSAPP_ACCESS_TOKEN, apiVersion: env.WHATSAPP_GRAPH_API_VERSION, toWaId: queued.to_wa_id };
    const attempt = async (): Promise<SendResult> => {
      if (content.kind === "text") return sendTextMessage({ ...common, body: content.body });
      if (content.kind === "template") return sendTemplateMessage({ ...common, name: content.name, language: content.language, params: content.params });
      const file = await admin.storage.from(MEDIA_BUCKET).download(content.storagePath);
      if (file.error || !file.data) return { ok: false, code: "media_missing", message: "Upload not found", retryable: false, httpStatus: null };
      const up = await uploadMedia({ ...common, bytes: new Uint8Array(await file.data.arrayBuffer()), mimeType: content.mimeType, filename: content.filename });
      if (!up.ok) return up;
      return sendMediaMessage({ ...common, kind: OUTBOUND_MEDIA[content.mimeType].kind, mediaId: up.mediaId, caption: content.caption, filename: content.filename });
    };
    result = await attempt();
    // One quick retry for transient errors; longer outages show as failed with a resend button.
    if (!result.ok && result.retryable) {
      await new Promise((r) => setTimeout(r, backoffMs(0)));
      result = await attempt();
    }
    await recordCredentialResult(conv.account.id, result.ok ? { ok: true } : result);
  }

  const { error: recErr } = await admin.rpc("record_outbound_result", result.ok
    ? { p_message_id: queued.message_id, p_wa_message_id: result.waMessageId }
    : { p_message_id: queued.message_id, p_wa_message_id: null as unknown as string, p_error_code: result.code, p_error_message: result.message });
  if (recErr) console.error("[whatsapp-send] could not record result", { code: (recErr as { code?: string }).code });

  if (!result.ok && isCredentialError(result.code, result.httpStatus)) {
    return { messageId: queued.message_id, status: "failed", errorCode: "whatsapp.credentials_invalid" };
  }
  return result.ok
    ? { messageId: queued.message_id, status: "sent" }
    : { messageId: queued.message_id, status: "failed", errorCode: result.code };
}

/** Text reply (kept for existing callers). */
export function sendReply(conversationId: string, body: string, clientRequestId: string): Promise<SendOutcome> {
  return sendOutbound(conversationId, clientRequestId, { kind: "text", body });
}
