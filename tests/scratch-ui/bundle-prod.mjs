// READ-ONLY: which JavaScript files each page of the DEPLOYED site loads (size, and what they contain) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
// admin API (magic-link token verified immediately; nothing is written to the CRM, no password is needed) and put in the browser as the normal
// session cookie. Secrets are read from .env.local and never printed. Usage: EMAIL=... node tests/scratch-ui/perf-prod.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const APP = process.env.APP ?? "https://sales-crm-mgh.vercel.app", EMAIL = process.env.EMAIL;
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+\s*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const link = await (await fetch(`${URL_}/auth/v1/admin/generate_link`, { method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ type: "magiclink", email: EMAIL }) })).json();
const ses = await (await fetch(`${URL_}/auth/v1/verify`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token }) })).json();
if (!ses.access_token) { console.log("could not mint a session"); process.exit(1); }
const ref = new globalThis.URL(URL_).hostname.split(".")[0];
const value = "base64-" + Buffer.from(JSON.stringify(ses)).toString("base64url");
const name = `sb-${ref}-auth-token`, SIZE = 3180, host = new globalThis.URL(APP).hostname;
const cookies = value.length <= SIZE ? [{ name, value }] : Array.from({ length: Math.ceil(value.length / SIZE) }, (_, i) => ({ name: `${name}.${i}`, value: value.slice(i * SIZE, (i + 1) * SIZE) }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies.map((c) => ({ ...c, domain: host, path: "/", secure: true, sameSite: "Lax" })));
await ctx.addCookies([{ name: "crm_locale", value: process.env.LOCALE ?? "en", domain: host, path: "/", secure: true }]);
const page = await ctx.newPage();
const PAGES = (process.env.PAGES ?? "/contacts,/leads,/inbox,/").split(",");
for (const p of PAGES) {
  const files = new Map();
  const onResp = async (r) => { if (/\/_next\/static\/.*\.js/.test(r.url())) { const b = await r.body().catch(() => null); if (b) files.set(r.url().split("/").pop().split("?")[0], b); } };
  page.on("response", onResp);
  await page.goto(`${APP}${p}`, { waitUntil: "networkidle" }).catch(() => undefined);
  page.off("response", onResp);
  const { gzipSync } = await import("node:zlib");
  const rows = [...files].map(([n, b]) => { const t = b.toString("utf8"); return { n, gz: gzipSync(b).length, raw: b.length, has: ["recharts", "GoTrueClient", "createBrowserClient", "zod", "react-dom", "radix", "cmdk", "react-hook-form", "sonner", "next/dist"].filter((k) => (t.match(new RegExp(k, "gi")) ?? []).length > 3).join(",") }; }).sort((a, b) => b.gz - a.gz);
  console.log(`
${p}: ${rows.length} files, ${Math.round(rows.reduce((s, r) => s + r.gz, 0) / 1024)} KB gzip, ${Math.round(rows.reduce((s, r) => s + r.raw, 0) / 1024)} KB raw`);
  for (const r of rows.slice(0, 8)) console.log(`  ${String(Math.round(r.gz / 1024)).padStart(4)} KB gz  ${String(Math.round(r.raw / 1024)).padStart(5)} KB raw  ${r.n.slice(0, 22).padEnd(22)} ${r.has}`);
}
await browser.close();
