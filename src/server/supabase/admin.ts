import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/env";
import { serverEnv } from "@/server/env";
import type { Database } from "@/types/database";

/**
 * SERVICE-ROLE client. Bypasses RLS. Allowed uses only:
 *   - WhatsApp webhook processing and retries (src/server/whatsapp/*)
 *   - recording outbound send results (record_outbound_result)
 *   - cron jobs (src/app/api/cron/*)
 *   - Auth Admin API calls for invitations (src/server/auth/invite.ts),
 *     after the caller's permission was checked with their own session
 * Enforced by the no-restricted-imports rule in eslint.config.mjs.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv("serviceRole");
  return createClient<Database>(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
