import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/server/supabase/server";
import { can, getViewer } from "@/server/auth/viewer";
import { leadsQuery, matchingContactIds } from "@/server/data/leads";
import { todayBounds } from "@/server/crm";
import { toCsv } from "@/lib/csv.ts";
import { limitUser } from "@/server/rate-limit";
import { userMessage } from "@/lib/errors.ts";
import { formatDateTime } from "@/lib/format.ts";
import { Constants } from "@/types/database";

const MAX_EXPORT_ROWS = 10_000;
const E = Constants.public.Enums;

/**
 * CSV export of the leads list with the same filters as the screen.
 * Permission-checked by RLS: it runs with the user's session, so a user can
 * only ever export rows they can already see. Cells are protected against
 * formula injection (src/lib/csv.ts).
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  const supabase = await createClient();
  try {
    await limitUser(supabase, "export");
  } catch {
    return new NextResponse(userMessage("rate_limited", viewer.locale), { status: 429, headers: { "Retry-After": "600" } });
  }
  const sp = request.nextUrl.searchParams;
  const pick = <T extends string>(k: string, allowed: readonly T[]) => {
    const v = sp.get(k);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  };
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const today = todayBounds(tz);
  const q = sp.get("q")?.slice(0, 100) ?? null;
  const filters = {
    companyIds: viewer.scopeCompanyIds.filter((id) => can(viewer, id, "export_data")),   // a custom role can switch exporting off
    q,
    status: pick("status", E.lead_status),
    source: pick("source", E.lead_source),
    priority: pick("priority", E.priority_level),
    interest: pick("interest", E.lead_interest),
    offeringId: /^[0-9a-f-]{36}$/i.test(sp.get("offering") ?? "") ? sp.get("offering") : null,
    owner: sp.get("owner")?.slice(0, 40) ?? null,
    followUp: pick("followup", ["overdue", "today", "upcoming"] as const),
    archived: sp.get("archived") === "1",
    viewerId: viewer.id,
    todayStart: today.start,
    todayEnd: today.end,
  };
  const contactIds = q ? await matchingContactIds(supabase, q) : null;

  const rows: unknown[][] = [];
  const { t, locale } = viewer;
  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  for (let from = 0; from < MAX_EXPORT_ROWS; from += 1000) {
    const { data, error } = await leadsQuery(supabase, filters, contactIds)
      .order("created_at", { ascending: false }).range(from, from + 999);
    if (error) return NextResponse.json({ error: "export_failed" }, { status: 500 });
    for (const l of data ?? []) {
      rows.push([
        l.title, l.contact?.full_name ?? "", l.contact?.phone_e164 ?? "", companyName.get(l.company_id) ?? "",
        t.enums.leadStatus[l.status], t.enums.priority[l.priority], l.auto_created ? t.autoLeads.automatic : t.enums.leadSource[l.source],
        t.enums.leadInterest[l.interest], l.offering?.name ?? "",
        l.owner?.full_name ?? "", l.estimated_value ?? "",
        l.next_follow_up_at ? formatDateTime(l.next_follow_up_at, tz, locale) : "",
        formatDateTime(l.created_at, tz, locale),
      ]);
    }
    if (!data || data.length < 1000) break;
  }
  const csv = toCsv([
    t.common.title, t.leads.contactName, t.common.phone, t.common.company, t.common.status, t.leads.priority,
    t.leads.source, t.autoLeads.interest, t.autoLeads.offering, t.common.owner, t.leads.estimatedValue, t.leads.nextFollowUp, t.common.createdAt,
  ], rows);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
