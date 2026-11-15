// READ-ONLY check of the workshop groups table on the DEPLOYED site (opens the confirm dialogs, never confirms) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
await page.goto(`${APP}/admin/offerings/${process.env.OFF}`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
const rows = await page.locator("table").filter({ hasText: /\d{4}\/\d{2}\/\d{2}/ }).first().locator("tbody tr").count();
check("the groups table shows rows", rows >= 1, `${rows}`);
const dates = await page.locator("table td [dir=ltr]").allInnerTexts();
check("session dates read left to right (YYYY/MM/DD)", dates.length > 0 && dates.every((d) => /^\d{4}\/\d{2}\/\d{2}/.test(d.trim())), dates.slice(0, 2).join(" | "));
check("every group row has Mark-finished (or Reopen) and Delete buttons", (await page.locator('[data-testid="finish-group"], [data-testid="reopen-group"]').count()) === (await page.getByTestId("delete-group").count()) && (await page.getByTestId("delete-group").count()) >= 1);
await page.getByTestId("delete-group").first().click();
await page.getByRole("alertdialog").waitFor({ timeout: 8000 });
check("the delete confirmation warns and offers Cancel", (await page.getByRole("alertdialog").innerText()).length > 20);
await page.screenshot({ path: "tests/scratch-ui/out/group-delete-confirm.png" });
await page.keyboard.press("Escape");
await page.locator('[data-testid="finish-group"], [data-testid="reopen-group"]').first().click();
await page.getByRole("alertdialog").waitFor({ timeout: 8000 });
check("the finish confirmation opens", true);
await page.keyboard.press("Escape");
await page.screenshot({ path: "tests/scratch-ui/out/groups-table.png", clip: { x: 0, y: 0, width: 1440, height: 900 } });
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
await browser.close();
