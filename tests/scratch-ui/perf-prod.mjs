// READ-ONLY timing of the DEPLOYED site as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
await ctx.addCookies([{ name: "crm_locale", value: "en", domain: host, path: "/", secure: true }]);
const page = await ctx.newPage();
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/contacts,/bookings,/workshops,/payments,/customer-payments,/performance,/tasks,/reports,/search?q=a,/profile,/admin/settings,/admin/whatsapp,/admin/users,/admin/teams,/admin/offerings,/admin/audit,/admin/system").split(",");
const rows = [];
for (const p of PAGES) {
  const one = async () => {
    const t0 = Date.now();
    const r = await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 120000 });
    const total = Date.now() - t0;
    const ttfb = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0].responseStart));
    return { status: r?.status(), ttfb, total, url: new globalThis.URL(page.url()).pathname };
  };
  const a = await one(), b = await one(), c = await one();
  rows.push({ page: p, status: a.status, landed: a.url, "1st ttfb": a.ttfb, "2nd ttfb": b.ttfb, "3rd ttfb": c.ttfb, "3rd load": c.total });
}
console.table(rows);
await browser.close();
