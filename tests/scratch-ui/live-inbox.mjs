// SCRATCH-ONLY: the inbox is live - a message that arrives while the page is open shows up without a refresh.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };

// fixture: a number the agent may use, and one open conversation with one message
const acc = sql("select w.id from public.whatsapp_accounts w join public.companies c on c.id = w.default_company_id where c.slug = 'alpha' order by w.created_at limit 1");
const co = sql("select id from public.companies where slug = 'alpha'");
const agent = sql("select id from public.profiles where email = 'agent_a1@test.local'");
sql(`insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply) values ('${acc}', '${agent}', true) on conflict do nothing`);
function newConversation(name, wa) {
  const ct = sql(`insert into public.contacts (full_name) values ('${name}') returning id`).split("\n")[0];
  sql("alter table public.conversations disable trigger user");
  const cv = sql(`insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id, last_message_at, last_inbound_at) values ('${acc}', '${co}', '${ct}', '${wa}', '${agent}', now() - interval '1 hour', now() - interval '1 hour') returning id`).split("\n")[0];
  sql("alter table public.conversations enable trigger user");
  return cv;
}
// a customer message arriving: the stored message + what the real ingest function does to the conversation (time and unread counter)
function receive(cv, text) {
  sql("alter table public.messages disable trigger user; alter table public.conversations disable trigger user");
  sql(`insert into public.messages (conversation_id, direction, message_type, body, status, sent_at, is_simulated) values ('${cv}', 'inbound', 'text', '${text}', 'received', now(), false)`);
  sql(`update public.conversations set last_message_at = now(), last_inbound_at = now(), unread_count = unread_count + 1 where id = '${cv}'`);
  sql("alter table public.messages enable trigger user; alter table public.conversations enable trigger user");
}
const stamp = Date.now();
const cvOpen = newConversation("Live Open " + stamp, "97100" + String(stamp).slice(-6));
receive(cvOpen, "first message " + stamp);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ar" });
const page = await ctx.newPage();
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', "agent_a1@test.local"); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
let navigations = 0; page.on("framenavigated", () => navigations++);

// 1. the conversation is open: a new message appears in it
await page.goto(`${APP}/inbox?c=${cvOpen}`); await page.waitForLoadState("networkidle").catch(() => undefined);
check("the live badge is shown", (await page.getByTestId("inbox-live").count()) === 1);
const navBefore = navigations;
const t0 = Date.now();
receive(cvOpen, "LIVE-IN-THREAD-" + stamp);
let seen = false;
while (Date.now() - t0 < 20000) { if ((await page.locator("body").innerText()).includes("LIVE-IN-THREAD-" + stamp)) { seen = true; break; } await page.waitForTimeout(300); }
check("open conversation: the new message appears without refreshing", seen, seen ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "never appeared");
check("it was not a full page reload", navigations - navBefore <= 1);

// 2. only the list is open: a new conversation appears at the top
await page.goto(`${APP}/inbox`); await page.waitForLoadState("networkidle").catch(() => undefined);
await page.waitForTimeout(3500);   // one pulse to learn the starting point
const cvNew = newConversation("Live Newcomer " + stamp, "97200" + String(stamp).slice(-6));
const t1 = Date.now();
receive(cvNew, "hello from a new customer " + stamp);
seen = false;
while (Date.now() - t1 < 20000) { if ((await page.locator("body").innerText()).includes("Live Newcomer " + stamp)) { seen = true; break; } await page.waitForTimeout(300); }
check("list only: a new customer's chat appears at once", seen, seen ? `after ${((Date.now() - t1) / 1000).toFixed(1)} s` : "never appeared");

// 3. a hidden tab does not poll
const reqs = [];
page.on("request", (r) => { if (r.url().includes("/api/inbox/pulse")) reqs.push(Date.now()); });
await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
await page.waitForTimeout(8000);
check("a hidden tab does not ask the server", reqs.length === 0, `${reqs.length} requests in 8 s`);
await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
await page.waitForTimeout(1500);
check("and it checks again the moment the tab is shown", reqs.length >= 1);

// 4. the endpoint returns no content and needs a session
const anon = await browser.newContext(); const r = await anon.request.get(`${APP}/api/inbox/pulse`, { maxRedirects: 0 });
check("the pulse endpoint needs a signed-in user", r.status() === 401 || r.status() === 307 || r.status() === 302, `status ${r.status()}`);
const body = await page.evaluate(async () => (await fetch("/api/inbox/pulse")).text());
check("the pulse answer carries no message text, names or numbers", /^\{"token":"[^"]*\|\d+"\}$/.test(body), body.slice(0, 60));
await browser.close();
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
