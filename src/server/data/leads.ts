import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { filterText } from "@/lib/search-params";
import type { Enums } from "@/types/database";

export const PAGE_SIZE = 25;

export type LeadFilters = {
  companyIds: string[];
  q: string | null;
  status: Enums<"lead_status"> | null;
  source: Enums<"lead_source"> | null;
  priority: Enums<"priority_level"> | null;
  interest: Enums<"lead_interest"> | null;
  offeringId: string | null;
  owner: "me" | "unassigned" | string | null;
  followUp: "overdue" | "today" | "upcoming" | null;
  archived: boolean;
  viewerId: string;
  /** Boundaries of "today" in the company zone, as ISO instants. */
  todayStart: string;
  todayEnd: string;
};

const SELECT = "id, company_id, title, status, priority, interest, auto_created, source, estimated_value, next_follow_up_at, last_activity_at, created_at, owner_id, archived_at, is_sandbox, contact:contacts!leads_contact_id_fkey(id, full_name, phone_e164), owner:profiles!leads_owner_id_fkey(full_name), offering:company_offerings!leads_offering_fk(name)";

/** Leads visible to the user (RLS) matching the filters. */
export function leadsQuery(supabase: ServerClient, f: LeadFilters, contactIds: string[] | null) {
  let q = supabase.from("leads").select(SELECT, { count: "exact" }).in("company_id", f.companyIds);
  q = f.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  if (f.status) q = q.eq("status", f.status);
  if (f.source) q = q.eq("source", f.source);
  if (f.priority) q = q.eq("priority", f.priority);
  if (f.interest) q = q.eq("interest", f.interest);
  if (f.offeringId) q = q.eq("offering_id", f.offeringId);
  if (f.owner === "me") q = q.eq("owner_id", f.viewerId);
  else if (f.owner === "unassigned") q = q.is("owner_id", null);
  else if (f.owner) q = q.eq("owner_id", f.owner);
  if (f.followUp === "overdue") q = q.lt("next_follow_up_at", f.todayStart);
  else if (f.followUp === "today") q = q.gte("next_follow_up_at", f.todayStart).lt("next_follow_up_at", f.todayEnd);
  else if (f.followUp === "upcoming") q = q.gte("next_follow_up_at", f.todayEnd);
  if (f.q) {
    const text = filterText(f.q);
    const ors = [`title.ilike.*${text}*`];
    if (contactIds && contactIds.length) ors.push(`contact_id.in.(${contactIds.join(",")})`);
    q = q.or(ors.join(","));
  }
  return q;
}

/** Contacts (visible to the user) whose name or phone matches free text. */
export async function matchingContactIds(supabase: ServerClient, text: string): Promise<string[]> {
  const t = filterText(text);
  if (t.length < 2) return [];
  const digits = t.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
  const ors = [`full_name.ilike.*${t}*`];
  if (digits.length >= 4) ors.push(`phone_e164.like.*${digits}*`);
  const { data } = await supabase.from("contacts").select("id").or(ors.join(",")).is("merged_into_id", null).limit(200);
  return (data ?? []).map((c) => c.id);
}
