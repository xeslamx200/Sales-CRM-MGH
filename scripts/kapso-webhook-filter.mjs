#!/usr/bin/env node
/**
 * Endpoint-only filter for a temporary tunnel to the Kapso webhook.
 *
 *   tunnel  ->  this filter (127.0.0.1:3211)  ->  Next.js (127.0.0.1:3210)
 *
 * The tunnel must point HERE, never at the app. Only `POST /api/webhooks/kapso`
 * (exact raw path, no query) is forwarded; everything else is answered by the
 * filter itself and never reaches the app. Fail closed: anything it cannot
 * validate is refused.
 *
 *   node scripts/kapso-webhook-filter.mjs        # 127.0.0.1:3211 -> 127.0.0.1:3210
 *
 * Logs only a reason code and a status: never paths beyond the fixed one, bodies,
 * headers, signatures, cookies or secrets. No dependencies.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

export const ALLOWED_PATH = "/api/webhooks/kapso";
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // same cap as the route
/** The only request headers the webhook handler needs. Everything else (cookies, authorization, ...) is dropped. */
export const FORWARDED_HEADERS = [
  "content-type", "x-webhook-signature", "x-webhook-event", "x-webhook-payload-version",
  "x-webhook-batch", "x-batch-size", "x-idempotency-key",
];
const SIGNATURE_SHAPE = /^[0-9a-fA-F]{64}$/;

/**
 * @param {{ upstreamPort?: number, upstreamTimeoutMs?: number, log?: (line: string) => void }} [opts]
 */
export function createFilter({ upstreamPort = 3210, upstreamTimeoutMs = 9000, log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const done = (status, reason, extra = {}) => {
      log(`${status} ${reason}`);
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", connection: "close", ...extra });
      res.end(status === 404 ? "not found" : String(reason));
    };

    // 1. Exact raw path. Any query, fragment, encoding, dot segment, case change, trailing slash or
    //    absolute-form target differs from the constant and is treated as an unknown route.
    if (req.url !== ALLOWED_PATH) return done(404, "path");
    // 2. Exact method.
    if (req.method !== "POST") return done(405, "method", { allow: "POST" });

    // 3. Cheap structural checks on the signature header (the app does the real verification).
    const sig = req.headers["x-webhook-signature"];
    if (typeof sig !== "string" || !SIGNATURE_SHAPE.test(sig.trim())) return done(401, "signature-shape");

    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      req.resume();
      return done(413, "too-large");
    }

    // 4. Buffer the body (bounded) so it is forwarded byte for byte; it is never parsed or modified.
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        done(413, "too-large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => { if (!aborted) { aborted = true; done(400, "client-error"); } });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const headers = { "content-length": String(body.length), connection: "close" };
      for (const name of FORWARDED_HEADERS) {
        const v = req.headers[name];
        if (typeof v === "string") headers[name] = v;
      }
      const up = http.request(
        { host: "127.0.0.1", port: upstreamPort, method: "POST", path: ALLOWED_PATH, headers, timeout: upstreamTimeoutMs },
        (ur) => {
          const out = { "cache-control": "no-store", connection: "close" };
          if (typeof ur.headers["content-type"] === "string") out["content-type"] = ur.headers["content-type"];
          log(`${ur.statusCode} forwarded`);
          res.writeHead(ur.statusCode ?? 502, out);
          ur.pipe(res);
        },
      );
      up.on("timeout", () => { up.destroy(); done(504, "upstream-timeout"); });
      up.on("error", () => done(502, "upstream-unavailable"));
      up.end(body);
    });
  });

  // Slowloris / stuck-client limits.
  server.headersTimeout = 5_000;
  server.requestTimeout = 12_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 1;
  return server;
}

/** Binds to loopback only; the address is not configurable on purpose. */
export function listenLoopback(server, port = 3211) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address()));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const upstreamPort = Number(process.env.KAPSO_UPSTREAM_PORT ?? 3210);
  const listenPort = Number(process.env.KAPSO_FILTER_PORT ?? 3211);
  const server = createFilter({ upstreamPort, log: (l) => console.log(new Date().toISOString(), l) });
  const addr = await listenLoopback(server, listenPort);
  console.log(`kapso filter listening on ${addr.address}:${addr.port} -> 127.0.0.1:${upstreamPort} (POST ${ALLOWED_PATH} only)`);
}
