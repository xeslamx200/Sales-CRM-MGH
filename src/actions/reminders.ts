"use server";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";

export type DueReminder = { id: string; title: string; description: string | null; dueAt: string; leadId: string | null; contactId: string | null };

/** My open tasks (reminders) whose time has come. Read with the user's session: row-level security decides what is theirs to see. */
export async function dueReminders(): Promise<DueReminder[]> {
  const viewer = await getViewer();
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks")
    .select("id, title, description, due_at, lead_id, contact_id")
    .eq("assigned_to", viewer.id).in("status", ["open", "in_progress"])
    .not("due_at", "is", null).lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true }).limit(8);
  if (error) return [];
  return (data ?? []).map((r) => ({ id: r.id, title: r.title, description: r.description, dueAt: r.due_at as string, leadId: r.lead_id, contactId: r.contact_id }));
}
