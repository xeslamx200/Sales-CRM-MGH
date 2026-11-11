import { after, NextResponse, type NextRequest } from "next/server";
import { handleKapsoWebhookHttp } from "@/lib/kapso/webhook-http.ts";
import { createKapsoStore, createKapsoStoreV2Server } from "@/server/whatsapp/kapso-store";
import { serverEnv } from "@/server/env";
import { prefetchKapsoMedia } from "@/server/whatsapp/kapso-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kapso deliveries (payload v2). POST only: any other method is answered 405
 * by Next. Every answer is decided in src/lib/kapso/webhook-http.ts (unit
 * tested): the signature is verified over the RAW bytes before anything is
 * parsed or stored; the account and its company are resolved from the
 * phone_number_id by the database wrappers, never taken from the request;
 * 200 means every item has a durable state (processed, duplicate, recorded for
 * our retry job, or quarantined), 503 that something could not be recorded.
 * Protocol: KAPSO_PROTOCOL (v1 default = sandbox path; v2 must be explicit
 * for production accounts, see src/lib/kapso/protocol.ts).
 */
export async function POST(request: NextRequest) {
  const r = await handleKapsoWebhookHttp(request, {
    config: () => {
      const cfg = serverEnv("kapso");
      serverEnv("serviceRole");
      return { secret: cfg.KAPSO_WEBHOOK_SECRET, protocol: cfg.KAPSO_PROTOCOL };
    },
    storeV1: createKapsoStore,
    storeV2: createKapsoStoreV2Server,
    log: (line) => console.warn("[kapso-webhook]", JSON.stringify(line)),
    // the file of a received image / voice note / sticker is copied to private Storage right after the response (best effort; also fetched on first view)
    onMedia: (waMessageId) => after(() => prefetchKapsoMedia(waMessageId)),
  });
  return typeof r.body === "string"
    ? new NextResponse(r.body, { status: r.status })
    : NextResponse.json(r.body, { status: r.status });
}
