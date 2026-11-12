// SCRATCH-ONLY responsive audit: every page at several screen widths, in Arabic (RTL) and English. Reports page-level horizontal scroll,
// elements sticking out of the screen (outside a scroll container), and saves screenshots for review.
//   APP=http://localhost:3299 OUTDIR=<dir> node tests/scratch-ui/responsive.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" });
const APP = process.env.APP ?? "http://localhost:3299";
const OUT = process.env.OUTDIR ?? "tests/scratch-ui/out/responsive";
mkdirSync(OUT, { recursive: true });
const WIDTHS = (process.env.WIDTHS ?? "360,390,768,1024,1280,1920").split(",").map(Number);
const LANGS = (process.env.LANGS ?? "ar,en").split(",");
const SHOTS = new Set((process.env.SHOT_WIDTHS ?? "360,768,1024").split(",").map(Number));
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/contacts,/bookings,/bookings/new,/workshops,/payments,/customer-payments,/performance,/tasks,/reports,/reports?tab=comparison,/reports?tab=employees,/reports?tab=whatsapp,/reports?tab=shifts,/reports?tab=targets,/search?q=a,/profile,/admin/settings,/admin/whatsapp,/admin/users,/admin/teams,/admin/offerings,/admin/pipelines,/admin/audit,/admin/companies,/admin/system,/leads/import").split(",");

const EMAIL = process.env.USER_EMAIL ?? "admin_a@test.local";
const browser = await chromium.launch();
// sign in once (the sign-in rate limit would refuse a dozen sign-ins in a row) and reuse the session everywhere
const login = await browser.newContext();
const lp = await login.newPage();
await lp.goto(`${APP}/login`);
await lp.fill('input[type="email"]', EMAIL); await lp.fill('input[type="password"]', "test-pass-123"); await lp.click('button[type="submit"]');
await lp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
const state = await login.storageState();
await login.close();
const findings = [];
for (const lang of LANGS) {
  sql(`update public.profiles set locale = '${lang}' where email = '${EMAIL}'`);   // the interface language comes from the profile
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 768 ? 844 : 900 }, locale: lang, isMobile: w < 768, hasTouch: w < 1024, storageState: state });
    await ctx.addCookies([{ name: "crm_locale", value: lang, url: APP }]);   // the language of every page comes from this cookie
    const page = await ctx.newPage();
    for (const p of PAGES) {
      await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 90000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const pageScroll = document.documentElement.scrollWidth - vw;
        // inside an element that scrolls horizontally on purpose (tables, tab strips), sticking out is fine
        const inScroller = (el) => { for (let e = el.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if ((s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden" || s.overflow === "hidden" || s.overflow === "clip") && e !== document.body && e !== document.documentElement) return true; } return false; };
        const out = [];
        for (const el of document.querySelectorAll("body *")) {
          const st = getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;
          const rc = el.getBoundingClientRect();
          if (rc.width === 0 || rc.height === 0) continue;
          if ((rc.right > vw + 1 || rc.left < -1) && !inScroller(el)) {
            const name = el.tagName.toLowerCase() + (el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 3).join(".") : "");
            out.push(`${name} [${Math.round(rc.left)}..${Math.round(rc.right)}]`);
          }
        }
        // text cut off: elements whose content is wider than the box and that do not scroll or wrap on purpose
        return { pageScroll, out: out.slice(0, 6), count: out.length };
      });
      if (r.pageScroll > 1 || r.count > 0) findings.push({ lang, width: w, page: p, pageScroll: r.pageScroll, sticking: r.count, sample: r.out });
      if (SHOTS.has(w)) await page.screenshot({ path: `${OUT}/${lang}-${w}-${p.replace(/[/?=&]+/g, "_") || "home"}.png`, fullPage: true }).catch(() => undefined);
    }
    await ctx.close();
  }
}
sql(`update public.profiles set locale = 'ar' where email = '${EMAIL}'`);
await browser.close();
writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 1));
console.log(`checked ${PAGES.length} pages x ${WIDTHS.length} widths x ${LANGS.length} languages; problems: ${findings.length}`);
for (const f of findings) console.log(`  [${f.lang} ${f.width}] ${f.page}: page scroll ${f.pageScroll}px, ${f.sticking} element(s) out of the screen  ${f.sample.slice(0, 2).join(" | ")}`);
