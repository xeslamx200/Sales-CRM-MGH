// READ-ONLY: time of in-app navigation (clicking menu links) on the DEPLOYED site, first time and when going back to a page just visited as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const phone = process.env.PROFILE === "phone";
const context = phone ? await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }) : ctx;
if (phone) await context.addCookies(await ctx.cookies());
const page = await context.newPage();
if (phone) { const cdp = await context.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }); }
await page.goto(`${APP}/leads`, { waitUntil: "networkidle" });
const open = async () => { if (phone) { const t = page.locator('[data-sidebar="trigger"]').first(); if (await t.isVisible()) await t.click(); } };
const go = async (href) => {
  await open();
  const link = page.locator(`[data-sidebar="menu-button"][href="${href}"], a[data-sidebar="menu-button"][href="${href}"]`).first();
  const t0 = Date.now();
  await link.click();
  await page.waitForURL((u) => u.pathname === href, { timeout: 30000 });
  await page.locator("main h1").first().waitFor({ timeout: 30000 }).catch(() => undefined);
  return Date.now() - t0;
};
const rows = [];
for (const href of ["/contacts", "/reports", "/bookings", "/leads", "/contacts", "/reports"]) rows.push({ to: href, ms: await go(href) });
console.log(`profile: ${phone ? "phone (CPU x4, slow 4G)" : "laptop"}`); console.table(rows);
await browser.close();
