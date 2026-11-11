import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { dbEventKind, type ClaimResult, type WebhookStore } from "@/lib/whatsapp/processor.ts";
import type { MediaRef } from "@/lib/whatsapp/webhook-parser.ts";
import type { Json } from "@/types/database";

// Always send every RPC argument: PostgREST matches functions by argument
// names, so an omitted (undefined) key means "function not found" (PGRST202).
function mediaJson(m: MediaRef | null): Json {
  return m ? (JSON.parse(JSON.stringify(m)) as Json) : null;
}

/**
 * WebhookStore backed by the SERVICE-ROLE client. Used only by the webhook
 * route and the retry cron. Every write goes through a service-only RPC that
 * validates input and is idempotent (event-key claim + unique wa_message_id).
 */
export function createWebhookStore(): WebhookStore {
  const db = createAdminClient();
  return {
    async claimEvent(e) {
      const { data, error } = await db.rpc("claim_webhook_event", {
        p_event_key: e.eventKey,
        p_event_kind: dbEventKind(e.kind),
        p_phone_number_id: e.phoneNumberId,
        p_payload: e.payload as Json,
      });
      if (error) throw error;
      return data as ClaimResult;
    },
    async finishEvent(eventKey, status, err) {
      const { error } = await db.rpc("finish_webhook_event", { p_event_key: eventKey, p_status: status, p_error: err });
      if (error) throw error;
    },
    async ingestMessage(e) {
      const { data, error } = await db.rpc("ingest_whatsapp_message", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_from_wa_id: e.fromWaId,
        p_profile_name: e.profileName ?? "", p_message_type: e.messageType, p_body: e.body ?? "",
        p_media: mediaJson(e.media), p_sent_at: e.sentAt.toISOString(),
      });
      if (error) throw error;
      return { duplicate: Boolean(data?.[0]?.duplicate) };
    },
    async ingestEcho(e) {
      const { data, error } = await db.rpc("ingest_whatsapp_echo", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_to_wa_id: e.toWaId,
        p_message_type: e.messageType, p_body: e.body ?? "", p_media: mediaJson(e.media) as Json,
        p_sent_at: e.sentAt.toISOString(),
      });
      if (error) throw error;
      return { duplicate: Boolean(data?.[0]?.duplicate) };
    },
    async applyStatus(e) {
      const { data, error } = await db.rpc("apply_whatsapp_status", {
        p_wa_message_id: e.waMessageId, p_status: e.status,
        p_error_code: e.errorCode ?? undefined, p_error_message: e.errorMessage ?? undefined,
      });
      if (error) throw error;
      return Boolean(data);
    },
  };
}
