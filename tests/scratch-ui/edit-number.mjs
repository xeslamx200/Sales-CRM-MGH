// SCRATCH-ONLY: editing a WhatsApp number from the admin screen (rename + save) for a Meta number and a real Kapso number.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
sql("insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, waba_id, provider, environment, connection_mode, status, outbound_enabled) select id, 'Prod Kapso', '+97455500111', '777000111', '888000222', 'kapso', 'production', 'coexistence', 'active', true from public.companies where slug = 'alpha' on conflict do nothing");
sql("update public.whatsapp_accounts set phone_number_id = '10000000000001' where display_name like 'Alpha Sales%'");   // the fixture id is not numeric; a real Meta id is
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ar" });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errs.push("pageerror " + e.message.slice(0, 160)));
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', "super@test.local"); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
await page.goto(`${APP}/admin/whatsapp`); await page.waitForLoadState("networkidle").catch(() => undefined);

async function rename(oldName, newName) {
  const card = page.locator("section", { hasText: oldName }).first();
  await card.getByRole("button", { name: /تعديل|Edit/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("الاسم").fill(newName);
  await dlg.getByRole("button", { name: /حفظ/ }).click();
  await page.waitForTimeout(2500);
  const err = await dlg.isVisible().catch(() => false) ? (await dlg.innerText()).slice(0, 300) : "";
  return err;
}
let err = await rename("Alpha Sales", "Alpha Sales 2");
check("Meta number: rename and save", sql("select count(*) from public.whatsapp_accounts where display_name = 'Alpha Sales 2'") === "1", err ? "dialog still open: " + err.replace(/\s+/g, " ") : "");
await page.goto(`${APP}/admin/whatsapp`); await page.waitForLoadState("networkidle").catch(() => undefined);
err = await rename("Prod Kapso", "Prod Kapso 2");
check("real Kapso number: rename and save", sql("select count(*) from public.whatsapp_accounts where display_name = 'Prod Kapso 2'") === "1", err ? "dialog still open: " + err.replace(/\s+/g, " ") : "");
console.log("console errors:", [...new Set(errs)].slice(0, 5));
await browser.close();
console.log(results.every(Boolean) ? "ALL PASS" : "FAILURES");
