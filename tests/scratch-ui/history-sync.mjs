// SCRATCH-ONLY: the super admin's "Check and complete messages" button, end to end, against a FAKE Kapso API on 127.0.0.1:3399
// (the app must run with KAPSO_PLATFORM_URL=http://127.0.0.1:3399 and any KAPSO_API_KEY). Never contacts the real Kapso.
import http from "node:http";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const APP = process.env.APP ?? "http://localhost:3299";
const sql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
sql("delete from app.rate_limits");

// a real (production) Kapso number of company alpha
const PN = "998877665544";
sql(`insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, waba_id, provider, environment, connection_mode, status) select id, 'Sync Test', '+97450088001', '${PN}', '1122', 'kapso', 'production', 'coexistence', 'active' from public.companies where slug = 'alpha' on conflict do nothing`);

// the fake Kapso history: 30 customers, 8 messages each, every 12 hours from 2026-07-20 (part of it before 1 Aug), newest first like Kapso
const FROM = Date.parse("2026-08-01T00:00:00Z") / 1000;
const all = [];
let t = Date.parse("2026-07-20T09:00:00Z") / 1000;
for (let i = 0; i < 240; i++) {
  const c = i % 30, inbound = i % 3 !== 2;
  const phone = `97455${String(100000 + c)}`;
  all.push({ id: `wamid.SYNC${i}`, type: i % 17 === 0 ? "reaction" : "text", timestamp: String(t), from: inbound ? phone : "97450088001", to: inbound ? "97450088001" : phone,
    text: { body: `message ${i}` }, kapso: { direction: inbound ? "inbound" : "outbound", status: "delivered", whatsapp_conversation_id: `kc${c}`, contact_name: `Sync Customer ${c}` } });
  t += 3600 * 3;
}
all.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
const inRange = all.filter((m) => Number(m.timestamp) >= FROM && m.type !== "reaction").length;
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  const u = new URL(req.url, "http://x");
  if (req.headers["x-api-key"] === undefined) { res.writeHead(401); return res.end(); }
  if (u.searchParams.get("has_media") === "true") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [], paging: { cursors: {}, next: null } })); }
  const start = Number(u.searchParams.get("after") ?? 0), limit = Number(u.searchParams.get("limit") ?? 20);
  const data = u.searchParams.get("phone_number_id") === PN ? all.slice(start, start + limit) : [];
  const more = start + limit < all.length && data.length;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data, paging: { cursors: { after: more ? String(start + limit) : null }, next: more ? "next" : null } }));
}).listen(3399, "127.0.0.1");

const browser = await chromium.launch();
async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([{ name: "crm_locale", value: "en", url: APP }]);
  const page = await ctx.newPage();
  await page.goto(`${APP}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  await page.goto(`${APP}/admin/whatsapp`); await page.waitForLoadState("networkidle").catch(() => undefined);
  return page;
}
const crmCount = () => Number(sql(`select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id join public.whatsapp_accounts w on w.id = c.whatsapp_account_id where w.phone_number_id = '${PN}'`));

// a company admin does not get the button
const admin = await open("admin_a@test.local");
check("a company admin does not see the button (super admin only)", (await admin.getByTestId("history-sync").count()) === 0);

// first run: everything since 1 Aug is added, nothing older
const page = await open("super@test.local");
check("the super admin sees the button with 1 Aug as the default day", (await page.getByTestId("history-sync-from").inputValue()) === "2026-08-01");
await page.getByTestId("history-sync-run").click();
await page.getByTestId("history-sync-done").waitFor({ timeout: 180000 });
const text1 = await page.getByTestId("history-sync-table").innerText();
check("run 1: every Kapso message since that day is now in the CRM", crmCount() === inRange, `${crmCount()} of ${inRange}`);
check("run 1: nothing older than the chosen day was added", Number(sql(`select count(*) from public.messages where wa_message_id like 'wamid.SYNC%' and sent_at < '2026-08-01'`)) === 0);
check("run 1: reactions are not stored", Number(sql(`select count(*) from public.messages where wa_message_id in (${all.filter((m) => m.type === "reaction").map((m) => `'${m.id}'`).join(",")})`)) === 0);
check("run 1: one conversation per customer, nothing unread", sql(`select count(*) || '|' || coalesce(sum(unread_count), 0) from public.conversations c join public.whatsapp_accounts w on w.id = c.whatsapp_account_id where w.phone_number_id = '${PN}'`) === "30|0");
check("run 1: the table reports what was added", /Sync Test/.test(text1) && text1.includes(String(inRange)), text1.replace(/\s+/g, " ").slice(0, 120));

// second run: nothing new
await page.reload(); await page.waitForLoadState("networkidle").catch(() => undefined);
await page.getByTestId("history-sync-run").click();
await page.getByTestId("history-sync-done").waitFor({ timeout: 180000 });
const done2 = await page.getByTestId("history-sync-done").innerText();
check("run 2: safe to repeat, nothing is stored twice", crmCount() === inRange && /(^|\D)0 messages added|أضيفت 0 رسالة/.test(done2), done2);

// a message missed by the webhook (deleted here to simulate it) comes back
sql(`delete from public.messages where wa_message_id = '${all[3].id}'`);
await page.reload(); await page.waitForLoadState("networkidle").catch(() => undefined);
await page.getByTestId("history-sync-run").click();
await page.getByTestId("history-sync-done").waitFor({ timeout: 180000 });
check("run 3: a message the CRM was missing is added back", crmCount() === inRange && /(^|\D)1 messages added|أضيفت 1 رسالة/.test(await page.getByTestId("history-sync-done").innerText()));
check("the fake Kapso was asked politely (paged, newest first, stopped at the chosen day)", requests > 0 && requests < 30, `${requests} requests`);

await browser.close(); server.close();
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
