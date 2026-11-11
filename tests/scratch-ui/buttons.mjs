// SCRATCH-ONLY button audit: on every page, press every enabled button and record whether anything happened
// (a dialog or menu opened, a request was sent, the URL changed, or the page changed). A button with no effect at all is reported for review.
// Runs against the disposable e2e database only (buttons such as "mark as read" or "save" do change its data).
//   APP=http://localhost:3299 USER_EMAIL=admin_a@test.local node tests/scratch-ui/buttons.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const APP = process.env.APP ?? "http://localhost:3299";
const email = process.env.USER_EMAIL ?? "admin_a@test.local";
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/leads/import,/contacts,/contacts/duplicates,/bookings,/bookings/new,/workshops,/payments,/payments/new,/customer-payments,/performance,/tasks,/reports,/reports?tab=comparison,/reports?tab=employees,/reports?tab=whatsapp,/reports?tab=shifts,/reports?tab=targets,/search?q=a,/profile,/admin/audit,/admin/companies,/admin/offerings,/admin/pipelines,/admin/settings,/admin/system,/admin/teams,/admin/users,/admin/whatsapp").split(",");
const SKIP = /تسجيل الخروج|sign out|log out|logout/i;   // tested on its own at the end

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar" });
const page = await ctx.newPage();
let requests = 0; let pageErrors = [];
page.on("request", (r) => { if (!/_next\/static|\.(png|svg|ico|woff2?)$|hot-update|webpack|\/__nextjs/.test(r.url())) requests++; });
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 100)));
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });

const labelOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("data-testid") || "").replace(/\s+/g, " ").trim().slice(0, 50) || "(no label)";
const rows = [];
let total = 0, dead = [];

for (const p of PAGES) {
  await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 90000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  const n = await page.evaluate(() => {
    const els = [...document.querySelectorAll("main button, header button")].filter((b) => !b.disabled && b.offsetParent !== null && !b.closest("[data-sonner-toaster]"));
    return els.length;
  });
  for (let i = 0; i < Math.min(n, 40); i++) {
    // a fresh start for every button: same page, nothing open
    if (i > 0 && !page.url().endsWith(p)) { await page.goto(`${APP}${p}`, { waitUntil: "load" }).catch(() => undefined); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined); }
    const handle = (await page.locator("main button, header button").elementHandles())
      .filter(Boolean);
    let target = null, label = "", idx = -1;
    for (const h of handle) {
      const ok = await h.evaluate((b) => !b.disabled && b.offsetParent !== null && !b.closest("[data-sonner-toaster]"));
      if (!ok) continue;
      idx++;
      if (idx === i) { target = h; label = await h.evaluate(labelOf); break; }
    }
    if (!target) break;
    if (SKIP.test(label)) continue;
    total++;
    const before = { url: page.url(), req: requests, html: await page.evaluate(() => document.body.innerHTML.length), dialogs: await page.locator("[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]").count() };
    let changed = false, note = "";
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 3000 });
      await target.click({ timeout: 4000 });
      await page.waitForTimeout(900);
      const after = { url: page.url(), req: requests, html: await page.evaluate(() => document.body.innerHTML.length), dialogs: await page.locator("[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]").count() };
      changed = after.url !== before.url || after.req > before.req || after.dialogs !== before.dialogs || after.html !== before.html;
      const toast = await page.locator("[data-sonner-toast]").count();
      if (toast) changed = true;
    } catch (e) { note = "click failed: " + String(e.message).split("\n")[0].slice(0, 80); }
    if (!changed && !note) dead.push(`${p} :: ${label}`);
    rows.push({ page: p, label, changed, note });
    // close whatever opened
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

// sign out works
await page.goto(`${APP}/`, { waitUntil: "load" });
const out = page.getByRole("button", { name: /تسجيل الخروج|Sign out/i }).first();
let signOut = "not found";
if (await out.count()) { await out.click().catch(() => undefined); await page.waitForTimeout(1500); signOut = page.url().includes("/login") ? "ok" : "no redirect"; }
else {
  const menu = page.locator("header button").last(); await menu.click().catch(() => undefined);
  const item = page.getByRole("menuitem", { name: /تسجيل الخروج|Sign out/i }).first();
  if (await item.count()) { await item.click().catch(() => undefined); await page.waitForTimeout(1500); signOut = page.url().includes("/login") ? "ok" : "no redirect"; }
}
await browser.close();
const bad = rows.filter((r) => r.note);
writeFileSync(process.env.OUT ?? "buttons-result.json", JSON.stringify({ email, pages: PAGES.length, buttons: total, noEffect: dead, clickFailures: bad, signOut, pageErrors: [...new Set(pageErrors)] }, null, 1));
console.log(`user=${email} pages=${PAGES.length} buttons pressed=${total} no-effect=${dead.length} click-failures=${bad.length} sign-out=${signOut} page-errors=${new Set(pageErrors).size}`);
for (const d of dead) console.log("  NO EFFECT: " + d);
for (const b of bad) console.log(`  CLICK FAILED: ${b.page} :: ${b.label} (${b.note})`);
for (const e of new Set(pageErrors)) console.log("  PAGE ERROR: " + e);
