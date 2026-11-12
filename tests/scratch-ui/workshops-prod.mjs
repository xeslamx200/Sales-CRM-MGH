// READ-ONLY check of the Workshops page (search, filters, views, arrange mode without saving) on the DEPLOYED site as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
for (const w of [1280, 320]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`${APP}/workshops`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  const cards = () => page.locator('a[href^="/workshops/"]').count();
  const total = await cards();
  check(`[${w}] the page lists the workshops`, total > 5, `${total}`);
  check(`[${w}] the counter shows all`, /\d+/.test(await page.locator("p[aria-live=polite]").innerText()));
  await page.getByTestId("wk-search").fill("private");
  const one = await cards();
  check(`[${w}] searching narrows the list`, one >= 1 && one < total, `${total} -> ${one}`);
  await page.getByTestId("wk-search").fill("zzzzqq");
  check(`[${w}] no match message`, (await cards()) === 0);
  await page.getByTestId("wk-search").fill("");
  for (const label of (process.env.LOCALE === "ar" ? ["قائمة", "مضغوط", "بطاقات"] : ["List", "Compact", "Cards"])) {
    await page.getByRole("button", { name: label, exact: true }).click();
    check(`[${w}] view "${label}" shows every workshop`, (await cards()) === total);
    const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    check(`[${w}] view "${label}" has no horizontal overflow`, !over);
  }
  const arrange = page.getByTestId("wk-arrange");
  check(`[${w}] the arrange button is there for the company admin`, (await arrange.count()) === 1);
  await arrange.click();
  const rows = await page.locator("[data-testid=wk-order-list] > li").count();
  check(`[${w}] arrange mode lists all ${rows} workshops with move buttons`, rows === total && (await page.locator("[data-testid=wk-order-list] > li button").count()) === rows * 3);
  const first = (await page.locator("[data-testid=wk-order-list] > li").nth(0).locator("span").nth(1).innerText()).trim();
  await page.locator("[data-testid=wk-order-list] > li").nth(1).locator("button").nth(0).click();   // move the 2nd to the top (not saved)
  check(`[${w}] "move to top" reorders on screen`, (await page.locator("[data-testid=wk-order-list] > li").nth(1).locator("span").nth(1).innerText()).trim() === first);
  if (w === 1280) await page.screenshot({ path: "tests/scratch-ui/out/workshops-arrange.png" });
  await page.reload({ waitUntil: "load" });   // leaving without saving keeps the saved order
}
await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(`${APP}/workshops`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
await page.screenshot({ path: "tests/scratch-ui/out/workshops.png" });
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
await browser.close();
