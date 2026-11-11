import { NextResponse, type NextRequest } from "next/server";
import { handleWebhookPost } from "@/lib/whatsapp/processor.ts";
import { verifySubscriptionChallenge } from "@/lib/whatsapp/signature.ts";
import { createWebhookStore } from "@/server/whatsapp/store";
import { serverEnv } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta's subscription handshake (constant-time token check). */
export async function GET(request: NextRequest) {
  let verifyToken: string;
  try {
    verifyToken = serverEnv("whatsapp").WHATSAPP_VERIFY_TOKEN;
  } catch {
    return new NextResponse("not configured", { status: 503 });
  }
  const result = verifySubscriptionChallenge(request.nextUrl.searchParams, verifyToken);
  if (!result.ok) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(result.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Webhook deliveries. The signature is verified over the RAW body before
 * anything is parsed or stored (src/lib/whatsapp/processor.ts). Per-event
 * failures are recorded for our own retry job and still answer 200, so Meta
 * doesn't redeliver the whole batch; 503 only when storage is unavailable.
 */
export async function POST(request: NextRequest) {
  let appSecret: string;
  try {
    appSecret = serverEnv("whatsapp").WHATSAPP_APP_SECRET;
    serverEnv("serviceRole");
  } catch {
    return new NextResponse("not configured", { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > 1_000_000) return new NextResponse("payload too large", { status: 413 });
  const outcome = await handleWebhookPost(raw, request.headers.get("x-hub-signature-256"), appSecret, createWebhookStore());
  if (outcome.failed > 0 || outcome.parseErrors.length > 0) {
    // Counts and stable codes only: never message content.
    console.warn("[whatsapp-webhook]", { processed: outcome.processed, duplicates: outcome.duplicates, failed: outcome.failed, parseErrors: outcome.parseErrors.slice(0, 5) });
  }
  return NextResponse.json({ ok: outcome.httpStatus === 200 }, { status: outcome.httpStatus });
}
