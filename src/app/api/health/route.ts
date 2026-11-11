import { NextResponse } from "next/server";
import { parseEnv, publicSchema, serverSchemas } from "@/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public liveness/readiness check for deploy smoke tests and uptime
 * monitors. Reports only ok/failed per component — never values, versions
 * of secrets or data.
 */
export async function GET() {
  const checks: Record<string, boolean> = {};
  let url = "";
  let anon = "";
  try {
    ({ NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon } = parseEnv(publicSchema, process.env));
    parseEnv(serverSchemas.core, process.env);
    checks.config = true;
  } catch {
    checks.config = false;
  }
  for (const [name, schema] of [["service_role", serverSchemas.serviceRole], ["whatsapp", serverSchemas.whatsapp]] as const) {
    try {
      parseEnv(schema, process.env);
      checks[`${name}_configured`] = true;
    } catch {
      checks[`${name}_configured`] = false;
    }
  }
  if (checks.config) {
    try {
      const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anon }, signal: AbortSignal.timeout(5000), cache: "no-store" });
      checks.supabase = res.ok;
    } catch {
      checks.supabase = false;
    }
  }
  const ok = checks.config && checks.supabase === true;
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
