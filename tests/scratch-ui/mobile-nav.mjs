// SCRATCH-ONLY: on phones and tablets the menu is a slide-over: it opens from the header button, a link navigates and closes it;
// on a laptop it is a fixed sidebar. Also: on a phone the filters fold behind one button.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", "delete from app.rate_limits"]);
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const b = await chromium.launch();
const login = await (await b.newContext()).newPage();
await login.goto(`${APP}/login`); await login.fill('input[type="email"]', "admin_a@test.local"); await login.fill('input[type="password"]', "test-pass-123"); await login.click('button[type="submit"]');
await login.waitForURL((u) => !u.pathname.startsWith("/login"));
const state = await login.context().storageState();
for (const [w, kind] of [[390, "phone"], [820, "tablet"], [1280, "laptop"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, storageState: state });
  await ctx.addCookies([{ name: "crm_locale", value: "ar", url: APP }]);
  const page = await ctx.newPage();
  await page.goto(`${APP}/`); await page.waitForLoadState("networkidle").catch(() => undefined);
  const leadsLink = page.locator("a[href='/leads']").filter({ visible: true });
  if (kind === "laptop") { check(`${kind}: the sidebar is always visible`, (await leadsLink.count()) > 0); await ctx.close(); continue; }
  check(`${kind}: the menu is closed at first (content uses the full width)`, (await leadsLink.count()) === 0);
  await page.locator("header button").first().click(); await page.waitForTimeout(500);
  const menu = page.locator("[data-sidebar='sidebar'][data-mobile='true']");
  check(`${kind}: the header button opens the menu`, (await menu.locator("a[href='/leads']").count()) > 0);
  await menu.locator("a[href='/leads']").first().click();
  await page.waitForURL((u) => u.pathname === "/leads", { timeout: 20000 }).catch(() => undefined); await page.waitForTimeout(600);
  check(`${kind}: a menu link opens the page and closes the menu`, page.url().endsWith("/leads") && (await page.locator("[data-sidebar='sidebar'][data-mobile='true']").count()) === 0);
  if (kind === "phone") {
    // inbox: one pane at a time (needs a conversation the user can see; live-inbox.mjs creates some)
    const cv = execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", "select id from public.conversations order by last_message_at desc limit 1"], { encoding: "utf8" }).trim();
    if (cv) {
      await page.goto(`${APP}/inbox`); await page.waitForLoadState("networkidle").catch(() => undefined);
      const listShown = await page.locator("aside").filter({ visible: true }).count();
      await page.goto(`${APP}/inbox?c=${cv}`); await page.waitForLoadState("networkidle").catch(() => undefined);
      const listHidden = (await page.locator("aside").filter({ visible: true }).count()) === 0;
      // the conversation starts right under the header (not below a long list)
      const top = await page.evaluate(() => { const b = document.querySelector("[data-testid='back-to-list']"); return b ? Math.round(b.getBoundingClientRect().top + window.scrollY) : -1; });
      check("phone inbox: the list alone, then the open conversation alone, right at the top", listShown > 0 && listHidden && top > 0 && top < 400, `conversation starts at ${top}px`);
      await page.getByTestId("back-to-list").click(); await page.waitForURL((u) => !u.search.includes("c="), { timeout: 15000 }).catch(() => undefined);
      check("phone inbox: the back link returns to the list", (await page.locator("aside").filter({ visible: true }).count()) > 0);
      await page.goto(`${APP}/leads`); await page.waitForLoadState("networkidle").catch(() => undefined);
    }
    const statusFilter = page.getByRole("combobox").filter({ visible: true });
    const before = await statusFilter.count();
    await page.getByTestId("filters-toggle").click(); await page.waitForTimeout(300);
    const after = await page.getByRole("combobox").filter({ visible: true }).count();
    check("phone: filters are folded, one button shows them", before === 0 && after >= 4, `${before} -> ${after}`);
  }
  await ctx.close();
}
await b.close();
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
