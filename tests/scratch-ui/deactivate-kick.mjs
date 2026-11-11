// SCRATCH-ONLY: a person whose account is closed while signed in loses access on the very next page load (sessions are checked locally,
// but the account state is read from the database on every request).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
const b = await chromium.launch(); const page = await (await b.newContext()).newPage();
await page.goto(`${APP}/login`); await page.fill('input[type="email"]', "agent_a2@test.local"); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const before = page.url();
sql("update public.profiles set is_active = false where email = 'agent_a2@test.local'");
await page.goto(`${APP}/leads`); await page.waitForLoadState("networkidle").catch(() => undefined);
const after = page.url();
const pulse = await page.evaluate(async () => (await fetch("/api/inbox/pulse")).status);
sql("update public.profiles set is_active = true where email = 'agent_a2@test.local'");
await b.close();
const ok = !before.includes("/login") && after.includes("/login");
console.log(`${ok ? "PASS" : "FAIL"}  closed account is sent to the sign-in page on the next request (${after.replace(APP, "")}); pulse after: ${pulse}`);
