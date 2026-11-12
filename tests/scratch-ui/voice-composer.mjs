// SCRATCH-ONLY: the chat composer's microphone, in the real app with a FAKE microphone (Chromium's test device). Needs the scratch harness
// (see README) and one open conversation: CONV=<conversation id>. Storage is not part of the scratch gateway, so "send" is expected to stop at
// the upload step with an error message - what is checked here is the recording UI and that nothing is sent without a tap.
import { chromium } from "playwright";
const APP = process.env.APP ?? "http://localhost:3299", CONV = process.env.CONV;
const results = []; const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ["microphone"] });
await ctx.addCookies([{ name: "crm_locale", value: "en", url: APP }]);
const page = await ctx.newPage();
const calls = []; page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) calls.push(r.url()); });
await page.goto(`${APP}/login`); await page.fill('input[type="email"]', "super@test.local"); await page.fill('input[type="password"]', "test-pass-123"); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
await page.goto(`${APP}/inbox?c=${CONV}`); await page.waitForLoadState("networkidle").catch(() => undefined);

check("empty box: the microphone is shown instead of the send button", (await page.getByTestId("voice-start").count()) === 1 && (await page.locator("form button[type=submit]").count()) === 0);
await page.locator("form textarea").first().fill("hi");
check("typing swaps it for the send button", (await page.getByTestId("voice-start").count()) === 0 && (await page.locator("form button[type=submit]").count()) === 1);
await page.locator("form textarea").first().fill("");
check("clearing the text brings the microphone back", (await page.getByTestId("voice-start").count()) === 1);

await page.waitForTimeout(1500);
const base = calls.length;   // other server actions (marking the chat read, live updates) are not the recorder
await page.getByTestId("voice-start").click();
await page.getByTestId("voice-recording").waitFor({ timeout: 10000 });
check("recording: the bar shows with timer, bin and send; the text box is hidden", (await page.getByTestId("voice-cancel").count()) === 1 && (await page.getByTestId("voice-send").count()) === 1 && !(await page.locator("form textarea").first().isVisible()));
await page.waitForTimeout(2300);
const t = (await page.getByRole("timer").innerText()).trim();
check("the timer runs", /^0:0[2-9]$/.test(t), t);
await page.screenshot({ path: "tests/scratch-ui/out/voice-recording.png" });
await page.getByTestId("voice-cancel").click();
check("the bin throws the recording away: nothing was sent", (await page.getByTestId("voice-recording").count()) === 0 && (await page.getByTestId("voice-start").count()) === 1 && calls.length === base, `${calls.length - base} server calls from the recorder`);

await page.getByTestId("voice-start").click(); await page.getByTestId("voice-recording").waitFor();
await page.waitForTimeout(1500);
await page.getByTestId("voice-send").click();
await page.waitForTimeout(4000);
check("send: the file was prepared for upload (server action called) and the composer is back", calls.length > base && (await page.getByTestId("voice-start").count()) === 1, `${calls.length} server calls`);
const mobile = await ctx.newPage(); await mobile.setViewportSize({ width: 390, height: 800 });
await mobile.goto(`${APP}/inbox?c=${CONV}`); await mobile.waitForLoadState("networkidle").catch(() => undefined);
await mobile.getByTestId("voice-start").click(); await mobile.getByTestId("voice-recording").waitFor();
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
await mobile.screenshot({ path: "tests/scratch-ui/out/voice-recording-mobile.png" });
check("phone width: no horizontal overflow while recording", !overflow);
await browser.close();
console.log(results.every(Boolean) ? "ALL PASS" : `FAILURES: ${results.filter((x) => !x).length}`);
process.exit(results.every(Boolean) ? 0 : 1);
