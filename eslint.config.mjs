import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The service-role client bypasses RLS. Only these paths may import it
// (webhook processing, recording send results, cron jobs, auth admin calls,
// rate-limit counters for unauthenticated endpoints, and private Storage I/O
// for record attachments AFTER a user-session authorization check).
// Everything else must use the user's session so RLS and DB rules apply.
const SERVICE_ROLE_ALLOWED = [
  "src/server/supabase/admin.ts",
  "src/server/whatsapp/**",
  "src/server/auth/invite.ts",
  "src/server/auth/people.ts",
  "src/server/rate-limit.ts",
  "src/server/attachments.ts",
  "src/server/fx.ts",   // writes the public exchange-rate table (no user data) through the service-only upsert_fx_rates RPC
  "src/app/api/webhooks/**",
  "src/app/api/cron/**",
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: SERVICE_ROLE_ALLOWED,
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "@/server/supabase/admin", message: "Service-role client: only webhook/cron/send-result/invite code may use it. Use the user's session client." }],
        patterns: [{ group: ["**/supabase/admin", "**/supabase/admin.ts"], message: "Service-role client is restricted (see eslint.config.mjs)." }],
      }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
]);
