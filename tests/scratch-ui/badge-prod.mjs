// READ-ONLY check of the sidebar unread badge position on the DEPLOYED site as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
for (const [loc, w] of [["ar", 1280], ["en", 1280]]) {
  await ctx.addCookies([{ name: "crm_locale", value: loc, domain: new URL(APP).hostname, path: "/", secure: true }]);
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`${APP}/workshops`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  const r = await page.evaluate(() => {
    // the real badge only exists while there are unread chats: if there is none, add one built like the component (end-1, same classes), old and new markup
    const li = document.querySelector('a[href="/inbox"]').closest("li");
    const make = (inner, cls) => { const d = document.createElement("div"); d.setAttribute("data-sidebar", "menu-badge"); d.className = "pointer-events-none absolute end-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium " + cls; d.innerHTML = inner; li.appendChild(d); return d; };
    const real = li.querySelector('[data-sidebar="menu-badge"]');
    const oldB = make("17", "ltr-nums"), newB = real ?? make('<span class="ltr-nums">17</span>', "");
    const row = li.getBoundingClientRect(), icon = li.querySelector("svg").getBoundingClientRect();
    const side = (el) => { const b = el.getBoundingClientRect(); return { side: b.left - row.left < row.right - b.right ? "left" : "right", overlapsIcon: !(b.right < icon.left || b.left > icon.right) }; };
    const out = { dir: document.documentElement.dir, iconSide: icon.left - row.left < row.right - icon.right ? "left" : "right", old: side(oldB), now: side(newB), real: Boolean(real) };
    oldB.remove(); if (!real) newB.remove();
    return out;
  });
  console.log(loc, JSON.stringify(r));
}
await browser.close();
