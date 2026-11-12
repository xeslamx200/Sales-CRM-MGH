// READ-ONLY layout audit (horizontal overflow at phone widths) of the DEPLOYED site as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const W = (process.env.WIDTHS ?? "320,360,390,768").split(",").map(Number);
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/contacts,/bookings,/workshops,/payments,/performance,/tasks,/reports,/search?q=a,/profile,/admin/settings,/admin/whatsapp,/admin/users,/admin/teams,/admin/offerings,/admin/audit,/admin/system,/bookings/new").split(",");
const CONV = process.env.CONV ? `/inbox?c=${process.env.CONV}` : null;
if (CONV) PAGES.push(CONV);
const page = await ctx.newPage();
const out = [];
for (const w of W) {
  await page.setViewportSize({ width: w, height: 800 });
  for (const p of PAGES) {
    await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 120000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const over = [];
      for (const el of document.querySelectorAll("body *")) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > vw + 1 || b.left < -1) {
          // ignore things inside an element that scrolls on its own
          let p = el.parentElement, scrolls = false;
          while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { scrolls = true; break; } p = p.parentElement; }
          if (!scrolls && getComputedStyle(el).position !== "fixed") over.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 3).join(".") : ""} ${Math.round(b.left)}..${Math.round(b.right)}`);
        }
      }
      return { vw, sw: document.documentElement.scrollWidth, over: over.slice(0, 4) };
    });
    if (r.sw > r.vw || r.over.length) out.push({ w, page: p, scrollWidth: r.sw, viewport: r.vw, offenders: r.over.join(" | ") });
  }
}
console.log(out.length ? out : "no overflow found");
await browser.close();
