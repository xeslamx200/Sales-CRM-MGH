// READ-ONLY check of the WhatsApp report log and of table alignment on the DEPLOYED site as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${APP}/reports?tab=whatsapp&period=last_7_days`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
const log = await page.evaluate(() => {
  const t = document.querySelector('[data-testid="response-log"] table'); if (!t) return null;
  return { heads: [...t.querySelectorAll("thead th")].map((x) => x.textContent.trim()), rows: [...t.querySelectorAll("tbody tr")].slice(0, 6).map((tr) => [...tr.children].map((c) => c.textContent.trim().replace(/\s+/g, " "))), count: t.querySelectorAll("tbody tr").length };
});
console.log("response log:", JSON.stringify(log?.heads), "rows:", log?.count);
for (const r of log?.rows ?? []) console.log("  ", JSON.stringify(r));
await page.screenshot({ path: "tests/scratch-ui/out/whatsapp-log.png" });
// alignment of every table on the main pages
const pages = ["/reports?tab=whatsapp", "/reports?tab=employees", "/reports?tab=shifts", "/admin/audit", "/admin/users", "/admin/offerings", "/admin/settings", "/admin/system", "/bookings", "/payments", "/leads", "/contacts", "/performance", "/"];
const bad = [];
for (const p of pages) {
  await page.goto(`${APP}${p}`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  const r = await page.evaluate(() => { const cells = [...document.querySelectorAll("table th, table td")]; const off = cells.filter((c) => getComputedStyle(c).textAlign !== "center"); return { tables: document.querySelectorAll("table").length, cells: cells.length, notCentered: off.length, sample: off.slice(0, 2).map((c) => c.textContent.trim().slice(0, 20) + ":" + getComputedStyle(c).textAlign) }; });
  console.log(p.padEnd(24), JSON.stringify(r));
  if (r.notCentered) bad.push(p);
}
console.log(bad.length ? "NOT CENTERED ON: " + bad.join(", ") : "ALL TABLE CELLS CENTERED");
await browser.close();
