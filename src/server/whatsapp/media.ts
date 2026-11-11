import "server-only";
import { randomBytes } from "node:crypto";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/server/env";
import { AppError } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import {
  INBOUND_MEDIA_MAX_BYTES, INBOUND_MEDIA_TYPES, OUTBOUND_MEDIA, downloadMedia, getMediaUrl, isInlinePreview, safeFileName,
} from "@/lib/whatsapp/graph.ts";
import { recordCredentialResult } from "@/server/whatsapp/health";
import { cacheKapsoMedia } from "@/server/whatsapp/kapso-media";

export const MEDIA_BUCKET = "whatsapp-media";
const SIGNED_URL_SECONDS = 60;

/**
 * Outbound media, step 1: after checking with the USER's session that they
 * may reply in this conversation now, issue a one-time signed upload URL so
 * the browser uploads straight to private Storage (no size limits of the
 * app server). Path: outbound/<conversation>/<random>/<name> — the only
 * pattern queue_outbound accepts for this conversation.
 */
export async function prepareOutboundUpload(input: { conversationId: string; filename: string; mimeType: string; size: number }) {
  const rule = OUTBOUND_MEDIA[input.mimeType];
  if (!rule) throw new AppError("media.unsupported_type");
  if (input.size <= 0 || input.size > rule.maxBytes) throw new AppError("media.too_large");

  const viewer = await getViewer();
  const supabase = await createClient();
  const { data: conv } = await supabase.from("conversations").select("id, whatsapp_account_id, last_inbound_at").eq("id", input.conversationId).maybeSingle();
  if (!conv) throw new AppError("conversation.not_found");
  if (!viewer.isSuperAdmin) {
    const { data: grant } = await supabase.from("whatsapp_account_access").select("can_reply")
      .eq("whatsapp_account_id", conv.whatsapp_account_id).eq("user_id", viewer.id).maybeSingle();
    if (!grant?.can_reply) throw new AppError("whatsapp.no_reply_permission");
  }
  if (!conv.last_inbound_at || Date.parse(conv.last_inbound_at) < Date.now() - 24 * 3_600_000) {
    throw new AppError("whatsapp.outside_service_window");
  }
  const path = `outbound/${conv.id}/${randomBytes(9).toString("hex")}/${safeFileName(input.filename)}`;
  const { data, error } = await createAdminClient().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new AppError("generic");
  return { path: data.path, token: data.token };
}

/** Outbound media, step 2: confirm the upload exists with the declared type and a permitted size. */
export async function verifyOutboundUpload(conversationId: string, path: string, mimeType: string) {
  if (!path.startsWith(`outbound/${conversationId}/`)) throw new AppError("message.invalid_media");
  const { data, error } = await createAdminClient().storage.from(MEDIA_BUCKET).info(path);
  if (error || !data) throw new AppError("media.not_uploaded");
  const size = data.size ?? 0;
  const rule = OUTBOUND_MEDIA[mimeType];
  if (!rule || (data.contentType && data.contentType.split(";")[0] !== mimeType)) throw new AppError("media.unsupported_type");
  if (size <= 0 || size > rule.maxBytes) throw new AppError("media.too_large");
  return { size };
}

type MessageMedia = { id?: string; mimeType?: string; filename?: string; storage_path?: string; mime_type?: string };

/**
 * A short-lived URL for a message's media, after an RLS check that the user
 * can see the message. Inbound media is downloaded from Meta (5-minute URL,
 * token required) on first view and cached in private Storage, because
 * Meta's media ids expire after 7 days.
 */
export async function mediaUrlForMessage(messageId: string): Promise<{ url: string; inline: boolean }> {
  const supabase = await createClient();
  const { data: msg } = await supabase.from("messages")
    .select("id, conversation_id, direction, media, conversation:conversations!messages_conversation_id_fkey(id, account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(id, is_simulated, provider, phone_number_id))")
    .eq("id", messageId).maybeSingle();
  if (!msg) throw new AppError("media.unavailable");
  // A message without media JSON can still have a cached file (history files copied by the backfill)
  const media = (msg.media ?? {}) as MessageMedia & { provider?: string; url?: string | null };
  const admin = createAdminClient();
  const signed = async (path: string, mimeType: string, filename: string) => {
    const inline = isInlinePreview(mimeType);
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS, inline ? {} : { download: filename });
    if (error || !data) throw new AppError("media.unavailable");
    return { url: data.signedUrl, inline };
  };

  if (media.storage_path) {
    return signed(media.storage_path, media.mime_type ?? "application/octet-stream", media.filename ?? "file");
  }
  const { data: cached } = await supabase.from("message_media_cache").select("storage_path, mime_type").eq("message_id", msg.id).maybeSingle();
  if (cached) return signed(cached.storage_path, cached.mime_type, media.filename ?? "file");

  const account = msg.conversation?.account;
  if (!media.id || !account || account.is_simulated) throw new AppError("media.unavailable");
  if (media.provider === "kapso" && account.provider === "kapso") {
    // Kapso file not copied yet (the prefetch after the webhook failed or has not run): fetch and cache it now
    const got = await cacheKapsoMedia({ messageId: msg.id, conversationId: msg.conversation_id, phoneNumberId: account.phone_number_id ?? "", media });
    if (!got) throw new AppError("media.unavailable");
    return signed(got.path, got.mimeType, got.filename);
  }
  const env = serverEnv("whatsapp");
  const meta = await getMediaUrl({ mediaId: media.id, accessToken: env.WHATSAPP_ACCESS_TOKEN, apiVersion: env.WHATSAPP_GRAPH_API_VERSION });
  if (!meta.ok) {
    await recordCredentialResult(account.id, meta);
    throw new AppError("media.unavailable");
  }
  const file = await downloadMedia({ url: meta.url, accessToken: env.WHATSAPP_ACCESS_TOKEN, maxBytes: INBOUND_MEDIA_MAX_BYTES });
  if (!file.ok) {
    await recordCredentialResult(account.id, file);
    throw new AppError(file.code === "media_too_large" ? "media.too_large" : "media.unavailable");
  }
  await recordCredentialResult(account.id, { ok: true });
  // Unknown types are stored as opaque downloads, never rendered.
  const mimeType = INBOUND_MEDIA_TYPES.has(file.mimeType) ? file.mimeType : "application/octet-stream";
  const filename = safeFileName(media.filename ?? `${media.id}`);
  const path = `inbound/${msg.conversation_id}/${msg.id}/${filename}`;
  const up = await admin.storage.from(MEDIA_BUCKET).upload(path, file.bytes, { contentType: mimeType, upsert: true });
  if (up.error) throw new AppError("generic");
  await admin.from("message_media_cache").upsert({ message_id: msg.id, storage_path: path, mime_type: mimeType, size_bytes: file.bytes.byteLength });
  return signed(path, mimeType, filename);
}
