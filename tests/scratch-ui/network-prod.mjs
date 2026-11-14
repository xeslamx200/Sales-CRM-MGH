// READ-ONLY: every network request of a page of the DEPLOYED site (type, size, time, cache headers) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const P = process.env.PAGE ?? "/contacts";
const reqs = [];
page.on("requestfinished", async (r) => { const res = await r.response(); const sz = await r.sizes().catch(() => null); reqs.push({ url: r.url().replace(APP, ""), type: r.resourceType(), status: res?.status(), kb: Math.round(((sz?.responseBodySize ?? 0) + (sz?.responseHeadersSize ?? 0)) / 102.4) / 10, cache: (res?.headers()["cache-control"] ?? "").slice(0, 40), ms: Math.round(r.timing().responseEnd) }); });
await page.goto(`${APP}${P}`, { waitUntil: "networkidle" });
const byType = {}; for (const r of reqs) byType[r.type] = (byType[r.type] ?? 0) + r.kb;
console.log(`${P}: ${reqs.length} requests;`, Object.entries(byType).map(([k, v]) => `${k} ${Math.round(v)} KB`).join(", "));
for (const r of reqs.filter((r) => r.type !== "script").sort((a, b) => b.kb - a.kb).slice(0, 12)) console.log(`  ${String(r.kb).padStart(7)} KB  ${r.type.padEnd(9)} ${String(r.status)}  ${r.ms}ms  ${r.cache.padEnd(40)} ${r.url.slice(0, 70)}`);
await browser.close();
