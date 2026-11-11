import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/server/supabase/server";
import { requestI18n } from "@/server/i18n";
import { exportResponse, type ExportRow } from "@/server/bookings-export";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bookings of one workshop as CSV or Excel. Loaded with the caller's own session through workshop_bookings_list, so company isolation and the
 * visibility rule (managers and admins every booking of the company, others their own) are enforced by the database, not here.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/export/workshop/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const group = url.searchParams.get("group");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: off } = await supabase.from("company_offerings").select("id, name, company_id").eq("id", id).maybeSingle();
  if (!off) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data: company } = await supabase.from("companies").select("timezone").eq("id", off.company_id).maybeSingle();
  const { data, error } = await supabase.rpc("workshop_bookings_list", { p_offering_id: id, p_group_id: group && UUID.test(group) ? group : undefined });
  if (error) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { t, locale, dir } = await requestI18n();
  return exportResponse(format, off.name, (data ?? []) as ExportRow[], t, locale, company?.timezone ?? "UTC", dir === "rtl");
}
