// READ-ONLY check of the Roles section on the DEPLOYED site (opens the add-role dialog, never saves) as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
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
await page.setViewportSize({ width: 1440, height: 1000 });
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
for (const p of ["/", "/inbox", "/leads", "/reports", "/bookings", "/workshops", "/performance", "/tasks", "/contacts"]) {
  const r = await page.goto(`${APP}${p}`, { waitUntil: "load" });
  check(`page ${p} still opens for the company admin`, r?.status() === 200 && (await page.locator("main").count()) > 0, `${r?.status()}`);
}
await page.goto(`${APP}/admin/settings`, { waitUntil: "load" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
check("the Roles section is on the company settings page", (await page.getByTestId("roles-section").count()) === 1);
await page.getByTestId("add-role").click();
await page.getByTestId("role-form").waitFor({ timeout: 8000 });
check("the add-role dialog shows name, base role, 8 pages and 6 actions", (await page.locator('[data-testid^="page-"]').count()) === 8 && (await page.locator('[data-testid^="perm-"]').count()) === 6);
check("save is disabled until a name is typed", await page.getByTestId("role-save").isDisabled());
await page.getByTestId("role-name").fill("x");
check("and enabled after", !(await page.getByTestId("role-save").isDisabled()));
await page.screenshot({ path: "tests/scratch-ui/out/roles-dialog.png" });
await page.keyboard.press("Escape");
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
await browser.close();
