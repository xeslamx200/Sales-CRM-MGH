import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHmac } from "node:crypto";
import { createFilter, listenLoopback, MAX_BODY_BYTES } from "../../scripts/kapso-webhook-filter.mjs";
import { verifyKapsoSignature } from "../../src/lib/kapso/signature.ts";

// Throw-away constant; never a real secret.
const SECRET = "filter-test-secret-0123456789abcdef";
const sign = (b: Buffer | string) => createHmac("sha256", SECRET).update(b).digest("hex");

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
let seen: Seen[] = [];
let upstreamMode: "ok" | "unauthorized" | "slow" = "ok";
let upstream: http.Server;
let filter: http.Server;
let filterPort = 0;
let upstreamPort = 0;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      if (upstreamMode === "slow") return; // never answers
      if (upstreamMode === "unauthorized") { res.writeHead(401, { "content-type": "application/json" }); return void res.end('{"ok":false}'); }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "leak=1", "x-powered-by": "x" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  filter = createFilter({ upstreamPort, upstreamTimeoutMs: 400 });
  filterPort = ((await listenLoopback(filter, 0)) as net.AddressInfo).port;
});
after(() => { filter.close(); upstream.close(); upstream.closeAllConnections?.(); });

/** Raw HTTP so malformed or unusual request lines are sent exactly as written. */
function raw(requestLine: string, headers: string[] = [], body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const s = net.connect(filterPort, "127.0.0.1");
    let data = "";
    s.on("data", (d) => (data += d));
    const finish = () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), text: data });
    s.on("close", finish);
    s.on("error", finish);
    s.write(`${requestLine}\r\nHost: x\r\n${headers.join("\r\n")}${headers.length ? "\r\n" : ""}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    setTimeout(() => s.destroy(), 1500);
  });
}
const goodHeaders = (body: string) => ["X-Webhook-Signature: " + sign(body), "X-Webhook-Event: whatsapp.message.received", "X-Webhook-Payload-Version: v2"];

test("the filter is bound to loopback only", () => {
  const a = filter.address() as net.AddressInfo;
  assert.equal(a.address, "127.0.0.1");
});

test("the exact POST is forwarded byte for byte, so the signature still verifies", async () => {
  seen = [];
  const body = JSON.stringify({ message: { id: "wamid.X", text: { body: "مرحبا ✓" } }, spaced:   "keeps   spacing" });
  const res = await fetch(`http://127.0.0.1:${filterPort}/api/webhooks/kapso`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-webhook-signature": sign(body), "x-webhook-event": "whatsapp.message.received", "x-webhook-payload-version": "v2", "x-idempotency-key": "k1" },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}', "response body preserved");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/webhooks/kapso");
  assert.equal(seen[0].body.toString("utf8"), body, "exact bytes");
  assert.equal(verifyKapsoSignature(seen[0].body, String(seen[0].headers["x-webhook-signature"]), SECRET), true, "signature verifies on what the app receives");
  for (const h of ["x-webhook-event", "x-webhook-payload-version", "x-idempotency-key", "content-type"]) assert.ok(seen[0].headers[h], h);
});

test("only the needed headers are forwarded; cookies and authorization are dropped, and response headers are not leaked", async () => {
  seen = [];
  const body = "{}";
  const r = await raw("POST /api/webhooks/kapso HTTP/1.1", [...goodHeaders(body), "Cookie: session=abc", "Authorization: Bearer abc", "X-Forwarded-For: 1.2.3.4", "X-Evil: 1"], body);
  assert.equal(r.status, 200);
  for (const h of ["cookie", "authorization", "x-forwarded-for", "x-evil"]) assert.equal(seen[0].headers[h], undefined, h);
  assert.equal(/set-cookie|x-powered-by/i.test(r.text), false, "upstream's cookies and server headers are not passed back");
});

test("upstream status and body are preserved (401 stays 401)", async () => {
  seen = []; upstreamMode = "unauthorized";
  const body = "{}";
  const r = await raw("POST /api/webhooks/kapso HTTP/1.1", goodHeaders(body), body);
  upstreamMode = "ok";
  assert.equal(r.status, 401);
  assert.match(r.text, /\{"ok":false\}/);
  assert.equal(seen.length, 1);
});

const BLOCKED_PATHS = [
  "/", "/login", "/inbox", "/api/health", "/api/webhooks/whatsapp", "/api/cron/whatsapp-retry", "/_next/static/x.js",
  "/api/webhooks/kapso/", "/api/webhooks/kapso//", "//api/webhooks/kapso", "/api/webhooks/Kapso", "/API/webhooks/kapso",
  "/api/webhooks/kapso?x=1", "/api/webhooks/kapso?", "/api/webhooks/kapso#frag", "/api/webhooks/kapso;a=1",
  "/api/webhooks/kapso%2F", "/api/webhooks/kapso%00", "/api/webhooks/%6Bapso", "/api/webhooks%2Fkapso", "/api%2Fwebhooks/kapso",
  "/api/webhooks/kapso/../whatsapp", "/api/webhooks/./kapso", "/api/webhooks/kapso/.", "/api/webhooks/x/../kapso",
  "http://evil.test/api/webhooks/kapso", "*", "", "/api/webhooks/kapso\\", "/api/webhooks/kapso.json",
];
test("every other path is a 404 and never reaches the app (any method)", async () => {
  seen = [];
  const body = "{}";
  for (const method of ["POST", "GET"]) {
    for (const p of BLOCKED_PATHS) {
      const r = await raw(`${method} ${p} HTTP/1.1`, goodHeaders(body), body);
      // A request line the HTTP parser itself refuses (400) is also blocked; it must never be forwarded.
      assert.ok([404, 400].includes(r.status) || r.status === 0, `${method} ${JSON.stringify(p)} -> ${r.status}`);
    }
  }
  assert.equal(seen.length, 0, "nothing was forwarded");
});

test("malformed request lines are refused and never forwarded", async () => {
  seen = [];
  for (const line of ["POST", "POST /api/webhooks/kapso", "POST /api/webhooks/kapso HTTP/9.9", "\u0000 / HTTP/1.1", "POST /api/webhooks/kapso\r\n/../ HTTP/1.1"]) {
    const r = await raw(line);
    // (A request line Node tolerates as the exact path, e.g. without a version, still hits the filter's own checks: 401 here, never forwarded.)
    assert.ok([400, 401, 404, 0, 505].includes(r.status), `${JSON.stringify(line)} -> ${r.status}`);
  }
  assert.equal(seen.length, 0);
});

test("other methods on the webhook path are 405 with Allow: POST and are not forwarded", async () => {
  seen = [];
  for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE", "CONNECT", "PROPFIND"]) {
    const r = await raw(`${method} /api/webhooks/kapso HTTP/1.1`);
    // CONNECT is parsed by Node as a tunnel request and never reaches the handler.
    if (method === "CONNECT") { assert.notEqual(r.status, 200); continue; }
    assert.equal(r.status, 405, method);
    if (method !== "HEAD") assert.match(r.text, /allow: POST/i, method);
  }
  assert.equal(seen.length, 0);
});

test("missing or malformed signature headers are refused by the filter (401) without reaching the app", async () => {
  seen = [];
  const body = "{}";
  const noSig = await raw("POST /api/webhooks/kapso HTTP/1.1", ["X-Webhook-Event: whatsapp.message.received"], body);
  const short = await raw("POST /api/webhooks/kapso HTTP/1.1", ["X-Webhook-Signature: abc123"], body);
  const prefixed = await raw("POST /api/webhooks/kapso HTTP/1.1", ["X-Webhook-Signature: sha256=" + sign(body)], body);
  assert.deepEqual([noSig.status, short.status, prefixed.status], [401, 401, 401]);
  assert.equal(seen.length, 0);
});

test("oversized bodies are refused (declared and streamed) and not forwarded", async () => {
  seen = [];
  const declared = await raw("POST /api/webhooks/kapso HTTP/1.1", [`X-Webhook-Signature: ${sign("x")}`], "x".repeat(MAX_BODY_BYTES + 1));
  assert.ok([413, 0].includes(declared.status), `declared ${declared.status}`); // 0 = connection cut while the client was still sending
  // Chunked, no Content-Length: cut off while streaming.
  const streamed = await new Promise<number>((resolve) => {
    const s = net.connect(filterPort, "127.0.0.1");
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    s.on("error", () => resolve(0));
    s.write(`POST /api/webhooks/kapso HTTP/1.1\r\nHost: x\r\nX-Webhook-Signature: ${sign("x")}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const pump = () => { while (sent < 3 * 1024 * 1024 && !s.destroyed) { s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`); sent += chunk.length; if (s.writableLength > 1 << 20) return void s.once("drain", pump); } };
    pump();
    setTimeout(() => s.destroy(), 3000);
  });
  assert.ok([413, 0].includes(streamed), `streamed ${streamed}`);
  assert.equal(seen.length, 0);
  // A body just under the limit goes through.
  const ok = Buffer.alloc(MAX_BODY_BYTES - 10, "a").toString();
  const res = await fetch(`http://127.0.0.1:${filterPort}/api/webhooks/kapso`, { method: "POST", body: ok, headers: { "x-webhook-signature": sign(ok) } });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.length, MAX_BODY_BYTES - 10);
});

test("conflicting or invalid Content-Length is refused", async () => {
  seen = [];
  const body = "{}";
  const r = await new Promise<number>((resolve) => {
    const s = net.connect(filterPort, "127.0.0.1");
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    s.on("error", () => resolve(0));
    s.write(`POST /api/webhooks/kapso HTTP/1.1\r\nHost: x\r\nX-Webhook-Signature: ${sign(body)}\r\nContent-Length: 2\r\nContent-Length: 40\r\nConnection: close\r\n\r\n${body}`);
    setTimeout(() => s.destroy(), 1500);
  });
  assert.ok(r === 400 || r === 0, `status ${r}`);
  assert.equal(seen.length, 0);
});

test("a slow upstream answers 504 and an unreachable upstream answers 502 (fail closed)", async () => {
  const body = "{}";
  upstreamMode = "slow";
  const slow = await raw("POST /api/webhooks/kapso HTTP/1.1", goodHeaders(body), body);
  upstreamMode = "ok";
  assert.equal(slow.status, 504);
  const dead = createFilter({ upstreamPort: 1 });
  const port = ((await listenLoopback(dead, 0)) as net.AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/kapso`, { method: "POST", body, headers: { "x-webhook-signature": sign(body) } });
  assert.equal(res.status, 502);
  dead.close();
});

test("the filter logs only reason codes and statuses", async () => {
  const lines: string[] = [];
  const f = createFilter({ upstreamPort, log: (l: string) => lines.push(l) });
  const port = ((await listenLoopback(f, 0)) as net.AddressInfo).port;
  const body = '{"secret":"customer words"}';
  await fetch(`http://127.0.0.1:${port}/api/webhooks/kapso`, { method: "POST", body, headers: { "x-webhook-signature": sign(body), cookie: "s=1" } });
  await fetch(`http://127.0.0.1:${port}/login?token=abc`);
  f.close();
  const all = lines.join("\n");
  assert.equal(/customer|abc|login|cookie|[0-9a-f]{64}/i.test(all), false, all);
  assert.deepEqual(lines, ["200 forwarded", "404 path"]);
});
