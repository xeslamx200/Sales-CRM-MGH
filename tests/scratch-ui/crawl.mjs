// SCRATCH-ONLY page crawler: visits every page of the real app, as several roles, against the restored real-volume scratch database
// (never Staging). Records: HTTP status, the app's error screen, console / page errors, failed requests, slow pages, mobile horizontal overflow.
// Customer text, names, phones and e-mails are never printed: only page paths, counts and error codes.
//   APP=http://localhost:3299 IDS=<ids.txt> PERSONA=superadmin|sales_agent|sales_manager|cs_agent node tests/scratch-ui/crawl.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const APP = process.env.APP ?? "http://localhost:3299";
const ids = Object.fromEntries(readFileSync(process.env.IDS, "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("|")));
const persona = process.env.PERSONA ?? "superadmin";
const lang = process.env.LANG_UI ?? "ar";
const email = ids[persona];
if (!email) throw new Error(`no persona ${persona}`);
const SLOW_MS = Number(process.env.SLOW_MS ?? 4000);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: lang === "ar" ? "ar" : "en" });
const page = await ctx.newPage();
const events = [];
page.on("pageerror", (e) => events.push({ k: "pageerror", m: String(e.message).slice(0, 140) }));
page.on("console", (m) => { if (m.type() === "error") events.push({ k: "console", m: m.text().slice(0, 140) }); });
page.on("response", (r) => { const s = r.status(); if (s >= 400 && !/favicon|_next\/static|\.map$/.test(r.url())) events.push({ k: `http${s}`, m: new URL(r.url()).pathname.slice(0, 80) }); });

// sign in through the real form
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', "test-pass-123");
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
if (lang === "en") await page.request.fetch(`${APP}/`).catch(() => undefined);

const q = (k) => ids[k];
const paths = [
  "/", "/inbox", "/inbox?status=all", `/inbox?c=${q("conv_nahj")}`, `/inbox?c=${q("conv_mkt")}`, "/leads", "/leads/import", `/leads/${q("lead")}`,
  "/contacts", "/contacts/duplicates", `/contacts/${q("contact")}`, "/bookings", "/bookings?tab=approvals", "/bookings/new", `/bookings/${q("booking")}`,
  "/workshops", `/workshops/${q("workshop")}`, "/payments", "/payments/new", "/customer-payments", "/performance",
  "/tasks", "/tasks?view=team", "/reports", "/reports?tab=employees", "/reports?tab=whatsapp", "/reports?tab=shifts", "/reports?tab=targets", "/search?q=a", "/search?q=ahmed",
  "/profile", "/daily-report",
  "/admin/audit", "/admin/companies", `/admin/companies/${q("mgh")}/hours`, "/admin/offerings", `/admin/offerings/${q("offering")}`, "/admin/pipelines",
  "/admin/settings", "/admin/system", "/admin/teams", "/admin/users", "/admin/whatsapp",
].filter((p) => !p.includes("undefined") && !/\/(null|)$/.test(p.replace(/\?.*/, "")) || p === "/");

const companies = persona === "superadmin" ? [["mgh", q("mgh")], ["nahj", q("nahj")]] : [["own", null]];
const rows = [];
for (const [cname, cid] of companies) {
  if (cid) await ctx.addCookies([{ name: "crm_company", value: cid, url: APP }]);
  for (const p of paths) {
    events.length = 0;
    const t0 = Date.now();
    let status = 0, err = null;
    try {
      const r = await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 90000 });
      status = r?.status() ?? 0;
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    } catch (e) { err = String(e.message).split("\n")[0].slice(0, 100); }
    const ms = Date.now() - t0;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
    const errorScreen = /تعذّر تحميل البيانات|Couldn.t load|Something went wrong|حدث خطأ/.test(bodyText);
    const notFound = /404|لم يتم العثور|could not be found|not found/i.test(bodyText.slice(0, 300)) && status === 404;
    const url = new URL(page.url());
    rows.push({ company: cname, path: p, finalPath: url.pathname + url.search, status, ms, errorScreen, notFound, err, ev: [...new Set(events.map((e) => `${e.k}:${e.m}`))].slice(0, 5) });
  }
}
// mobile overflow of the main pages
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "ar" ? "ar" : "en", storageState: await ctx.storageState() });
const mp = await mob.newPage();
const overflow = [];
for (const p of ["/", "/inbox", "/leads", "/contacts", "/bookings", "/reports", "/tasks", "/performance", "/admin/whatsapp", "/admin/settings"]) {
  await mp.goto(`${APP}${p}`, { waitUntil: "load", timeout: 90000 }).catch(() => undefined);
  await mp.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
  const o = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).catch(() => 0);
  if (o > 2) overflow.push({ path: p, px: o });
}
await browser.close();

const bad = rows.filter((r) => r.status >= 400 || r.errorScreen || r.err || r.ev.length || r.ms > SLOW_MS);
const out = { persona, lang, pages: rows.length, problems: bad.length, mobileOverflow: overflow, rows };
writeFileSync(process.env.OUT ?? `crawl-${persona}-${lang}.json`, JSON.stringify(out, null, 1));
console.log(`persona=${persona} lang=${lang} pages=${rows.length} problems=${bad.length} mobileOverflow=${overflow.length}`);
for (const r of bad) console.log(`  [${r.company}] ${r.path} -> ${r.status} ${r.ms}ms${r.errorScreen ? " ERROR-SCREEN" : ""}${r.err ? " " + r.err : ""}${r.ev.length ? " | " + r.ev.join(" ; ") : ""}`);
for (const o of overflow) console.log(`  mobile overflow ${o.path}: ${o.px}px`);
