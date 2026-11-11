/**
 * KapsoStoreV2 on top of a minimal RPC client, so the exact argument mapping used in production can be exercised against a real database
 * in tests (any `{ rpc(name, args) }` works: the Supabase service-role client in the app, a psql adapter in the scratch tests).
 *
 * Every RPC argument is always sent, `null` when absent (PostgREST matches functions by argument NAMES; an omitted key means "function not
 * found"). The caller never supplies a company or account id: only the phone_number_id, which the database maps to the account.
 * The functions used exist only after the Rev6 migration (supabase/proposed/20261104000970_kapso_production.sql) and the lifecycle
 * migration (supabase/proposed/20261104000978_kapso_event_lifecycle.sql).
 */
import type { ClaimResult } from "../whatsapp/processor.ts";
import type { HeldRecord, KapsoAccountClass, KapsoInboundV2, KapsoQuarantineReader, KapsoStatusV2, KapsoStoreV2 } from "./v2.ts";

export type RpcResponse = { data: unknown; error: unknown };
export type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResponse> };

const ACCOUNT_CLASSES = new Set(["sandbox", "production", "misconfigured"]);

export function createKapsoStoreV2(db: RpcClient): KapsoStoreV2 & KapsoQuarantineReader {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  };
  return {
    async claimEvent(e) {
      return (await call("claim_kapso_event", {
        p_event_key: e.eventKey, p_event_kind: e.kind, p_phone_number_id: e.phoneNumberId, p_payload: e.payload,
      })) as ClaimResult;
    },
    async finishEvent(eventKey, status, err) {
      const r = await call("finish_kapso_event", { p_event_key: eventKey, p_status: status, p_error: err ?? null });
      // anything else would mean a different function (or a wrong deployment): never read it as success
      if (r !== "finished" && r !== "already_final") throw new Error("webhook.unexpected_result");
      return r;
    },
    async recordHeld(e: HeldRecord) {
      const r = await call("record_kapso_held_event", {
        p_event_key: e.eventKey, p_event_kind: e.kind, p_phone_number_id: e.phoneNumberId, p_payload: e.payload,
        p_status: e.status, p_reason: e.reason,
      });
      if (r !== "recorded" && r !== "duplicate") throw new Error("webhook.unexpected_result");
      return r;
    },
    async accountClass(phoneNumberId): Promise<KapsoAccountClass> {
      const r = await call("kapso_account_protocol", { p_phone_number_id: phoneNumberId });
      return typeof r === "string" && ACCOUNT_CLASSES.has(r) ? (r as KapsoAccountClass) : null;
    },
    async ingestInbound(e: KapsoInboundV2) {
      const data = (await call("ingest_kapso_inbound", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_from_wa_id: e.fromWaId, p_from_bsuid: e.fromBsuid,
        p_origin: e.origin, p_profile_name: e.profileName ?? "", p_message_type: e.messageType, p_body: e.body ?? "",
        p_media: e.media, p_sent_at: e.sentAt.toISOString(),
      })) as Array<{ o_duplicate?: boolean }> | null;
      return { duplicate: Boolean(data?.[0]?.o_duplicate) };
    },
    async applyStatus(e: KapsoStatusV2) {
      const data = await call("apply_kapso_status_v2", {
        p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_status: e.status,
        p_error_code: e.errorCode, p_error_message: e.errorMessage, p_to_wa_id: e.toWaId, p_to_bsuid: e.toBsuid,
        p_origin: e.origin, p_message_type: e.messageType, p_body: e.body, p_media: e.media,
        p_sent_at: e.sentAt ? e.sentAt.toISOString() : null, p_is_retry: false,
      });
      return Boolean(data);
    },
    async touchAccount(phoneNumberId) {
      await call("touch_kapso_account", { p_phone_number_id: phoneNumberId });
    },
    async listQuarantined(reason, limit) {
      const rows = (await call("list_kapso_quarantined", { p_reason: reason, p_limit: limit })) as Array<{ event_key: string; payload: unknown }> | null;
      return (rows ?? []).map((r) => ({ eventKey: r.event_key, payload: r.payload }));
    },
  };
}
