import { NextResponse } from "next/server";
import { createClient } from "@/server/supabase/server";
import { getViewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";

/**
 * A very small answer for the live inbox: the time of the latest message and how many conversations are unread, for the conversations this
 * person may see in the active company (RLS decides). The browser compares it with the previous answer and refreshes the page when it changes,
 * so a new WhatsApp message shows up without a manual refresh. No message text, name or number is ever returned here.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse(null, { status: 401 });
  const viewer = await getViewer();
  const ids = viewer.scopeCompanyIds;
  if (ids.length === 0) return NextResponse.json({ token: "0|0" }, { headers: { "Cache-Control": "no-store" } });
  const [latest, unread] = await Promise.all([
    supabase.from("conversations").select("last_message_at").in("company_id", ids).not("last_message_at", "is", null)
      .order("last_message_at", { ascending: false }).limit(1),
    supabase.from("conversations").select("id", { count: "exact", head: true }).in("company_id", ids).gt("unread_count", 0),
  ]);
  if (latest.error || unread.error) return NextResponse.json({ token: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ token: `${latest.data?.[0]?.last_message_at ?? "0"}|${unread.count ?? 0}` }, { headers: { "Cache-Control": "no-store" } });
}
