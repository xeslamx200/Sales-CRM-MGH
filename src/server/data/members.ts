import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import type { Role } from "@/server/auth/viewer";

export type Member = {
  membershipId: string;
  companyId: string;
  userId: string;
  role: Role;
  isActive: boolean;
  fullName: string;
  email: string;
  profileActive: boolean;
};

/** Memberships (with profile) in the given companies, as visible under RLS. */
export async function listMembers(supabase: ServerClient, companyIds: string[], opts: { activeOnly?: boolean } = {}): Promise<Member[]> {
  if (companyIds.length === 0) return [];
  let q = supabase
    .from("company_memberships")
    .select("id, company_id, user_id, role, is_active, profile:profiles!company_memberships_user_id_fkey(full_name, email, is_active)")
    .in("company_id", companyIds);
  if (opts.activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? [])
    .map((m) => ({
      membershipId: m.id,
      companyId: m.company_id,
      userId: m.user_id,
      role: m.role,
      isActive: m.is_active,
      fullName: m.profile?.full_name || m.profile?.email || "—",
      email: m.profile?.email ?? "",
      profileActive: m.profile?.is_active ?? false,
    }))
    .filter((m) => !opts.activeOnly || m.profileActive)
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "ar"));
}

/** Distinct people (one option per user) for assignee/owner pickers. */
export function peopleOptions(members: Member[], companyId?: string | null): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const m of members) {
    if (companyId && m.companyId !== companyId) continue;
    if (!m.isActive || !m.profileActive) continue;
    if (!seen.has(m.userId)) seen.set(m.userId, m.fullName);
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}
