// READ-ONLY check of the searchable workshop picker on the DEPLOYED site (opens the list, types, never selects) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const CONV = process.env.CONV;
const page = await ctx.newPage();
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
for (const w of [1280, 320]) {
  await page.setViewportSize({ width: w, height: w === 320 ? 700 : 900 });
  await page.goto(`${APP}/inbox?c=${CONV}`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  if (w === 320) await page.locator("details > summary").first().click().catch(() => undefined);
  const box = page.locator('[id="inbox-offering"]:visible').first();
  check(`[${w}px] the workshop field is a searchable combobox`, (await box.count()) === 1);
  await box.click();
  const input = page.locator('[data-slot="command-input"]');
  await input.waitFor({ timeout: 8000 });
  const all = await page.locator('[data-slot="command-item"]').count();
  check(`[${w}px] the list opens with a search box and ${all} workshops`, all > 3);
  const first = (await page.locator('[data-slot="command-item"]').nth(2).innerText()).trim();
  const word = first.split(/\s+/).find((x) => x.length > 3) ?? first.slice(0, 4);
  await input.fill(word);
  const some = await page.locator('[data-slot="command-item"]').count();
  check(`[${w}px] typing "${word}" narrows the list`, some >= 1 && some < all, `${all} -> ${some}`);
  await input.fill("zzzzqq");
  check(`[${w}px] no match shows the empty message`, (await page.locator('[data-slot="command-empty"]').count()) === 1);
  const box2 = await page.locator('[data-slot="popover-content"]').boundingBox();
  check(`[${w}px] the list stays inside the screen`, !box2 || (box2.x >= -1 && box2.x + box2.width <= w + 1), box2 ? `${Math.round(box2.x)}..${Math.round(box2.x + box2.width)}` : "");
  if (w === 1280) { await input.fill(""); await page.screenshot({ path: "tests/scratch-ui/out/picker-1280.png" }); } else await page.screenshot({ path: "tests/scratch-ui/out/picker-320.png" });
  await page.keyboard.press("Escape");
}
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
await browser.close();
