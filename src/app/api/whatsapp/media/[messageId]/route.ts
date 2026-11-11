import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/server/supabase/server";
import { mediaUrlForMessage } from "@/server/whatsapp/media";
import { limitUser } from "@/server/rate-limit";
import { errorKey } from "@/lib/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Media of a WhatsApp message. The user's session decides visibility (RLS on
 * messages); the file itself is served by Storage through a 60-second signed
 * URL (images/audio/video inline, everything else as a download).
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/whatsapp/media/[messageId]">) {
  const { messageId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  // local check of the session token (signature + expiry); RLS and the database functions decide what may be read
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await limitUser(supabase, "media_view");
    const { url } = await mediaUrlForMessage(messageId);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const key = errorKey(err);
    const status = key === "rate_limited" ? 429 : key === "media.too_large" ? 413 : 404;
    return NextResponse.json({ error: key }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
