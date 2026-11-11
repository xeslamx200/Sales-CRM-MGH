// SCRATCH-ONLY test gateway for the real Next.js app: a tiny stand-in for the Supabase API gateway, so the app can run against a disposable PostgREST + scratch
// Postgres (never Staging, never the shared local stack).
//   /rest/v1/*  -> PostgREST (PGRST_URL), the user's JWT is forwarded untouched (RLS and the SECURITY DEFINER functions do the real work)
//   /auth/v1/*  -> a minimal GoTrue stand-in: password sign-in (any known profile e-mail + TEST_PASSWORD), user, refresh, logout
// Users are the fixture profiles of the scratch database. Tokens are HS256 JWTs signed with JWT_SECRET (the same secret PostgREST uses).
// Usage: JWT_SECRET=... PGRST_URL=http://127.0.0.1:3300 PORT=3301 node tests/scratch-ui/gateway.mjs
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SECRET = process.env.JWT_SECRET ?? "";
const PGRST = process.env.PGRST_URL ?? "http://127.0.0.1:3300";
const PORT = Number(process.env.PORT ?? 3301);
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "test-pass-123";
if (SECRET.length < 32) { console.error("JWT_SECRET (>= 32 chars) is required"); process.exit(1); }

const b64 = (b) => Buffer.from(b).toString("base64url");
const sign = (claims) => {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64(JSON.stringify(claims));
  return `${head}.${body}.${crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
};
const verify = (tok) => {
  const [h, p, s] = String(tok ?? "").split(".");
  if (!h || !p || !s) return null;
  const exp = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  const c = JSON.parse(Buffer.from(p, "base64url").toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
};
const SERVICE = sign({ role: "service_role", iss: "scratch", exp: Math.floor(Date.now() / 1000) + 86400 * 30 });
export const ANON = sign({ role: "anon", iss: "scratch", exp: Math.floor(Date.now() / 1000) + 86400 * 30 });

async function profileByEmail(email) {
  const r = await fetch(`${PGRST}/profiles?select=id,email,full_name&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: { Authorization: `Bearer ${SERVICE}` } });
  const j = await r.json();
  return Array.isArray(j) ? j[0] : null;
}
async function profileById(id) {
  const r = await fetch(`${PGRST}/profiles?select=id,email,full_name&id=eq.${encodeURIComponent(id)}&limit=1`, { headers: { Authorization: `Bearer ${SERVICE}` } });
  const j = await r.json();
  return Array.isArray(j) ? j[0] : null;
}
const userJson = (p) => ({ id: p.id, aud: "authenticated", role: "authenticated", email: p.email, email_confirmed_at: "2026-01-01T00:00:00Z", phone: "", confirmed_at: "2026-01-01T00:00:00Z",
  last_sign_in_at: new Date().toISOString(), app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { full_name: p.full_name ?? "" }, identities: [],
  created_at: "2026-01-01T00:00:00Z", updated_at: new Date().toISOString(), is_anonymous: false });
function session(p) {
  const now = Math.floor(Date.now() / 1000), exp = now + 3600;
  const claims = { aud: "authenticated", exp, iat: now, iss: `http://127.0.0.1:${PORT}/auth/v1`, sub: p.id, email: p.email, phone: "", app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: p.full_name ?? "" }, role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: now }], session_id: crypto.randomUUID(), is_anonymous: false };
  return { access_token: sign(claims), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: b64(JSON.stringify({ id: p.id })), user: userJson(p) };
}
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/auth/v1/")) {
      const route = url.pathname.slice("/auth/v1/".length);
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString() || "{}") : {};
      if (route === "token" && url.searchParams.get("grant_type") === "password") {
        const p = await profileByEmail(String(body.email ?? "").toLowerCase());
        if (!p || body.password !== TEST_PASSWORD) return json(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return json(res, 200, session(p));
      }
      if (route === "token" && url.searchParams.get("grant_type") === "refresh_token") {
        let id; try { id = JSON.parse(Buffer.from(String(body.refresh_token), "base64url").toString()).id; } catch { /* invalid */ }
        const p = id ? await profileById(id) : null;
        return p ? json(res, 200, session(p)) : json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      }
      // Auth Admin API stand-in (scratch only): create / update / delete a user. The password is stored as "scratch:<password>" so a test can see
      // that the request carried it; sign-in in this gateway accepts TEST_PASSWORD for any known profile.
      if (route.startsWith("admin/users")) {
        const isService = verify((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))?.role === "service_role";
        if (!isService) return json(res, 401, { code: 401, error_code: "not_admin", msg: "not admin" });
        const psql = (q) => execFileSync("docker", ["exec", "kapso-rev6-scratch-pg", "psql", "-U", "postgres", "-d", process.env.UI_DB ?? "kapso_ui_scratch", "-qAt", "-c", q], { encoding: "utf8" }).trim();
        const esc = (v) => String(v ?? "").replace(/'/g, "''");
        const id = route.split("/")[2];
        if (req.method === "POST" && !id) {
          const exists = psql(`select count(*) from auth.users where lower(email) = lower('${esc(body.email)}')`) !== "0";
          if (exists) return json(res, 422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
          const newId = psql(`insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('${esc(body.email)}', 'scratch:${esc(body.password)}', '${esc(JSON.stringify(body.user_metadata ?? {}))}'::jsonb) returning id`).split(String.fromCharCode(10))[0];
          return json(res, 200, { id: newId, aud: "authenticated", role: "authenticated", email: body.email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: new Date().toISOString() });
        }
        if (req.method === "PUT" && id) {
          if (body.email) {
            if (psql(`select count(*) from auth.users where lower(email) = lower('${esc(body.email)}') and id <> '${esc(id)}'`) !== "0") return json(res, 422, { code: 422, error_code: "email_exists", msg: "already been registered" });
            psql(`update auth.users set email = '${esc(body.email)}' where id = '${esc(id)}'`);
          }
          if (body.password) psql(`update auth.users set encrypted_password = 'scratch:${esc(body.password)}' where id = '${esc(id)}'`);
          return json(res, 200, { id, email: body.email ?? "", aud: "authenticated", role: "authenticated", user_metadata: {}, app_metadata: {} });
        }
        if (req.method === "DELETE" && id) { psql(`delete from auth.users where id = '${esc(id)}'`); return json(res, 200, {}); }
        return json(res, 404, { msg: "not implemented in the scratch gateway" });
      }
      if (route === "user") {
        const c = verify((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
        const p = c?.sub ? await profileById(c.sub) : null;
        return p ? json(res, 200, userJson(p)) : json(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      if (route === "logout") { res.writeHead(204); return res.end(); }
      if (route === ".well-known/jwks.json") return json(res, 200, { keys: [] });
      return json(res, 404, { msg: "not implemented in the scratch gateway" });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const raw = await readBody(req);
      const headers = {};
      for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile", "x-client-info"]) if (req.headers[k]) headers[k] = req.headers[k];
      if (!headers.authorization || /^Bearer\s*$/.test(headers.authorization)) headers.authorization = `Bearer ${ANON}`;
      const r = await fetch(`${PGRST}/${url.pathname.slice("/rest/v1/".length)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
      const out = {};
      for (const k of ["content-type", "content-range", "preference-applied", "location"]) if (r.headers.get(k)) out[k] = r.headers.get(k);
      res.writeHead(r.status, out);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url.pathname === "/anon-key") return json(res, 200, { anon: ANON, service: SERVICE });   // local helper for the launcher only
    json(res, 404, { msg: "scratch gateway: not found" });
  } catch (e) {
    console.error("gateway error", String(e).slice(0, 200));
    json(res, 502, { msg: "gateway error" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`scratch gateway on http://127.0.0.1:${PORT} -> ${PGRST}`));
