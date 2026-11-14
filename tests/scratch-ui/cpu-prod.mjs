// READ-ONLY CPU profile of a page of the DEPLOYED site on a throttled phone: which scripts/functions use the main thread as one real account: a short-lived session is minted for the account named in EMAIL through the Auth
// admin API (magic-link token verified immediately; nothing is written to the CRM, no password is needed) and put in the browser as the normal
// session cookie. Secrets are read from .env.local and never printed. Usage: EMAIL=... node tests/scratch-ui/perf-prod.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const APP = process.env.APP ?? "https://sales-crm-mgh.vercel.app", EMAIL = process.env.EMAIL;
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+\s*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const link = await (await fetch(`${URL_}/auth/v1/admin/generate_link`, { method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ type: "magiclink", email: EMAIL }) })).json();
const ses = await (await fetch(`${URL_}/auth/v1/verify`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token }) })).json();
if (!ses.access_token) { console.log("could not mint a session"); process.exit(1); }
const ref = new globalThis.URL(URL_).hostname.split(".")[0];
const value = "base64-" + Buffer.from(JSON.stringify(ses)).toString("base64url");
const name = `sb-${ref}-auth-token`, SIZE = 3180, host = new globalThis.URL(APP).hostname;
const cookies = value.length <= SIZE ? [{ name, value }] : Array.from({ length: Math.ceil(value.length / SIZE) }, (_, i) => ({ name: `${name}.${i}`, value: value.slice(i * SIZE, (i + 1) * SIZE) }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies.map((c) => ({ ...c, domain: host, path: "/", secure: true, sameSite: "Lax" })));
await ctx.addCookies([{ name: "crm_locale", value: process.env.LOCALE ?? "en", domain: host, path: "/", secure: true }]);
const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await phone.addCookies(await ctx.cookies());
const page = await phone.newPage();
const cdp = await phone.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
const P = process.env.PAGE ?? "/bookings";
await page.goto(`${APP}${P}`, { waitUntil: "load" }).catch(() => undefined);   // warm the server first
await cdp.send("Profiler.start");
await page.goto(`${APP}${P}`, { waitUntil: "load" });
await page.waitForTimeout(3000);
const { profile } = await cdp.send("Profiler.stop");
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); const dt = profile.timeDeltas; 
profile.samples.forEach((id, i) => { const n = byId.get(id); const key = `${(n.callFrame.url || "(native)").split("/").pop().slice(0, 28)} :: ${n.callFrame.functionName || "(anon)"}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0)); });
const byFile = new Map(); for (const [k, v] of self) { const f = k.split(" :: ")[0]; byFile.set(f, (byFile.get(f) ?? 0) + v); }
const total = [...byFile.values()].reduce((a, b) => a + b, 0);
console.log(`page ${P}: sampled main-thread time ${Math.round(total / 1000)} ms (CPU x4)`);
console.log("by file:"); for (const [f, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("  ", String(Math.round(v / 1000)).padStart(6), "ms", f);
console.log("top functions:"); for (const [f, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log("  ", String(Math.round(v / 1000)).padStart(6), "ms", f);
await browser.close();
