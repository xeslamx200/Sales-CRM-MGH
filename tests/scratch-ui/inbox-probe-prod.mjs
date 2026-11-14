// READ-ONLY probe of the inbox on the DEPLOYED site: every number, list + open conversation, repeated; records failures and slow loads as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const hdr = { apikey: SERVICE, authorization: `Bearer ${SERVICE}` };
const rest = async (p) => (await fetch(`${URL_}/rest/v1/${p}`, { headers: hdr })).json();
const accounts = await rest("whatsapp_accounts?select=id,display_name&order=display_name");
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const rows = [];
const N = Number(process.env.N ?? 4);
for (const a of [{ id: "", display_name: "(all numbers)" }, ...accounts]) {
  const convs = a.id ? await rest(`conversations?select=id&whatsapp_account_id=eq.${a.id}&order=last_message_at.desc&limit=3`) : await rest("conversations?select=id&order=last_message_at.desc&limit=3");
  const targets = [`/inbox${a.id ? `?number=${a.id}` : ""}`, ...convs.map((c) => `/inbox?${a.id ? `number=${a.id}&` : ""}c=${c.id}`)];
  for (const t of targets) {
    const times = []; let fails = 0, lastErr = "";
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      try {
        const r = await page.goto(`${APP}${t}`, { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
        const bad = r?.status() !== 200 || (await page.locator("main button", { hasText: /إعادة المحاولة|Try again|Retry/ }).count()) > 0 || (await page.locator("text=/حدث خطأ|Something went wrong/").count()) > 0;
        if (bad) { fails++; lastErr = `status ${r?.status()}`; }
      } catch (e) { fails++; lastErr = String(e).slice(0, 80); }
      times.push(Date.now() - t0);
    }
    rows.push({ number: a.display_name, page: t.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/number=<id>&?/, ""), loads: times.join(" "), max_ms: Math.max(...times), failures: fails, last_error: lastErr });
  }
}
console.table(rows);
await browser.close();
