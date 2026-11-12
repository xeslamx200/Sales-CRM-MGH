// Re-sets the Vercel production variables WITHOUT a byte-order mark (the first setup run, piped from Windows PowerShell 5.1, put an invisible
// U+FEFF in front of every value; the browser then refused to build request headers from the Supabase key). Values come from .env.local and
// are never printed. Usage: node scripts/deploy/vercel-env-fix.mjs [NAME ...]
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+\s*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "").trim()]; }));
const only = process.argv.slice(2);   // optional: names to set (default: all)
const APP_URL = "https://sales-crm-mgh.vercel.app";
const vars = [
  ["NEXT_PUBLIC_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL, false], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY, false],
  ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY, true], ["KAPSO_WEBHOOK_SECRET", env.KAPSO_WEBHOOK_SECRET, true], ["KAPSO_API_KEY", env.KAPSO_API_KEY, true],
  ["KAPSO_PROTOCOL", "v2", false], ["KAPSO_SEND_ALLOWLIST", "*", false], ["CRON_SECRET", randomBytes(32).toString("hex"), true], ["APP_URL", APP_URL, false],
];
for (const [name, value, secret] of vars) {
  if (only.length && !only.includes(name)) continue;
  if (!value || /[^\x21-\x7e]/.test(value)) { console.log(`skip ${name}: empty or not plain ASCII`); process.exitCode = 1; continue; }
  const args = ["vercel", "env", "add", name, "production", "--force", ...(secret ? ["--sensitive"] : ["--type", "config", "--yes"])];
  const r = spawnSync("npx", args, { input: Buffer.from(value, "utf8"), shell: true, encoding: "utf8" });
  console.log(`${r.status === 0 ? "set " : "FAILED "}${name}`);
  if (r.status !== 0) process.exitCode = 1;
}
