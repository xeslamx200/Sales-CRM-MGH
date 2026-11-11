// Fails if a server-only secret appears anywhere in the browser bundle.
// Run after `next build`, with the same environment the build used:
//   node --env-file=.env.local scripts/check-client-bundle.mjs
// Checks: (1) the VALUES of every server-only variable, (2) any embedded JWT
// whose role is service_role, (3) server-only variable NAMES (a sign that
// server code was bundled for the client). Never prints secret values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".next/static";
const SERVER_ONLY = ["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN"];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|css|html|json|map)$/.test(name)) yield p;
  }
}

let scanned = 0;
const problems = [];
const secrets = SERVER_ONLY.map((n) => [n, process.env[n]]).filter(([, v]) => v && v.length >= 8);
for (const file of files(ROOT)) {
  const text = readFileSync(file, "utf8");
  scanned++;
  for (const [name, value] of secrets) {
    if (text.includes(value)) problems.push(`${file}: contains the value of ${name}`);
  }
  for (const name of SERVER_ONLY) {
    if (text.includes(name)) problems.push(`${file}: references ${name}`);
  }
  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") problems.push(`${file}: embeds a service_role JWT`);
    } catch { /* not a JWT */ }
  }
}

if (scanned === 0) {
  console.error(`No files under ${ROOT}; run \`next build\` first.`);
  process.exit(2);
}
// Without the real values the value check is vacuous: refuse instead of passing silently.
if (!secrets.some(([name]) => name === "SUPABASE_SERVICE_ROLE_KEY")) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set, so the bundle cannot be checked for it. Run with --env-file (npm run check:bundle does).");
  process.exit(2);
}
if (problems.length) {
  console.error(`Client bundle check FAILED (${problems.length}):\n` + problems.join("\n"));
  process.exit(1);
}
console.log(`Client bundle check passed: ${scanned} files, ${secrets.length} secret values and service_role JWTs checked.`);
