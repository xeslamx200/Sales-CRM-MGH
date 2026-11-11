import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/server/supabase/server";
import { requestI18n } from "@/server/i18n";
import { exportResponse, type ExportRow } from "@/server/bookings-export";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["paid", "partially_paid", "unpaid", "pending_approval", "rejected", "cancelled"];

/** Customer payments (every visible booking with its money) as CSV or Excel, with the same filters as the page. Loaded with the caller's own session. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const p = url.searchParams;
  const company = p.get("company");
  if (!company || !UUID.test(company)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const status = p.get("status");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: co } = await supabase.from("companies").select("name, timezone").eq("id", company).maybeSingle();
  if (!co) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data, error } = await supabase.rpc("customer_payment_rows", {
    p_company_id: company,
    p_offering_id: p.get("offering") && UUID.test(p.get("offering")!) ? p.get("offering")! : undefined,
    p_group_id: p.get("group") && UUID.test(p.get("group")!) ? p.get("group")! : undefined,
    p_status: status && STATUSES.includes(status) ? status : undefined,
    p_currency: p.get("currency")?.match(/^[A-Za-z]{3}$/) ? p.get("currency")! : undefined,
    p_from: p.get("from") && DAY.test(p.get("from")!) ? p.get("from")! : undefined,
    p_to: p.get("to") && DAY.test(p.get("to")!) ? p.get("to")! : undefined,
  });
  if (error) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = (p.get("customer") ?? "").trim().toLowerCase();
  const rows = (data ?? []).filter((r) => !q || r.customer_name.toLowerCase().includes(q)).map((r) => ({ ...r, email: null })) as ExportRow[];
  const { t, locale, dir } = await requestI18n();
  return exportResponse(p.get("format") === "xlsx" ? "xlsx" : "csv", `${t.bookings.customerPayments}-${co.name}`, rows, t, locale, co.timezone ?? "UTC", dir === "rtl");
}
