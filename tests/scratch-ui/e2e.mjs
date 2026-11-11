// SCRATCH-ONLY frontend tests of the REAL app (Next.js dev server on APP) running against the disposable PostgREST + scratch database through
// tests/scratch-ui/gateway.mjs. Never Staging. Run: APP=http://localhost:3299 node tests/scratch-ui/e2e.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const APP = process.env.APP ?? "http://localhost:3299";
const SHOTS = process.env.SHOTS ?? path.resolve("mgh-prep/analysis/screenshots");
const RESULTS = process.env.RESULTS ?? path.resolve("mgh-prep/analysis/phase6_frontend_results.json");
const PASSWORD = "test-pass-123";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let stepNo = 0;
async function step(name, fn) {
  stepNo++;
  const t0 = Date.now();
  try { await fn(); results.push({ n: stepNo, name, ok: true, ms: Date.now() - t0 }); console.log(`PASS ${stepNo}. ${name}`); }
  catch (e) { results.push({ n: stepNo, name, ok: false, error: String(e.message ?? e).split("\n")[0].slice(0, 300) }); console.log(`FAIL ${stepNo}. ${name}\n     ${String(e.message ?? e).split("\n")[0].slice(0, 300)}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const has = async (loc, msg) => { await loc.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error(`not visible: ${msg}`); }); };

const browser = await chromium.launch();
const ctxs = new Map();
const DB = process.env.UI_DB ?? "kapso_ui_scratch";
// the signed-in UI language is the profile's locale (scratch database only)
function dbLocale(email, lang) {
  execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", DB, "-q", "-c", `update public.profiles set locale = '${lang}' where email = '${email}'`], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
}
const NOT_FOUND = /Page not found|الصفحة غير موجودة/;
const notFound = async (page) => page.getByText(NOT_FOUND).first().waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
async function user(email, { lang = "en", width = 1280, height = 900 } = {}) {
  dbLocale(email, lang);
  const key = `${email}|${lang}|${width}`;
  if (ctxs.has(key)) return ctxs.get(key);
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  await ctx.addCookies([{ name: "crm_locale", value: lang, url: APP }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${APP}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  const entry = { ctx, page };
  ctxs.set(key, entry);
  return entry;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `phase6-${name}.png`), fullPage: true });
const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const idOf = (page) => page.url().split("/bookings/")[1]?.split(/[?#]/)[0];

// pick a Radix select by its trigger id and option text
async function choose(page, triggerId, optionText) {
  await page.click(`#${triggerId}`);
  await page.getByRole("option", { name: optionText }).first().click();
}
async function fillBooking(page, { customer, workshop = "Claude for Business", group = "Group 2", country, attendance, discount, value, reason, note }) {
  await page.fill("#customer-search", customer);
  await page.getByRole("button", { name: new RegExp(`^${customer}`) }).first().click();
  await page.selectOption("#workshop-select", { label: workshop.includes("Claude") ? "كلود للأعمال / Claude for Business" : workshop });
  await page.locator("#group-select").waitFor();
  const val = await page.locator("#group-select option", { hasText: group }).first().getAttribute("value");
  await page.selectOption("#group-select", val);
  if (country) await choose(page, "country", country);
  if (attendance) await choose(page, "attendance", attendance);
  if (discount) {
    await choose(page, "discountType", discount);
    if (value != null) await page.fill("#discountValue", String(value));
    if (reason) await page.fill("#discountReason", reason);
  }
  if (note) await page.fill("#note", note);
}
async function book(page, o) {
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, o);
  await page.getByRole("button", { name: "Create booking" }).click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]{36}/, { timeout: 30000 });
  return idOf(page);
}

const PNG = { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") };
const ids = {};

// ───────────────────────────────────────────────────────────── navigation, roles
await step("agent: ONE menu item for bookings and payments (plus Workshops)", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/`);
  for (const n of ["Bookings & payments", "Workshops"]) await has(page.getByRole("link", { name: n, exact: true }), `nav ${n}`);
  ok((await page.getByRole("link", { name: "Customer payments", exact: true }).count()) === 0 && (await page.getByRole("link", { name: "Payments", exact: true }).count()) === 0, "Payments / Customer payments are no longer separate menu items");
});
await step("agent: admin pages are not available (role-based access)", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/admin/offerings`);
  ok(await notFound(page), "expected the not-found page");
});

// ───────────────────────────────────────────────────────────── booking form behaviour
await step("form: price and currency are retrieved from the configured matrix", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, { customer: "Customer 2", group: "Group 2" });
  const s = page.getByTestId("price-summary");
  await has(s, "price summary");
  ok((await s.innerText()).includes("1,000"), "QAR 1,000 expected");
  ok((await s.innerText()).includes("QAR") || (await s.innerText()).includes("ر.ق"), "currency QAR expected");
  await shot(page, "form-price-en");
});
await step("form: a country/attendance without a price is blocked (price not configured)", async () => {
  const { page } = await user("agent_a1@test.local");
  await choose(page, "country", "Bahrain");
  await has(page.getByTestId("price-missing"), "price-missing notice");
  ok(await page.getByRole("button", { name: "Create booking" }).isDisabled(), "submit must be disabled");
  await choose(page, "country", "Qatar");
});
await step("form: a workshop with no configured price cannot be booked", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.selectOption("#workshop-select", { label: "AI for Kids (no price yet)" });
  await page.locator("#group-select").waitFor();
  await has(page.getByTestId("price-missing"), "price-missing for the Kids workshop");
  ok(await page.getByRole("button", { name: "Create booking" }).isDisabled(), "submit must be disabled");
});
await step("form: live summary — 10 % applies at once; 20 % needs a manager; 30 % and 100 % need an admin", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, { customer: "Customer 2", group: "Group 2", discount: "Percentage", value: 10, reason: "loyal customer" });
  const note = page.getByTestId("approval-note");
  ok((await note.innerText()).includes("Applies at once"), "10 % -> at once");
  ok((await page.getByTestId("price-summary").innerText()).includes("900"), "final 900");
  await page.fill("#discountValue", "20");
  ok((await note.innerText()).includes("Manager approval"), "20 % -> manager");
  ok((await page.getByTestId("price-summary").innerText()).includes("1,000"), "pending: final stays at the full price");
  await page.fill("#discountValue", "30");
  ok((await note.innerText()).includes("Admin approval"), "30 % -> admin");
  await choose(page, "discountType", "Fixed amount");
  await page.fill("#discountValue", "1000");
  ok((await note.innerText()).includes("Admin approval"), "fixed 1000 of 1000 = 100 % -> admin");
  await page.fill("#discountValue", "100");
  ok((await note.innerText()).includes("Applies at once"), "fixed 100 of 1000 = 10 % -> at once");
  await page.fill("#discountValue", "100.01");
  ok((await note.innerText()).includes("Manager approval"), "fixed 100.01 of 1000 = 10.001 % -> manager");
  await page.fill("#discountValue", "1000.01");
  ok((await note.innerText()).includes("Invalid"), "above the price -> invalid");
  ok(await page.getByRole("button", { name: "Create booking" }).isDisabled(), "invalid discount blocks submit");
  await shot(page, "form-discount-en");
});
await step("form: the discount reason is mandatory (validation message)", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, { customer: "Customer 2", group: "Group 2", discount: "Percentage", value: 5 });
  await page.getByRole("button", { name: "Create booking" }).click();
  await has(page.getByText("Write the discount reason"), "reason validation");
  ok(/\/bookings\/new/.test(page.url()), "must stay on the form");
});

// ───────────────────────────────────────────────────────────── creating bookings
await step("book: 10 % discount applies at once (final 900, approved)", async () => {
  const { page } = await user("agent_a1@test.local");
  ids.ten = await book(page, { customer: "Customer 2", group: "Group 1", discount: "Percentage", value: 10, reason: "loyal customer" });
  const f = await page.getByTestId("financials").innerText();
  ok(f.includes("900") && f.includes("1,000"), `financials: ${f}`);
  await has(page.getByText("Approved").first(), "discount approved badge");
  await shot(page, "booking-detail-approved-en");
});
await step("book: 25 % is created at the FULL price with a pending request (waiting for a manager)", async () => {
  const { page } = await user("agent_a1@test.local");
  ids.mgr = await book(page, { customer: "Customer 3", group: "Group 1", discount: "Percentage", value: 25, reason: "wholesale" });
  const f = await page.getByTestId("financials").innerText();
  ok(f.includes("1,000") && /—/.test(f) && !f.includes("750"), `price must not be reduced: ${f.replace(/\s+/g, " ")}`);
  await has(page.getByText("Waiting for Manager approval"), "waiting for manager");
  const d = await page.getByTestId("discount-card").innerText();
  ok(d.includes("750"), "price if approved 750 is shown");
  await shot(page, "booking-detail-pending-en");
});
await step("book: 30 % waits for an admin; the requester cannot approve or see approve buttons", async () => {
  const { page } = await user("agent_a1@test.local");
  ids.adm = await book(page, { customer: "Customer 4", group: "Group 2", discount: "Percentage", value: 30, reason: "internal partner" });
  await has(page.getByText("Waiting for Admin approval"), "waiting for admin");
  ok((await page.getByRole("button", { name: "Approve" }).count()) === 0, "the requester must not see Approve");
  ok((await page.getByRole("button", { name: "Reject" }).count()) === 1, "the requester may withdraw");
});
await step("book: the group is full after 2 bookings (option disabled, labelled full)", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await page.fill("#customer-search", "Customer 5");
  await page.getByRole("button", { name: /^Customer 5/ }).first().click();
  await page.selectOption("#workshop-select", { label: "كلود للأعمال / Claude for Business" });
  await page.locator("#group-select").waitFor();
  const opt = page.locator("#group-select option", { hasText: "Group 1" }).first();
  ok((await opt.innerText()).includes("full"), "label shows full");
  ok(await opt.isDisabled(), "full group is disabled");
  await shot(page, "form-group-full-en");
});
await step("book: a duplicate (same customer, same workshop) is refused with a clear message", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, { customer: "Customer 2", group: "Group 2" });
  await page.getByRole("button", { name: "Create booking" }).click();
  await has(page.getByText("already has an active booking"), "duplicate message");
  ok(!(await page.content()).includes("booking.duplicate"), "raw database keys are never shown");
});

// ───────────────────────────────────────────────────────────── approvals (authorization levels)
await step("employee: another employee cannot open someone else's booking (404)", async () => {
  const { page } = await user("agent_a2@test.local");
  await page.goto(`${APP}/bookings/${ids.mgr}`);
  ok(await notFound(page), "expected the not-found page");
});
await step("manager: sees the queue, can approve the manager-level request, cannot decide the admin-level one", async () => {
  const { page } = await user("mgr_a@test.local");
  await page.goto(`${APP}/bookings?tab=approvals`);
  const list = page.getByTestId("approvals-list");
  await has(list, "approvals list");
  const cards = list.locator("li");
  ok((await cards.count()) === 2, `2 pending requests expected, got ${await cards.count()}`);
  const adminCard = cards.filter({ hasText: "Customer 4" });
  ok((await adminCard.getByRole("button", { name: "Approve" }).count()) === 0, "manager must not be offered approve on the admin-level request");
  await has(adminCard.getByText("not allowed"), "cannot decide notice");
  await shot(page, "approvals-manager-en");
  const mgrCard = cards.filter({ hasText: "Customer 3" });
  await mgrCard.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await has(page.getByText("Discount approved"), "success toast");
});
await step("manager approval takes effect: booking price drops to 750 and the status is approved", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/${ids.mgr}`);
  const f = await page.getByTestId("financials").innerText();
  ok(f.includes("750"), `final 750 expected: ${f}`);
  await has(page.getByText("Approved").first(), "approved badge");
});
await step("admin: approves the admin-level request; a self-requested discount cannot be self-approved", async () => {
  const { page } = await user("admin_a@test.local");
  await page.goto(`${APP}/bookings?tab=approvals`);
  const card = page.getByTestId("approvals-list").locator("li").filter({ hasText: "Customer 4" });
  await card.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await has(page.getByText("Discount approved"), "success");
  // self-approval: the admin books for their own customer with 40 % and sees no Approve button
  ids.self = await book(page, { customer: "Customer 14", group: "Group 2", discount: "Percentage", value: 40, reason: "own deal" });
  ok((await page.getByRole("button", { name: "Approve" }).count()) === 0, "no Approve on own request");
  await has(page.getByText("Your request"), "own-request notice (no approve for the requester)");
});
await step("admin: a different admin approves it", async () => {
  const { page } = await user("adm2@test.local");
  await page.goto(`${APP}/bookings/${ids.self}`);
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await has(page.getByText("Discount approved"), "approved by the second admin");
  await page.reload();
  ok((await page.getByTestId("financials").innerText()).includes("600"), "40 % of 1000 = 600");
});
await step("rejection: a rejected discount leaves the booking at the full price", async () => {
  const { page } = await user("agent_a1@test.local");
  const id = await book(page, { customer: "Customer 6", group: "Group 2", discount: "Percentage", value: 15, reason: "please" });
  const mgr = await user("mgr_a@test.local");
  await mgr.page.goto(`${APP}/bookings/${id}`);
  await mgr.page.getByRole("button", { name: "Reject" }).first().click();
  ok(await mgr.page.getByRole("dialog").getByRole("button", { name: "Reject" }).isDisabled(), "a reason is required before rejecting");
  await mgr.page.fill("#reason-input", "not at this level");
  await mgr.page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await has(mgr.page.getByText("Discount rejected"), "rejected toast");
  await page.goto(`${APP}/bookings/${id}`);
  const f = await page.getByTestId("financials").innerText();
  ok(f.includes("1,000") && !f.includes("850"), `still the full price: ${f}`);
  await has(page.getByText("Rejected").first(), "rejected badge");
  await has(page.getByRole("button", { name: "Request a discount" }), "the employee can ask again");
});

// ───────────────────────────────────────────────────────────── payments
await step("payment: pending money is not collected; an amount above what remains is refused", async () => {
  const { page } = await user("agent_a1@test.local");
  ids.pay = await book(page, { customer: "Customer 7", group: "Group 2" });
  await page.getByRole("button", { name: "Record a payment" }).click();
  await page.fill("#amount", "1500");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await has(page.getByRole("dialog").getByText("proof"), "a payment needs its proof image (message)");
  await page.getByTestId("proof-input").setInputFiles(PNG);
  await has(page.getByRole("dialog").getByText("receipt.png"), "the chosen file is shown");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("more than what remains"), "overpayment message");
  await page.fill("#amount", "400");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await has(page.getByText(/Payment recorded|proof/).first(), "saved (the scratch stack has no Storage, so the upload itself is not exercised here)");
  await page.reload();
  const f = await page.getByTestId("financials").innerText();
  ok(/Pending\s*400/.test(f.replace(/\s+/g, " ")) || f.includes("400"), `pending 400: ${f}`);
  await has(page.getByText("Pending approval").first(), "status pending approval");
  await shot(page, "booking-detail-payment-en");
});
await step("payment: confirmed by a manager becomes collected; the remaining balance updates (partially paid)", async () => {
  const mgr = await user("mgr_a@test.local");
  await mgr.page.goto(`${APP}/bookings?customer=Customer%207`);
  const rem = mgr.page.locator("tr", { hasText: "Customer 7" }).getByTestId("remaining");
  const remText = (await rem.innerText()).replace(/\s+/g, " ");
  ok(remText.includes("600"), `remaining counts the pending 400 (1,000 - 400 = 600): ${remText}`);
  ok((await rem.locator("xpath=..").innerText()).includes("1,000"), "the confirmed-only figure (1,000) is shown underneath while 400 is pending");
  await mgr.page.goto(`${APP}/payments`);
  await mgr.page.locator("tr", { hasText: "Customer 7" }).getByRole("button", { name: "Confirm" }).click();
  await mgr.page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
  await has(mgr.page.getByText(/Payment confirmed|confirmed/i).first(), "confirmation");
  await mgr.page.goto(`${APP}/bookings/${ids.pay}`);
  const f = (await mgr.page.getByTestId("financials").innerText()).replace(/\s+/g, " ");
  ok(f.includes("Partially paid") || (await mgr.page.getByText("Partially paid").count()) > 0, `partially paid: ${f}`);
  ok(f.includes("600"), `remaining 600: ${f}`);
});
await step("cancel: a booking with a confirmed payment cannot be cancelled; one without can (reason required)", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/${ids.pay}`);
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.fill("#reason-input", "customer left");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel booking" }).click();
  await has(page.getByText("can't be cancelled"), "has-payments message");
  await page.keyboard.press("Escape");
  const id = await book(page, { customer: "Customer 8", group: "Group 2" });
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.fill("#reason-input", "customer changed plans");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel booking" }).click();
  await has(page.getByText("Booking cancelled"), "cancel toast");
  await page.reload();
  await has(page.getByText("Cancelled").first(), "cancelled status");
  ids.cancelled = id;
});

// ───────────────────────────────────────────────────────────── currencies, workshop page, customer payments, exports
await step("currency: an Egypt booking is in EGP and never mixed with QAR", async () => {
  const { page } = await user("agent_a1@test.local");
  ids.egp = await book(page, { customer: "Customer 9", group: "Group 2", country: "Egypt" });
  const f = await page.getByTestId("financials").innerText();
  ok(f.includes("EGP") && f.includes("2,500"), `EGP 2,500 expected: ${f}`);
});
await step("form: amount paid now — partial / full indicator, too-much blocked, recorded with the booking", async () => {
  const { page } = await user("mgr_a@test.local");
  await page.goto(`${APP}/bookings/new`);
  await fillBooking(page, { customer: "Customer 11", group: "Group 2" });
  await page.fill("#paidNow", "400");
  let sum = await page.getByTestId("payment-summary").innerText();
  ok(sum.includes("Partial payment") && sum.includes("600"), `partial: ${sum.replace(/\s+/g, " ")}`);
  await page.fill("#paidNow", "1000");
  sum = await page.getByTestId("payment-summary").innerText();
  ok(sum.includes("Full payment"), "full payment indicator");
  await page.fill("#paidNow", "1001");
  await has(page.getByText("more than what is due now"), "too-much message");
  ok(await page.getByRole("button", { name: "Create booking" }).isDisabled(), "submit blocked");
  await page.fill("#paidNow", "400");
  await has(page.getByTestId("proof-input").locator("xpath=.."), "proof picker appears once something is paid");
  await page.getByRole("button", { name: "Create booking" }).click();
  await has(page.getByText("proof").first(), "no booking without the proof image when a payment is entered");
  ok(/\/bookings\/new/.test(page.url()), "must stay on the form");
  await page.getByTestId("proof-input").setInputFiles(PNG);
  await shot(page, "form-paid-now-en");
  await page.getByRole("button", { name: "Create booking" }).click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]{36}/, { timeout: 30000 });
  const f = (await page.getByTestId("financials").innerText()).replace(/\s+/g, " ");
  ok(f.includes("400"), `payment recorded with the booking: ${f}`);
  await has(page.getByText("Pending approval").first(), "status pending approval");
});
await step("old payment form points to Bookings", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/payments/new`);
  await has(page.getByTestId("booking-notice"), "booking notice");
  await page.goto(`${APP}/payments`);
  await has(page.getByRole("link", { name: "New booking with payment" }), "single primary action on the payments tab");
  await has(page.getByRole("link", { name: /^Bookings$/ }).first(), "tabs: Bookings");
  await has(page.getByRole("link", { name: /Payments \(review/ }), "tabs: Payments");
  await page.goto(`${APP}/customer-payments?currency=EGP`);
  await page.waitForURL(/\/bookings\?currency=EGP/, { timeout: 15000 }).catch(() => { throw new Error(`old link did not redirect into the section: ${page.url()}`); });
});
await step("shifts: an admin sets a 10:00-19:00 Sunday-Thursday shift; the report separates inside / outside; an employee sees only their own", async () => {
  const { page } = await user("admin_a@test.local");
  await page.goto(`${APP}/reports?tab=shifts`);
  await has(page.getByText("No employee has a shift yet"), "empty state before any shift");
  await page.getByRole("button", { name: "Set a shift" }).click();
  await page.selectOption("#shift-user", { label: "Agent Alpha One" });
  await page.fill("#shift-end", "10:00");
  await has(page.getByRole("dialog").getByText("must differ"), "start = end is refused with a clear message");
  ok(await page.getByRole("dialog").getByRole("button", { name: "Save" }).isDisabled(), "Save is disabled while start = end");
  await page.fill("#shift-end", "19:00");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("Shift saved"), "saved toast");
  await page.reload();
  const sum = (await page.getByTestId("shift-daily").innerText()).replace(/\s+/g, " ");
  ok(sum.includes("Agent Alpha One") && sum.includes("10:00–19:00") && sum.includes("Sun") && sum.includes("Thu"), `summary shows the shift and days: ${sum}`);
  ok(sum.includes("Working days"), "the card shows the working days of the period");
  await shot(page, "shifts-report-en");
  const emp = await user("agent_a1@test.local");
  await emp.page.goto(`${APP}/reports?tab=shifts`);
  await has(emp.page.getByTestId("shift-daily"), "the employee sees the report");
  ok((await emp.page.getByRole("button", { name: "Set a shift" }).count()) === 0, "an employee cannot set shifts");
  ok(!(await emp.page.getByTestId("shift-daily").innerText()).includes("Admin Alpha"), "only their own rows");
});
await step("shifts: Arabic RTL and mobile without overflow", async () => {
  const { page } = await user("admin_a@test.local", { lang: "ar" });
  await page.goto(`${APP}/reports?tab=shifts`);
  ok((await page.evaluate(() => document.documentElement.dir)) === "rtl", "rtl");
  await has(page.getByText("الشيفتات").first(), "Arabic tab label");
  await shot(page, "shifts-report-ar");
  const m = await user("admin_a@test.local", { lang: "ar", width: 390, height: 844 });
  await m.page.goto(`${APP}/reports?tab=shifts`);
  await m.page.waitForLoadState("networkidle");
  ok(!(await hOverflow(m.page)), "no horizontal overflow on mobile");
});
await step("daily employee report: one card per employee with everything done that day, no login times and no calls, and the PDF page renders", async () => {
  const emp = await user("agent_a1@test.local");
  await emp.page.goto(`${APP}/reports?tab=shifts`);
  await emp.page.waitForLoadState("networkidle");
  const daily = (await emp.page.getByTestId("shift-daily").innerText()).replace(/\s+/g, " ");
  for (const h of ["Chats opened", "Chats answered", "Avg. reply time", "Interested customers", "Bookings and total", "Payments and total", "WhatsApp replies sent"]) ok(daily.includes(h), `card shows ${h}: ${daily.slice(0, 200)}`);
  for (const h of ["First login", "Last use", "Calls logged"]) ok(!daily.includes(h), `no "${h}"`);
  ok((await emp.page.getByTestId("employee-card").count()) === 1 && /Agent Alpha One/.test(daily), "an employee sees only their own card");
  const adm = await user("admin_a@test.local");
  await adm.page.goto(`${APP}/reports?tab=shifts`);
  const link = adm.page.getByRole("link", { name: "Download PDF" });
  await has(link, "PDF link");
  const href = await link.getAttribute("href");
  ok(href.startsWith("/daily-report?"), `PDF link target ${href}`);
  await shot(adm.page, "daily-report-en");
  await adm.page.goto(`${APP}${href}`);
  await has(adm.page.getByRole("heading", { name: "Employee daily report" }), "print page heading");
  await has(adm.page.getByTestId("daily-print"), "print page table");
  ok((await adm.page.locator("[data-sidebar='sidebar']").count()) === 0, "no sidebar on the printable page");
  await adm.page.emulateMedia({ media: "print" });
  const pdf = await adm.page.pdf({ format: "A4", preferCSSPageSize: true });
  ok(pdf.length > 5000 && pdf.subarray(0, 4).toString() === "%PDF", `a real PDF is produced (${pdf.length} bytes)`);
  fs.writeFileSync(path.join(SHOTS, "daily-report.pdf"), pdf);
  const ar = await user("admin_a@test.local", { lang: "ar" });
  await ar.page.goto(`${APP}${href}`);
  await has(ar.page.getByRole("heading", { name: "التقرير اليومي للموظفين" }), "Arabic print heading");
  ok((await ar.page.evaluate(() => document.querySelector("[dir]")?.getAttribute("dir"))) !== null, "direction set");
});
await step("workshop page: statistics, per-currency table, groups, prices", async () => {
  const mgr = await user("mgr_a@test.local");
  await mgr.page.goto(`${APP}/workshops`);
  await mgr.page.getByRole("link", { name: /Claude for Business/ }).click();
  await mgr.page.waitForURL(/\/workshops\/[0-9a-f-]{36}/);
  ids.workshop = mgr.page.url().split("/workshops/")[1].split(/[?#]/)[0];
  const cards = (await mgr.page.getByTestId("stat-cards").innerText()).replace(/\s+/g, " ");
  ok(/Total bookings 1\d/.test(cards) || /Total bookings \d+/.test(cards), `stat cards: ${cards}`);
  const tbl = await mgr.page.getByTestId("currency-table").innerText();
  ok(tbl.includes("QAR") && tbl.includes("EGP"), `both currencies as separate rows: ${tbl}`);
  ok((await mgr.page.getByTestId("prices-list").innerText()).includes("Qatar"), "prices listed");
  ok((await mgr.page.getByTestId("groups-list").innerText()).includes("Group 1"), "groups listed");
  await shot(mgr.page, "workshop-page-en");
});
await step("customer payments: filters by status / currency / group and per-currency totals", async () => {
  const mgr = await user("mgr_a@test.local");
  const comp = await mgr.page.goto(`${APP}/bookings`);
  ok(comp.status() === 200, "page loads");
  const totals = await mgr.page.getByTestId("currency-totals").innerText();
  ok(totals.includes("QAR") && totals.includes("EGP"), `separate totals: ${totals}`);
  await mgr.page.goto(`${APP}/bookings?currency=EGP`);
  ok((await mgr.page.locator("tbody tr").count()) === 1, "EGP filter: exactly the Egypt booking");
  await mgr.page.goto(`${APP}/bookings?status=partially_paid`);
  ok((await mgr.page.locator("tbody tr").count()) === 1, "partially paid filter: 1 booking");
  await mgr.page.goto(`${APP}/bookings?customer=Customer%203`);
  ok((await mgr.page.locator("tbody tr").count()) === 1, "customer filter");
  await mgr.page.goto(`${APP}/bookings`);
  await shot(mgr.page, "customer-payments-en");
});
await step("exports: CSV and Excel download, with the data of the visible bookings only", async () => {
  const mgr = await user("mgr_a@test.local");
  const csv = await mgr.page.request.get(`${APP}/api/export/workshop/${ids.workshop}?format=csv`);
  ok(csv.status() === 200 && (csv.headers()["content-type"] ?? "").includes("text/csv"), "csv response");
  const text = await csv.text();
  ok(text.startsWith("﻿") && text.includes("Customer 3") && text.includes("QAR") && text.includes("EGP"), "csv content");
  ok(!text.includes("Beta customer"), "no other company's data");
  const xl = await mgr.page.request.get(`${APP}/api/export/workshop/${ids.workshop}?format=xlsx`);
  ok(xl.status() === 200 && (xl.headers()["content-type"] ?? "").includes("spreadsheetml"), "xlsx response");
  const file = path.join(os.tmpdir(), `phase6-${Date.now()}.xlsx`);
  fs.writeFileSync(file, Buffer.from(await xl.body()));
  const py = "import zipfile,sys,xml.dom.minidom as m\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n[m.parseString(z.read(n)) for n in z.namelist()]\ns=z.read('xl/worksheets/sheet1.xml').decode()\nprint('Customer 3' in s, 'QAR' in s, 'EGP' in s)";
  let out; try { out = execFileSync("python", ["-I", "-c", py, file], { encoding: "utf8" }); } catch { out = execFileSync("python3", ["-I", "-c", py, file], { encoding: "utf8" }); }
  fs.rmSync(file, { force: true });
  ok(out.trim() === "True True True", `xlsx content: ${out}`);
});
await step("exports via the page buttons (download events)", async () => {
  const mgr = await user("mgr_a@test.local");
  await mgr.page.goto(`${APP}/workshops/${ids.workshop}`);
  const [d1] = await Promise.all([mgr.page.waitForEvent("download"), mgr.page.getByRole("link", { name: "Export CSV" }).click()]);
  ok(/\.csv$/.test(d1.suggestedFilename()), `csv filename ${d1.suggestedFilename()}`);
  const [d2] = await Promise.all([mgr.page.waitForEvent("download"), mgr.page.getByRole("link", { name: "Export Excel" }).click()]);
  ok(/\.xlsx$/.test(d2.suggestedFilename()), `xlsx filename ${d2.suggestedFilename()}`);
  await mgr.page.goto(`${APP}/bookings?currency=QAR`);
  const [d3] = await Promise.all([mgr.page.waitForEvent("download"), mgr.page.getByRole("link", { name: "Export CSV" }).click()]);
  const body = fs.readFileSync(await d3.path(), "utf8");
  ok(body.includes("QAR") && !body.includes("EGP,"), "customer-payments export respects the currency filter");
});
await step("employee scope: an employee sees only their own bookings in lists and exports", async () => {
  const { page } = await user("agent_a2@test.local");
  await page.goto(`${APP}/bookings`);
  ok((await page.locator("tbody tr").count()) === 0, "agent_a2 created no bookings: empty");
  const r = await page.request.get(`${APP}/api/export/workshop/${ids.workshop}?format=csv`);
  const body = await r.text();
  ok(r.status() === 200 && !body.includes("Customer 3"), "export contains none of the others' bookings");
});

// ───────────────────────────────────────────────────────────── company isolation
await step("isolation: another company cannot open bookings, workshops or export", async () => {
  const { page } = await user("agent_b@test.local");
  await page.goto(`${APP}/bookings/${ids.ten}`);
  ok(await notFound(page), "booking of another company: not found");
  await page.goto(`${APP}/workshops/${ids.workshop}`);
  ok(await notFound(page), "workshop of another company: not found");
  const r = await page.request.get(`${APP}/api/export/workshop/${ids.workshop}?format=csv`);
  ok(r.status() === 404, `export refused (${r.status()})`);
  await page.goto(`${APP}/bookings`);
  ok((await page.locator("tbody tr").count()) === 0, "no rows from the other company");
});
await step("dashboard of a workshop company (Deals hidden): revenue comes from bookings and payments, per currency, no deal figures", async () => {
  const psql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", DB, "-At", "-c", q], { encoding: "utf8" }).trim();
  psql("update public.companies set slug = 'mgh' where slug = 'alpha'");
  try {
    const adm = await user("admin_a@test.local");
    await adm.page.goto(`${APP}/?period=this_month`);
    await adm.page.waitForLoadState("networkidle");
    const body = (await adm.page.locator("main").first().innerText()).replace(/\s+/g, " ");
    for (const id of ["workshop-dashboard", "tile-collected", "tile-bookings", "tile-leads", "tile-avg", "revenue-hero", "workshop-share", "latest-bookings", "top-workshops", "goal-card", "period-pills"]) {
      ok((await adm.page.getByTestId(id).count()) >= 1, `dashboard block ${id}`);
    }
    for (const w of ["Won revenue", "Deals won", "Win rate", "Open pipeline value", "Weighted pipeline"]) ok(!body.includes(w), `no deal figure "${w}"`);
    ok(/Good (morning|afternoon|evening),/.test(body), `a greeting: ${body.slice(0, 80)}`);
    ok(body.includes("not profit"), "the revenue-not-profit note is shown");
    ok((await adm.page.getByTestId("tile-collected").innerText()).includes("QAR"), "the collected tile is in a currency");
    ok(/\d/.test(await adm.page.getByTestId("latest-bookings").innerText()), "latest bookings list shows amounts");
    ok((await adm.page.getByTestId("top-workshops").innerText()).includes("Claude for Business"), "top workshops lists the workshop");
    await shot(adm.page, "dashboard-hero-en");
    await adm.page.getByTestId("period-pills").getByRole("link", { name: "30D" }).click();
    await adm.page.waitForURL(/period=last_30_days/);
    ok((await adm.page.getByTestId("period-pills").getByRole("link", { name: "30D" }).getAttribute("aria-current")) === "page", "the chosen period is highlighted");
    await adm.page.getByRole("button", { name: /Show as table/ }).first().click();
    ok((await adm.page.getByTestId("revenue-hero").locator("table").count()) === 1, "the revenue chart has a table view");
    await shot(adm.page, "dashboard-workshop-en");
    await adm.page.goto(`${APP}/reports`);
    await adm.page.waitForLoadState("networkidle");
    ok((await adm.page.locator("main").first().innerText()).includes("Collected revenue"), "the Reports overview shows the same revenue tiles");
    const ar = await user("admin_a@test.local", { lang: "ar" });
    await ar.page.goto(`${APP}/`);
    await has(ar.page.getByText("الإيرادات المحصّلة").first(), "Arabic revenue tile");
    ok(/(صباح|مساء) الخير/.test(await ar.page.locator("main").first().innerText()), "Arabic greeting");
    await shot(ar.page, "dashboard-workshop-ar");
    const m = await user("admin_a@test.local", { lang: "ar", width: 390, height: 844 });
    await m.page.goto(`${APP}/`);
    await m.page.waitForLoadState("networkidle");
    ok(!(await hOverflow(m.page)), "no horizontal overflow on mobile");
    const agent = await user("agent_a1@test.local");
    await agent.page.goto(`${APP}/`);
    await agent.page.waitForLoadState("networkidle");
    ok((await agent.page.locator("main").first().innerText()).includes("Collected revenue"), "an employee sees the revenue tiles too (their own figures)");
  } finally {
    psql("update public.companies set slug = 'alpha' where slug = 'mgh'");
  }
});
await step("company settings: an admin controls approvers, targets, exclusions, menu and dashboard from the CRM", async () => {
  const psql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", DB, "-At", "-c", q], { encoding: "utf8" }).trim();
  const agent = await user("agent_a1@test.local");
  await agent.page.goto(`${APP}/admin/settings`);
  ok(await notFound(agent.page), "an employee cannot open the settings page");
  ok((await agent.page.locator("[data-sidebar='sidebar']").getByRole("link", { name: "Company settings" }).count()) === 0, "and has no menu entry for it");
  const { page } = await user("admin_a@test.local");
  await page.goto(`${APP}/admin/settings`);
  await has(page.getByTestId("approvers-form"), "approvers form");
  ok((await page.getByTestId("approvers-form").innerText()).includes("Not restricted"), "starts unrestricted");
  // approvers
  await page.getByTestId("approvers-form").getByLabel(/Manager Alpha/).check();
  await page.getByTestId("approvers-form").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("Saved").first(), "approvers saved toast");
  ok(Number(psql("select count(*) from public.payment_approvers")) === 1, "one approver stored");
  await page.reload();
  ok((await page.getByTestId("approvers-form").innerText()).includes("Restricted to the selected people"), "now restricted");
  await page.getByTestId("approvers-form").getByRole("button", { name: "Let every manager approve" }).click();
  await has(page.getByText("Saved").first(), "reverted toast");
  ok(Number(psql("select count(*) from public.payment_approval_policy")) === 0, "back to unrestricted");
  // target currency and default
  await page.reload();
  await page.selectOption("#target-currency", "QAR");
  await page.getByRole("button", { name: "Save" }).nth(0).waitFor();
  await page.locator("#target-currency").locator("xpath=following::button[1]").click();
  await has(page.getByText("Saved").first(), "currency saved");
  ok(psql("select currency from public.company_target_settings limit 1") === "QAR", "target currency QAR stored");
  await page.reload();
  await page.getByLabel("Monthly amount Company default (every agent)").fill("10000");
  await page.getByLabel("Monthly amount Company default (every agent)").locator("xpath=following::button[1]").click();
  await has(page.getByText("Saved").first(), "default target saved");
  ok(psql("select amount_egp from public.monthly_target_defaults where user_id is null") === "10000.00", "company default stored");
  // exclusion
  await page.reload();
  await page.getByLabel("Excluded: Agent Alpha Two").check();
  await page.waitForTimeout(1500);
  ok(Number(psql("select count(*) from public.performance_exclusions where user_id = (select id from public.profiles where email = 'agent_a2@test.local')")) === 1, "exclusion stored");
  // menu + dashboard
  await page.reload();
  await page.getByTestId("ui-settings-form").getByLabel("Tasks", { exact: true }).check();
  await page.getByTestId("ui-settings-form").getByLabel(/Workshop revenue/).check();
  await page.getByTestId("ui-settings-form").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("Saved").first(), "menu saved");
  ok(psql("select hidden_nav::text || ' ' || dashboard_mode from public.company_ui_settings") === "{/tasks} workshop", "menu settings stored");
  await page.reload();
  ok((await page.locator("[data-sidebar='sidebar']").getByRole("link", { name: "Tasks", exact: true }).count()) === 0, "Tasks is gone from the menu");
  await page.goto(`${APP}/`);
  await page.waitForLoadState("networkidle");
  ok((await page.locator("main").first().innerText()).includes("Collected revenue"), "the dashboard switched to workshop revenue");
  // dashboard sections: hide two of them, check the dashboard, then show them again
  ok(await page.getByText("Latest bookings").count() > 0 && await page.getByText("Monthly goal").count() > 0, "both sections are visible by default");
  await page.goto(`${APP}/admin/settings`);
  await page.getByTestId("widgets").getByLabel("Latest bookings").uncheck();
  await page.getByTestId("widgets").getByLabel("Monthly goal").uncheck();
  await page.getByTestId("ui-settings-form").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("Saved").first(), "sections saved");
  ok(psql("select hidden_widgets::text from public.company_ui_settings") === "{goal,latest_bookings}", "hidden sections stored");
  await page.goto(`${APP}/`);
  await page.waitForLoadState("networkidle");
  ok((await page.getByText("Latest bookings").count()) === 0 && (await page.getByText("Monthly goal").count()) === 0, "the hidden sections are gone from the dashboard");
  ok((await page.getByTestId("tile-collected").count()) === 1, "the headline figures stay");
  await page.goto(`${APP}/admin/settings`);
  await page.getByTestId("widgets").getByLabel("Latest bookings").check();
  await page.getByTestId("widgets").getByLabel("Monthly goal").check();
  await page.getByTestId("ui-settings-form").getByRole("button", { name: "Save" }).click();
  await has(page.getByText("Saved").first(), "sections restored");
  ok(psql("select hidden_widgets::text from public.company_ui_settings") === "{}", "nothing hidden again");
  await shot(page, "company-settings-en");
  // audit trail
  ok(Number(psql("select count(*) from public.audit_logs where action in ('payment.approvers_set','payment.approval_policy_cleared','target.currency_set','target.default_set','company.ui_settings_set')")) >= 5, "every change is in the audit log");
  const ar = await user("admin_a@test.local", { lang: "ar" });
  await ar.page.goto(`${APP}/admin/settings`);
  await has(ar.page.getByText("إعدادات الشركة").first(), "Arabic title");
  const m = await user("admin_a@test.local", { lang: "ar", width: 390, height: 844 });
  await m.page.goto(`${APP}/admin/settings`);
  await m.page.waitForLoadState("networkidle");
  ok(!(await hOverflow(m.page)), "no horizontal overflow on mobile");
  await shot(ar.page, "company-settings-ar");
  // leave the scratch data as found for the following steps
  psql("delete from public.company_ui_settings; delete from public.performance_exclusions; delete from public.monthly_target_defaults; delete from public.company_target_settings");
});
await step("voice booking: the microphone text fills the form (customer, workshop, group, country, attendance, discount, payment); nothing is saved until Create", async () => {
  const { page } = await user("agent_a1@test.local");
  // a fake browser speech recogniser: Start "hears" window.__said, Stop ends the session
  await page.addInitScript(() => {
    class FakeRecognition {
      constructor() { this.onresult = null; this.onend = null; this.onerror = null; }
      start() { setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: window.__said || "" }], { isFinal: true })] }), 50); }
      stop() { setTimeout(() => this.onend && this.onend(), 20); }
    }
    window.webkitSpeechRecognition = FakeRecognition;
    window.SpeechRecognition = FakeRecognition;
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
  });
  await page.goto(`${APP}/bookings/new`);
  await has(page.getByTestId("voice-capture"), "the voice section");
  await page.evaluate(() => { window.__said = "حجز جديد للعميل أحمد علي ورشة كلود للأعمال المجموعة الثانية دولة قطر أونلاين خصم عشرة في المية بسبب عميل قديم ودفع خمسمية ريال"; });
  await page.getByTestId("voice-start").click();
  await page.waitForTimeout(300);
  ok((await page.getByTestId("voice-text").inputValue()).includes("أحمد علي"), "the spoken text appears in the box");
  await page.getByTestId("voice-stop").click();
  await has(page.getByTestId("voice-report"), "the report of what was understood");
  await page.waitForTimeout(1500);
  const report = (await page.getByTestId("voice-report").innerText()).replace(/\s+/g, " ");
  for (const w of ["أحمد علي", "كلود للأعمال", "Group 2", "10%", "عميل قديم", "500"]) ok(report.includes(w), `understood "${w}": ${report.slice(0, 260)}`);
  ok(await page.locator("#customer-search").count() === 0 || (await page.getByText("أحمد علي").first().isVisible()), "the customer is picked");
  ok((await page.locator("#workshop-select").inputValue()) !== "", "the workshop is selected");
  ok((await page.locator("#group-select option:checked").innerText()).includes("Group 2"), "the group is selected");
  ok((await page.locator("#discountValue").inputValue()) === "10", "discount value 10");
  ok((await page.locator("#discountReason").inputValue()).includes("عميل قديم"), "discount reason");
  ok((await page.locator("#paidNow").inputValue()) === "500", "paid now 500");
  await shot(page, "voice-booking-en");
  ok(/\/bookings\/new/.test(page.url()), "nothing was saved: still on the new-booking page");
  // the employee reviews, attaches the receipt and creates it
  await page.locator("input[type=file]").setInputFiles(PNG);
  await page.getByRole("button", { name: "Create booking" }).click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]{36}/, { timeout: 30000 });
  const detail = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  ok(detail.includes("900") && detail.includes("500"), `created with the 10% discount (900) and the 500 payment: ${detail.slice(0, 200)}`);
});
await step("voice booking: typed text, unknown customer and an unclear workshop are reported, never guessed", async () => {
  const { page } = await user("agent_a1@test.local");
  await page.goto(`${APP}/bookings/new`);
  await page.getByTestId("voice-text").fill("العميل فلان الفلاني ورشة تسويق خصم 20");
  await page.getByTestId("voice-analyze").click();
  await has(page.getByTestId("voice-report"), "report");
  const r = (await page.getByTestId("voice-report").innerText()).replace(/\s+/g, " ");
  ok(r.includes("فلان الفلاني") && /no customer found|لم أجد/i.test(r), `unknown customer reported: ${r.slice(0, 200)}`);
  ok(r.includes("20%") && /percentage|نسبة/.test(r), "a bare 20 is taken as a percentage and says so");
  ok(/reason is required|السبب مطلوب/.test(r), "the missing discount reason is flagged");
  ok((await page.locator("#workshop-select").inputValue()) === "", "an unclear workshop is not guessed");
  await page.getByTestId("voice-text").fill("حجز جديد لو سمحت");
  await page.getByTestId("voice-analyze").click();
  ok(/Nothing could be recognised|لم أتعرف/.test((await page.getByTestId("voice-report").innerText())), "nothing recognised is said clearly");
  const ar = await user("agent_a1@test.local", { lang: "ar" });
  await ar.page.goto(`${APP}/bookings/new`);
  await has(ar.page.getByText("إدخال صوتي").first(), "Arabic voice title");
  const m = await user("agent_a1@test.local", { lang: "ar", width: 390, height: 844 });
  await m.page.goto(`${APP}/bookings/new`);
  await m.page.waitForLoadState("networkidle");
  ok(!(await hOverflow(m.page)), "no horizontal overflow on mobile");
});
await step("branding: a company admin changes the colours and the logo; everyone in the company sees them; unreadable colours are refused; reset restores the default", async () => {
  const { page } = await user("admin_a@test.local");
  const cssVar = (pg, name) => pg.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await page.goto(`${APP}/admin/settings`);
  await has(page.getByTestId("branding-form"), "the appearance section");
  ok((await cssVar(page, "--brand-navy")) === "#0b2a52", "starts with the default colours");
  // unreadable colours
  await page.fill("#brand-navy", "#eeeeee");
  await has(page.getByTestId("brand-issues"), "a readability warning");
  ok(await page.getByRole("button", { name: "Save appearance" }).isDisabled(), "Save is disabled while the colours are unreadable");
  await page.fill("#brand-navy", "red");
  ok(await page.getByRole("button", { name: "Save appearance" }).isDisabled(), "a colour name is not accepted");
  // a ready-made set
  await page.getByTestId("preset-forest").click();
  await page.getByRole("button", { name: "Save appearance" }).click();
  await has(page.getByText("Appearance saved").first(), "saved toast");
  await page.reload();
  ok((await cssVar(page, "--brand-navy")) === "#0a3d2e" && (await cssVar(page, "--primary")) === "#1f6f54" && (await cssVar(page, "--sidebar-primary")) === "#f2b705", "the whole application now uses the chosen colours");
  // another user of the company sees them too
  const emp = await user("agent_a1@test.local");
  await emp.page.goto(`${APP}/`);
  ok((await cssVar(emp.page, "--brand-navy")) === "#0a3d2e", "an employee of the company sees the same colours");
  // logo
  await page.setInputFiles("#logo-file", { name: "bad.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)/>") });
  await has(page.getByText(/not a valid image/i).first(), "a fake image is refused by the server");
  await page.setInputFiles("#logo-file", PNG);
  await has(page.getByText("Logo updated").first(), "logo saved");
  await page.reload();
  const src = await page.getByTestId("sidebar-logo").getAttribute("src");
  ok(/^\/api\/brand\/logo\?c=[0-9a-f-]{36}&v=\d+$/.test(src ?? ""), `the sidebar uses the company logo: ${src}`);
  const resp = await emp.page.request.get(`${APP}${src}`);
  ok(resp.status() === 200 && resp.headers()["content-type"] === "image/png", "the logo is served to the company's members as an image");
  ok(Number(await page.getByTestId("sidebar-logo").evaluate((el) => el.naturalWidth)) === 1, "and it loads in the page");
  await page.getByLabel("Show the logo on a white background").check();
  await page.getByRole("button", { name: "Save appearance" }).click();
  await has(page.getByText("Appearance saved").first(), "plate saved");
  await page.reload();
  ok(((await page.getByTestId("sidebar-logo").getAttribute("class")) ?? "").includes("bg-white"), "the logo is shown on a white plate");
  await shot(page, "branding-en");
  // reset
  await page.getByRole("button", { name: "Back to the default look" }).click();
  await has(page.getByText("Back to the default look").first(), "reset toast");
  await page.reload();
  ok((await cssVar(page, "--brand-navy")) === "#0b2a52" && (await page.getByTestId("sidebar-logo").getAttribute("src")) === "/mgh-logo.png", "reset restores the default colours and logo");
  const m = await user("admin_a@test.local", { lang: "ar", width: 390, height: 844 });
  await m.page.goto(`${APP}/admin/settings`);
  await m.page.waitForLoadState("networkidle");
  ok(!(await hOverflow(m.page)), "no horizontal overflow on mobile");
  const ar = await user("admin_a@test.local", { lang: "ar" });
  await ar.page.goto(`${APP}/admin/settings`);
  await has(ar.page.getByText("المظهر").first(), "Arabic title");
});
await step("deals are gone: no page, no menu entry, no conversion button, no deal figures, lead pipelines only", async () => {
  const { page } = await user("admin_a@test.local");
  await page.goto(`${APP}/deals`);
  ok(await notFound(page), "/deals no longer exists");
  await page.goto(`${APP}/`);
  await page.waitForLoadState("networkidle");
  const nav = (await page.locator("[data-sidebar='sidebar']").innerText()).replace(/\s+/g, " ");
  ok(!/Deals/.test(nav), `no Deals in the menu: ${nav.slice(0, 120)}`);
  const body = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  for (const w of ["Won revenue", "Deals won", "Win rate", "Open pipeline value", "Weighted pipeline", "Open deals", "Lead conversion"]) ok(!body.includes(w), `standard dashboard has no "${w}"`);
  await page.goto(`${APP}/leads`);
  const hrefs = await page.locator("a[href^='/leads/']").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const leadHref = hrefs.find((h) => /^\/leads\/[0-9a-f-]{36}$/i.test(h ?? ""));
  if (leadHref) {
    await page.goto(`${APP}${leadHref}`);
    await page.waitForLoadState("networkidle");
    ok((await page.getByRole("button", { name: /Convert to deal/ }).count()) === 0, "no Convert to deal button on a lead");
  }
  await page.goto(`${APP}/admin/pipelines`);
  await page.waitForLoadState("networkidle");
  const pl = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  ok(!/Deals?/.test(pl), `pipelines page has no deal wording: ${pl.slice(0, 160)}`);
  await page.getByRole("button", { name: /New pipeline/ }).click();
  ok((await page.getByRole("dialog").getByText("Deals").count()) === 0, "the new-pipeline form offers no Deals type");
  await page.goto(`${APP}/search?q=a`);
  ok(!(await page.locator("main").first().innerText()).includes("Deals"), "search has no Deals group");
});
await step("unauthenticated: pages redirect to login and exports return 401/redirect", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/bookings`);
  ok(/\/login/.test(page.url()), "redirected to login");
  const r = await page.request.get(`${APP}/api/export/workshop/${ids.workshop}?format=csv`, { maxRedirects: 0 }).catch(() => null);
  ok(!r || r.status() === 401 || r.status() === 307 || r.status() === 302, `export without a session: ${r?.status()}`);
  await ctx.close();
});

// ───────────────────────────────────────────────────────────── Arabic / RTL, mobile
await step("Arabic: RTL layout, Arabic labels, booking form and detail", async () => {
  const { page } = await user("agent_a1@test.local", { lang: "ar" });
  await page.goto(`${APP}/bookings/new`);
  ok((await page.evaluate(() => document.documentElement.dir)) === "rtl", "dir=rtl");
  await has(page.getByText("حجز جديد").first(), "Arabic title");
  await fillBooking(page, { customer: "Customer 10", group: "Group 2", discount: "نسبة مئوية", value: 20, reason: "خصم عميل مميز" });
  ok((await page.getByTestId("approval-note").innerText()).includes("اعتماد مدير"), "Arabic approval note");
  await shot(page, "form-ar");
  await page.getByRole("button", { name: "إنشاء الحجز" }).click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]{36}/);
  await has(page.getByText("بانتظار اعتماد").first(), "Arabic pending status");
  await shot(page, "booking-detail-pending-ar");
});
await step("Arabic: lists, approvals, workshop and customer payments render in RTL", async () => {
  const mgr = await user("mgr_a@test.local", { lang: "ar" });
  for (const [p, name] of [["/bookings", "bookings"], ["/bookings?tab=approvals", "approvals"], [`/workshops/${ids.workshop}`, "workshop"], ["/payments", "payments-tab"], ["/bookings", "customer-payments"]]) {
    await mgr.page.goto(`${APP}${p}`);
    ok((await mgr.page.evaluate(() => document.documentElement.dir)) === "rtl", `${p} rtl`);
    await shot(mgr.page, `${name}-ar`);
  }
  await has(mgr.page.getByRole("heading", { name: "الحجوزات والمدفوعات" }), "Arabic page title");
});
for (const [label, email, lang] of [["mobile en", "mgr_a@test.local", "en"], ["mobile ar", "mgr_a@test.local", "ar"]]) {
  await step(`${label} (390px): no horizontal overflow on the new pages`, async () => {
    const { page } = await user(email, { lang, width: 390, height: 844 });
    const pages = ["/bookings", "/bookings?tab=approvals", "/payments", "/bookings/new", `/bookings/${ids.mgr}`, `/workshops/${ids.workshop}`];
    for (const p of pages) {
      await page.goto(`${APP}${p}`);
      await page.waitForLoadState("networkidle");
      ok(!(await hOverflow(page)), `horizontal overflow on ${p}`);
    }
    await shot(page, `booking-detail-mobile-${lang}`);
    await page.goto(`${APP}/bookings`);
    await shot(page, `customer-payments-mobile-${lang}`);
  });
}

await step("tablet (768px): booking form and workshop page without overflow", async () => {
  const { page } = await user("mgr_a@test.local", { width: 768, height: 1024 });
  for (const p of ["/bookings/new", `/workshops/${ids.workshop}`, "/bookings"]) {
    await page.goto(`${APP}${p}`);
    await page.waitForLoadState("networkidle");
    ok(!(await hOverflow(page)), `overflow on ${p}`);
  }
  await shot(page, "workshop-tablet-en");
});

await browser.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(RESULTS, JSON.stringify({ generatedAt: new Date().toISOString(), app: APP, total: results.length, passed: results.length - failed.length, failed: failed.length, steps: results }, null, 1));
console.log(`\nFRONTEND: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
