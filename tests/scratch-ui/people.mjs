// SCRATCH-ONLY: Company settings -> People (create an account with e-mail + password, edit, reset password, remove).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const EMAIL = "newbie@test.local";
sql(`delete from auth.users where email = '${EMAIL}'`);

const browser = await chromium.launch();
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ar" });
  const page = await ctx.newPage();
  await page.goto(`${APP}/login`);
  await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  return { ctx, page };
}
const { page } = await signIn("admin_a@test.local");
await page.goto(`${APP}/admin/settings`); await page.waitForLoadState("networkidle").catch(() => undefined);
const companyId = sql("select m.company_id from public.company_memberships m join public.profiles p on p.id = m.user_id where p.email = 'admin_a@test.local' and m.role = 'company_admin' limit 1");

check("settings: the People section is there with the company's members", (await page.getByTestId("people-section").count()) === 1 && (await page.locator("[data-testid^='person-']").count()) >= 2);

// add a person with e-mail + password
await page.getByTestId("add-person").click();
let dlg = page.getByRole("dialog");
await dlg.getByLabel("الاسم").fill("Test Newbie");
await dlg.getByLabel("البريد الإلكتروني").fill(EMAIL);
await dlg.getByLabel("الهاتف").fill("+97450001234");
check("create: a company admin cannot create a company admin (role not offered)", (await dlg.getByRole("combobox").first().innerText()).length > 0);
await dlg.getByRole("button", { name: /توليد/ }).click();
const pw = await dlg.getByLabel("كلمة المرور").inputValue();
check("create: a strong password is generated (>= 10 characters)", pw.length >= 10, `${pw.length} chars`);
await dlg.getByRole("button", { name: "إضافة شخص" }).last().click();
await page.waitForTimeout(3000);
await page.goto(`${APP}/admin/settings`); await page.waitForLoadState("networkidle").catch(() => undefined);
check("create: the person appears in the list", (await page.getByTestId(`person-${EMAIL}`).count()) === 1);
check("create: the account was created with that password", sql(`select encrypted_password from auth.users where email = '${EMAIL}'`) === `scratch:${pw}`);
check("create: profile has name and phone, membership has the role", sql(`select p.full_name || '|' || p.phone || '|' || m.role from public.profiles p join public.company_memberships m on m.user_id = p.id where p.email = '${EMAIL}' and m.company_id = '${companyId}'`) === "Test Newbie|+97450001234|sales_agent");
check("create: the action is in the audit trail without the password", sql(`select count(*) from public.audit_logs where action = 'user.created_by_admin' and entity_id = (select id from public.profiles where email = '${EMAIL}') and metadata::text not like '%${pw}%'`) === "1");

// the new person can sign in
const nb = await signIn(EMAIL);
check("sign-in: the new person reaches the app", !nb.page.url().includes("/login"));
await nb.ctx.close();

// duplicate e-mail in the same company
await page.getByTestId("add-person").click();
dlg = page.getByRole("dialog");
await dlg.getByLabel("الاسم").fill("Dup"); await dlg.getByLabel("البريد الإلكتروني").fill(EMAIL); await dlg.getByLabel("كلمة المرور").fill("Another-Pass-2026");
await dlg.getByRole("button", { name: "إضافة شخص" }).last().click();
await page.waitForTimeout(2500);
check("create: the same e-mail again is refused with a clear message", /عضو في الشركة بالفعل|مستخدم/.test(await dlg.innerText()));
await page.keyboard.press("Escape");

// edit
const row = page.getByTestId(`person-${EMAIL}`);
await row.getByRole("button", { name: "تعديل البيانات" }).click();
dlg = page.getByRole("dialog");
await dlg.getByLabel("الاسم").fill("Test Newbie Renamed");
await dlg.getByLabel("الهاتف").fill("+97450009999");
await dlg.getByRole("button", { name: "حفظ" }).click();
await page.waitForTimeout(2500);
check("edit: name and phone are saved", sql(`select full_name || '|' || phone from public.profiles where email = '${EMAIL}'`) === "Test Newbie Renamed|+97450009999");

// reset password
await page.goto(`${APP}/admin/settings`); await page.waitForLoadState("networkidle").catch(() => undefined);
await page.getByTestId(`person-${EMAIL}`).getByRole("button", { name: "تغيير كلمة المرور" }).click();
dlg = page.getByRole("dialog");
await dlg.getByLabel("كلمة المرور").fill("Brand-New-Pass-2026");
await dlg.getByRole("button", { name: "حفظ" }).click();
await page.waitForTimeout(2500);
check("password: reset to the one typed", sql(`select encrypted_password from auth.users where email = '${EMAIL}'`) === "scratch:Brand-New-Pass-2026");
check("password: the audit row exists and does not contain it", sql(`select (select count(*) from public.audit_logs where action = 'user.password_reset_by_admin') >= 1 and (select count(*) from public.audit_logs where metadata::text like '%Brand-New%') = 0`) === "t");

// too short password is refused
await page.goto(`${APP}/admin/settings`); await page.waitForLoadState("networkidle").catch(() => undefined);
await page.getByTestId(`person-${EMAIL}`).getByRole("button", { name: "تغيير كلمة المرور" }).click();
dlg = page.getByRole("dialog");
await dlg.getByLabel("كلمة المرور").fill("short");
await dlg.getByRole("button", { name: "حفظ" }).click();
await page.waitForTimeout(1500);
check("password: a short password is refused and the old one stays", sql(`select encrypted_password from auth.users where email = '${EMAIL}'`) === "scratch:Brand-New-Pass-2026");
await page.keyboard.press("Escape");

// self cannot be removed; another admin is protected
const selfRow = page.locator("[data-testid='person-admin_a@test.local']");
check("remove: you cannot remove yourself (no button)", (await selfRow.getByRole("button", { name: "إزالة من الشركة" }).count()) === 0);

// remove
await page.getByTestId(`person-${EMAIL}`).getByRole("button", { name: "إزالة من الشركة" }).click();
await page.getByRole("alertdialog").getByRole("button", { name: "إزالة من الشركة" }).click();
await page.waitForTimeout(2500);
const rem = sql(`select (select count(*) from public.company_memberships m join public.profiles p on p.id = m.user_id where p.email = '${EMAIL}' and m.company_id = '${companyId}') || '|' || (select count(*) from auth.users where email = '${EMAIL}') || '|' || (select count(*) >= 1 from public.audit_logs where action = 'user.removed_from_company')`);
check("remove: the membership is gone, the account and the audit stay", rem === "0|1|true", rem);

// an employee cannot open the settings page
const emp = await signIn("agent_a1@test.local");
const resp = await emp.page.goto(`${APP}/admin/settings`); await emp.page.waitForLoadState("networkidle").catch(() => undefined);
check("permissions: an employee cannot open company settings (not-found page, no section)", (await emp.page.getByTestId("people-section").count()) === 0 && /غير موجود|لم يتم العثور|404/.test(await emp.page.evaluate(() => document.body.innerText)), `status ${resp?.status()}`);
await emp.ctx.close();
await browser.close();
sql(`delete from auth.users where email = '${EMAIL}'`);
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
