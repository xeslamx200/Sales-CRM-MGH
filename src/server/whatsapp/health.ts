import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { isCredentialError } from "@/lib/whatsapp/graph.ts";

/**
 * Record what a Graph API call proved about a number's credentials.
 * A credential failure (expired / revoked / invalid token, missing
 * permission) alerts administrators once a day (report_whatsapp_account_health);
 * other failures (rate limits, bad input) say nothing about credentials.
 */
export async function recordCredentialResult(
  accountId: string, result: { ok: true } | { ok: false; code: string; httpStatus: number | null },
): Promise<void> {
  if (!result.ok && !isCredentialError(result.code, result.httpStatus)) return;
  const { error } = await createAdminClient().rpc("report_whatsapp_account_health", {
    p_account_id: accountId, p_ok: result.ok, p_error_code: result.ok ? undefined : result.code,
  });
  if (error) console.warn("[whatsapp-health] could not record", { code: (error as { code?: string }).code });
}
