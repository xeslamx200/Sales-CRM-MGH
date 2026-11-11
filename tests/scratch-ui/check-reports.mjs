// SCRATCH-ONLY: the Reports -> Comparison tab renders, with tables, for a company admin and an employee (scoped).
import { chromium } from "playwright";
const APP = process.env.APP ?? "http://localhost:3299";
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const browser = await chromium.launch();
for (const [who, label] of [["admin_a@test.local", "company admin"], ["agent_a1@test.local", "employee"], ["super@test.local", "super admin"]]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ar" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  await page.goto(`${APP}/login`); await page.fill('input[type="email"]', who); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  for (const q of ["", "&period=30d", "&period=year"]) {
    await page.goto(`${APP}/reports?tab=comparison${q}`); await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
    const body = await page.evaluate(() => document.body.innerText);
    const ok = (await page.getByTestId("comparison").count()) === 1 && !/تعذّر تحميل البيانات/.test(body);
    check(`comparison [${label}] ${q || "this month"}: renders without error`, ok && errs.length === 0, `tables=${await page.locator("[data-testid=comparison] table").count()}`);
  }
  if (label === "company admin") await page.screenshot({ path: process.env.OUTDIR + "/comparison.png", fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
