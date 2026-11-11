// SCRATCH-ONLY performance probe: how long each page takes and how many database round trips it makes, ONE AFTER ANOTHER (waves), with
// the gateway delaying every request by DELAY_MS to imitate the distance to the real Supabase. Each page is opened twice; the second
// (warm) visit is measured, so compilation in dev mode does not count.
//   gateway: DELAY_MS=200 TRACE=<file> ...   then:   APP=http://localhost:3299 TRACE=<file> DELAY_MS=200 node tests/scratch-ui/perf.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
const APP = process.env.APP ?? "http://localhost:3299";
const TRACE = process.env.TRACE;
const DELAY = Number(process.env.DELAY_MS ?? 200);
const PAGES = (process.env.PAGES ?? "/,/inbox,/leads,/contacts,/bookings,/workshops,/payments,/customer-payments,/performance,/tasks,/reports,/reports?tab=comparison,/admin/settings,/admin/whatsapp").split(",");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', process.env.USER_EMAIL ?? "admin_a@test.local"); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
const rows = [];
for (const p of PAGES) {
  await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
  writeFileSync(TRACE, "");
  const t0 = Date.now();
  const r = await page.goto(`${APP}${p}`, { waitUntil: "load", timeout: 120000 });
  const ms = Date.now() - t0;
  await page.waitForTimeout(300);
  const starts = readFileSync(TRACE, "utf8").trim().split("\n").filter(Boolean).map((l) => Number(l.split(" ")[0])).sort((a, b) => a - b);
  // a new wave starts when a request begins at least half a round trip after the start of the current wave
  let waves = 0, waveStart = -Infinity;
  for (const s of starts) if (s - waveStart >= DELAY / 2) { waves++; waveStart = s; }
  rows.push({ page: p, status: r?.status(), ms, requests: starts.length, waves });
  console.log(`${p.padEnd(26)} ${String(ms).padStart(6)} ms   requests=${String(starts.length).padStart(3)}   sequential waves=${waves}`);
}
await browser.close();
writeFileSync(process.env.OUT ?? "perf.json", JSON.stringify(rows, null, 1));
