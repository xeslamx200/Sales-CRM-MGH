import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/server/supabase/server";
import { attachmentUrl } from "@/server/attachments";
import { errorKey } from "@/lib/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download/preview of a record attachment. RLS on `attachments` (with the
 * user's session) decides visibility; the file is served by Storage through a
 * 60-second signed URL (images inline, everything else as a download).
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/attachments/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const url = await attachmentUrl(id);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const key = errorKey(err);
    return NextResponse.json({ error: key }, { status: key === "rate_limited" ? 429 : 404, headers: { "Cache-Control": "no-store" } });
  }
}
