import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/server/env";
import { INBOUND_MEDIA_MAX_BYTES, INBOUND_MEDIA_TYPES, safeFileName } from "@/lib/whatsapp/graph.ts";
import { fetchKapsoMedia } from "@/lib/kapso/media.ts";

const MEDIA_BUCKET = "whatsapp-media";

type KapsoMediaJson = { provider?: string; id?: string; url?: string | null; filename?: string | null; mime_type?: string | null };

/**
 * Copy one Kapso file into private Storage and record it in message_media_cache (service role: the caller has already authorised the read,
 * or the message was just stored by the webhook). Idempotent: an existing cache row means done. Returns the stored path and type, or null.
 * The file is fetched with the documented Kapso media path (API key to api.kapso.ai only), falling back to the signed webhook link.
 */
export async function cacheKapsoMedia(input: {
  messageId: string; conversationId: string; phoneNumberId: string; media: KapsoMediaJson;
}): Promise<{ path: string; mimeType: string; filename: string } | null> {
  const admin = createAdminClient();
  const { media } = input;
  const filename = safeFileName(media.filename ?? media.id ?? "file");
  const { data: cached } = await admin.from("message_media_cache").select("storage_path, mime_type").eq("message_id", input.messageId).maybeSingle();
  if (cached) return { path: cached.storage_path, mimeType: cached.mime_type, filename };
  if (media.provider !== "kapso" || !media.id) return null;

  let apiKey = "";
  try { apiKey = serverEnv("kapsoApi").KAPSO_API_KEY; } catch { /* key not configured: only the signed link can work */ }
  const file = await fetchKapsoMedia({ apiKey, phoneNumberId: input.phoneNumberId, mediaId: media.id, url: media.url, maxBytes: INBOUND_MEDIA_MAX_BYTES });
  if (!file.ok) return null;
  // types outside the allow-list are stored as opaque downloads and never rendered
  const mimeType = INBOUND_MEDIA_TYPES.has(file.mimeType) ? file.mimeType : "application/octet-stream";
  const path = `inbound/${input.conversationId}/${input.messageId}/${filename}`;
  const up = await admin.storage.from(MEDIA_BUCKET).upload(path, file.bytes, { contentType: mimeType, upsert: true });
  if (up.error) return null;
  const { error } = await admin.from("message_media_cache").upsert({ message_id: input.messageId, storage_path: path, mime_type: mimeType, size_bytes: file.bytes.byteLength });
  if (error) return null;
  return { path, mimeType, filename };
}

/** Right after the webhook stored a message with a file: fetch it now (before the signed link / media id can expire). Never throws. */
export async function prefetchKapsoMedia(waMessageId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: msg } = await admin.from("messages")
      .select("id, conversation_id, media, conversation:conversations!messages_conversation_id_fkey(account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(phone_number_id, provider))")
      .eq("wa_message_id", waMessageId).maybeSingle();
    const media = msg?.media as KapsoMediaJson | null | undefined;
    const account = msg?.conversation?.account;
    if (!msg || !media || media.provider !== "kapso" || !account?.phone_number_id || account.provider !== "kapso") return;
    await cacheKapsoMedia({ messageId: msg.id, conversationId: msg.conversation_id, phoneNumberId: account.phone_number_id, media });
  } catch (err) {
    console.warn("[kapso-media] prefetch failed", { code: (err as { code?: string })?.code ?? "error" });
  }
}
