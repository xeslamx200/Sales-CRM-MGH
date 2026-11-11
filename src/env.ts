/**
 * Environment validation. Framework-free so it can be unit-tested.
 *
 * Errors name the offending variables only — never their values — so a
 * misconfigured deployment can't leak a secret into logs.
 *
 * Variables are grouped so the app can run (sign-in, CRM screens) before the
 * WhatsApp integration is configured: the core group is validated at server
 * start (src/instrumentation.ts); the others when a feature first needs them.
 */
import { z } from "zod";

const url = z.string().url();
const secret = z.string().min(16);

export const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

export const serverSchemas = {
  core: z.object({
    APP_URL: url,
  }),
  /** Service-role key: webhook processing, send results, cron, invites. */
  serviceRole: z.object({
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  }),
  cron: z.object({
    CRON_SECRET: secret,
  }),
  whatsapp: z.object({
    WHATSAPP_APP_SECRET: z.string().min(16),
    WHATSAPP_VERIFY_TOKEN: secret,
    WHATSAPP_ACCESS_TOKEN: z.string().min(20),
    WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
  }),
  /** Kapso Sandbox (Phase 1: receive-only). Signing secret of the Kapso webhook. */
  kapso: z.object({
    KAPSO_WEBHOOK_SECRET: secret,
    /**
     * Webhook protocol: "v1" (default, the Phase 1 sandbox path) or "v2" (Rev6 account model; needs supabase/proposed/970, 972, 975, 977
     * and 978 applied; a real Coexistence number also needs 979). Any other value fails closed (the webhook answers 503 "not configured"). The default never serves a production
     * account: v1 quarantines its items as `protocol.v2_required` (src/lib/kapso/protocol.ts), so production needs an explicit "v2".
     */
    KAPSO_PROTOCOL: z.enum(["v1", "v2"]).default("v1"),
  }),
  /** Reading from Kapso: downloading the files of received media (images, voice notes, stickers). Without it only the signed link in the webhook can be used. */
  kapsoApi: z.object({
    KAPSO_API_KEY: z.string().min(20),
  }),
  /**
   * Sending through Kapso (text only). Both are required: without the API key nothing is sent, and without KAPSO_SEND_ALLOWLIST
   * (phone numbers allowed as recipients, or `*` for everyone) nothing is sent either (fail closed, checked before anything is queued).
   * Sending also needs the database switch: whatsapp_accounts.outbound_enabled = true and status 'active'.
   */
  kapsoSend: z.object({
    KAPSO_API_KEY: z.string().min(20),
    KAPSO_SEND_ALLOWLIST: z.string().min(1),
  }),
} as const;

export class EnvError extends Error {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(`Missing or invalid environment variables: ${variables.join(", ")}`);
    this.name = "EnvError";
    this.variables = variables;
  }
}

/** Parse `source` with `schema`; on failure throw EnvError naming only the variables. */
export function parseEnv<S extends z.ZodObject>(schema: S, source: Record<string, string | undefined>): z.infer<S> {
  // Treat empty strings as missing (an empty line in .env is a common mistake).
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = source[key];
    cleaned[key] = v === undefined || v.trim() === "" ? undefined : v.trim();
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "?")))].sort();
    throw new EnvError(names);
  }
  return result.data;
}

/**
 * Public (browser-safe) variables. Each is referenced literally so Next.js can
 * inline it into client bundles.
 */
export function publicEnv() {
  return parseEnv(publicSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}
