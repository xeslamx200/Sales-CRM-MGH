import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { kapsoDbEventKind, type KapsoStore } from "@/lib/kapso/processor.ts";
import type { ClaimResult } from "@/lib/whatsapp/processor.ts";
import type { Json } from "@/types/database";
import { createKapsoStoreV2, type RpcClient } from "@/lib/kapso/store-v2.ts";
import type { KapsoStoreV2 } from "@/lib/kapso/v2.ts";

// Always send every RPC argument: PostgREST matches functions by argument
// names, so an omitted (undefined) key means "function not found" (PGRST202).

/**
 * KapsoStore backed by the SERVICE-ROLE client. Used only by the Kapso webhook
 * route. The generic claim/finish RPCs only book-keep events; every write goes
 * through the provider-specific wrappers (ingest_kapso_message /
 * apply_kapso_status), which re-validate in the database that the
 * phone_number_id belongs to a Kapso sandbox account of a sandbox company. The
 * request never supplies a company or account id.
 */
export function createKapsoStore(): KapsoStore {
  const db = createAdminClient();
  return {
    async claimEvent(e) {
      const { data, error } = await db.rpc("claim_webhook_event", {
        p_event_key: e.eventKey,
        p_event_kind: kapsoDbEventKind(e.kind),
        // null only for a quarantine record whose phone_number_id was unusable (the column is nullable)
        p_phone_number_id: e.phoneNumberId as string,
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
      const { data, error } = await db.rpc("ingest_kapso_message", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_from_wa_id: e.fromWaId,
        p_profile_name: e.profileName ?? "", p_message_type: e.messageType, p_body: e.body ?? "",
        p_media: null, p_sent_at: e.sentAt.toISOString(),
      });
      if (error) throw error;
      return { duplicate: Boolean(data?.[0]?.duplicate) };
    },
    async applyStatus(e) {
      const { data, error } = await db.rpc("apply_kapso_status", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_status: e.status,
        p_error_code: e.errorCode ?? undefined, p_error_message: e.errorMessage ?? undefined,
        p_to_wa_id: e.toWaId ?? undefined, p_message_type: e.messageType ?? undefined, p_body: e.body ?? undefined,
        p_media: null, p_sent_at: e.sentAt ? e.sentAt.toISOString() : undefined,
      });
      if (error) throw error;
      return Boolean(data);
    },
    async accountClass(phoneNumberId) {
      // kapso_account_protocol exists only with supabase/migrations/20261104000978 (not in the generated types); a database without it
      // answers PGRST202, which handleKapsoPost reads as "pre-Rev6 schema: every Kapso account is a sandbox".
      const { data, error } = await (db as unknown as RpcClient).rpc("kapso_account_protocol", { p_phone_number_id: phoneNumberId });
      if (error) throw error;
      return data === "sandbox" || data === "production" || data === "misconfigured" ? data : null;
    },
  };
}

/**
 * Protocol v2 store (Rev6 account model), same service-role client. The v2 RPCs are not in the generated types yet (they exist only after
 * supabase/migrations/20261104000970_kapso_production.sql is applied and `npm run db:types` is re-run), hence the narrow RpcClient cast.
 */
export function createKapsoStoreV2Server(): KapsoStoreV2 {
  return createKapsoStoreV2(createAdminClient() as unknown as RpcClient);
}
