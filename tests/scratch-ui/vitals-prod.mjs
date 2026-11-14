// READ-ONLY web-vitals probe of the DEPLOYED site: laptop and a throttled phone (CPU x4, slow 4G), first visit (cold cache) and second visit (warm cache) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const profile = process.env.PROFILE ?? "laptop";
await ctx.addCookies(cookies.map((c) => ({ ...c, domain: host, path: "/", secure: true, sameSite: "Lax" })));
await ctx.addCookies([{ name: "crm_locale", value: process.env.LOCALE ?? "en", domain: host, path: "/", secure: true }]);
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/contacts,/reports,/bookings").split(",");
const PHONE = profile === "phone";
const context = PHONE ? await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) : ctx;
if (PHONE) await context.addCookies([...(await ctx.cookies())]);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
if (PHONE) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
}
const rows = [];
for (const p of PAGES) {
  for (const visit of ["cold", "warm"]) {
    if (visit === "cold") await cdp.send("Network.clearBrowserCache").catch(() => undefined);
    await page.addInitScript(() => {
      window.__v = { lcp: 0, cls: 0, tbt: 0 };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__v.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__v.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__v.tbt += Math.max(0, e.duration - 50); }).observe({ type: "longtask", buffered: true });
    });
    let bytes = 0; const onResp = (r) => { const l = r.headers()["content-length"]; if (l) bytes += Number(l); };
    page.on("response", onResp);
    const t0 = Date.now();
    await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0]; const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      const js = performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name));
      return { ttfb: Math.round(nav.responseStart), fcp: Math.round(fcp?.startTime ?? 0), lcp: Math.round(window.__v.lcp), cls: +window.__v.cls.toFixed(3), tbt: Math.round(window.__v.tbt), load: Math.round(nav.loadEventEnd), jsKB: Math.round(js.reduce((s, r) => s + (r.encodedBodySize || 0), 0) / 1024), jsFiles: js.length };
    });
    page.off("response", onResp);
    rows.push({ page: p, visit, ...m });
  }
}
console.log(`profile: ${profile}`);
console.table(rows);
await browser.close();
