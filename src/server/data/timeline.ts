import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import type { Enums } from "@/types/database";

export type TimelineItem =
  | { kind: "created"; at: string; actor: string | null; automatic: boolean }
  | { kind: "status"; at: string; actor: string | null; from: Enums<"lead_status"> | null; to: Enums<"lead_status"> }
  | { kind: "assignment"; at: string; actor: string | null; from: string | null; to: string | null; reason: string | null }
  | { kind: "activity"; at: string; actor: string | null; type: Enums<"activity_type">; outcome: string | null; body: string | null; durationSeconds: number | null }
  | { kind: "task"; at: string; actor: string | null; id: string; title: string; status: Enums<"task_status">; dueAt: string | null; assignee: string | null; completedAt: string | null; completedBy: string | null; outcome: string | null }
  | { kind: "conversation"; at: string; actor: null; id: string; lastMessageAt: string | null; unread: number; status: Enums<"conversation_status"> };

/** Display names for user ids (only profiles visible under RLS resolve). */
async function names(supabase: ServerClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase.from("profiles").select("id, full_name, email").in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.full_name || p.email || "—"]));
}

const byTimeDesc = (a: TimelineItem, b: TimelineItem) => Date.parse(b.at) - Date.parse(a.at);

/** Everything that happened on a lead, newest first. */
export async function leadTimeline(
  supabase: ServerClient,
  lead: { id: string; company_id: string; contact_id: string; created_at: string; created_by: string | null; auto_created: boolean },
): Promise<TimelineItem[]> {
  const [status, assigns, acts, tasks, convs] = await Promise.all([
    supabase.from("lead_status_history").select("from_status, to_status, changed_by, created_at").eq("lead_id", lead.id),
    supabase.from("lead_assignments").select("from_user_id, to_user_id, assigned_by, reason, created_at").eq("lead_id", lead.id),
    supabase.from("activities").select("type, actor_id, occurred_at, outcome, body, duration_seconds").eq("lead_id", lead.id),
    supabase.from("tasks").select("id, title, status, due_at, assigned_to, created_by, created_at, completed_at, completed_by, outcome").eq("lead_id", lead.id),
    supabase.from("conversations").select("id, status, last_message_at, unread_count, created_at")
      .eq("contact_id", lead.contact_id).eq("company_id", lead.company_id),
  ]);

  const who = await names(supabase, [
    lead.created_by,
    ...(status.data ?? []).map((s) => s.changed_by),
    ...(assigns.data ?? []).flatMap((a) => [a.from_user_id, a.to_user_id, a.assigned_by]),
    ...(acts.data ?? []).map((a) => a.actor_id),
    ...(tasks.data ?? []).flatMap((t) => [t.assigned_to, t.created_by, t.completed_by]),
  ]);
  const n = (id: string | null | undefined) => (id ? who.get(id) ?? "—" : null);

  const items: TimelineItem[] = [{ kind: "created", at: lead.created_at, actor: n(lead.created_by), automatic: lead.auto_created }];
  // The first status row is the initial "new" set on insert; it duplicates "created".
  for (const s of status.data ?? []) {
    if (s.from_status === null) continue;
    items.push({ kind: "status", at: s.created_at, actor: n(s.changed_by), from: s.from_status, to: s.to_status });
  }
  for (const a of assigns.data ?? []) {
    items.push({ kind: "assignment", at: a.created_at, actor: n(a.assigned_by), from: n(a.from_user_id), to: n(a.to_user_id), reason: a.reason });
  }
  for (const a of acts.data ?? []) {
    items.push({ kind: "activity", at: a.occurred_at, actor: n(a.actor_id), type: a.type, outcome: a.outcome, body: a.body, durationSeconds: a.duration_seconds });
  }
  for (const t of tasks.data ?? []) {
    items.push({
      kind: "task", at: t.completed_at ?? t.created_at, actor: n(t.completed_by ?? t.created_by), id: t.id, title: t.title,
      status: t.status, dueAt: t.due_at, assignee: n(t.assigned_to), completedAt: t.completed_at,
      completedBy: n(t.completed_by), outcome: t.outcome,
    });
  }
  for (const c of convs.data ?? []) {
    items.push({ kind: "conversation", at: c.last_message_at ?? c.created_at, actor: null, id: c.id, lastMessageAt: c.last_message_at, unread: c.unread_count, status: c.status });
  }
  return items.sort(byTimeDesc);
}

