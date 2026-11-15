// READ-ONLY check of the session-days calendar in the group dialog on the DEPLOYED site (picks days, never saves) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
for (const [label, vp, locale] of [["laptop", { width: 1440, height: 900 }, "ar"], ["phone 390", { width: 390, height: 800 }, "ar"], ["laptop english", { width: 1440, height: 900 }, "en"]]) {
  await ctx.addCookies([{ name: "crm_locale", value: locale, domain: new URL(APP).hostname, path: "/", secure: true }]);
  const page = await ctx.newPage();
  await page.setViewportSize(vp);
  await page.goto(`${APP}/admin/offerings/${process.env.OFF}`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.getByTestId("edit-group").first().click().catch(async () => { await page.locator('table button[aria-label]').filter({ has: page.locator("svg.lucide-pencil") }).last().click(); });
  const cal = page.getByTestId("days-calendar"); await cal.waitFor({ timeout: 8000 });
  check(`[${label}] the dialog has a calendar (no text box for dates)`, (await cal.count()) === 1 && (await page.locator('textarea[name="sessions"]').count()) === 0);
  const before = await page.locator('[data-testid="chosen-days"] span').count();
  check(`[${label}] the saved day is shown as a chosen day`, before >= 1, `${before}`);
  const days = cal.locator("button[data-day]");
  const n = await days.count();
  check(`[${label}] the month grid has ${n} day buttons`, n >= 28 && n <= 31);
  // pick the 15th and 20th of the shown month, then remove one
  const d15 = cal.locator('button[data-day$="-15"]'), d20 = cal.locator('button[data-day$="-20"]');
  const was15 = (await d15.getAttribute("aria-pressed")) === "true";
  await d15.click(); await d20.click();
  const afterAdd = await page.locator('[data-testid="chosen-days"] span').count();
  check(`[${label}] clicking days adds / removes chips`, afterAdd !== before);
  await d15.click(); await d20.click();
  const back = await page.locator('[data-testid="chosen-days"] span').count();
  check(`[${label}] clicking again returns to the start`, back === before && (await d15.getAttribute("aria-pressed")) === String(was15));
  const box = await cal.boundingBox();
  check(`[${label}] the calendar fits the screen`, box !== null && box.x >= 0 && box.x + box.width <= vp.width + 1, box ? `${Math.round(box.x)}..${Math.round(box.x + box.width)}` : "");
  await page.screenshot({ path: `tests/scratch-ui/out/calendar-${label.replace(/ /g, "-")}.png` });
  await page.close();   // closing the page discards the dialog: nothing is saved
}
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
await browser.close();
