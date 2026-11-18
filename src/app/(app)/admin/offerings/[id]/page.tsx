import { notFound } from "next/navigation";
import { canAdmin, getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { WorkshopConfigView } from "./workshop-config-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The groups of one workshop (the price is typed on each booking; the price table is hidden). Company admins only; the database enforces every write. */
export default async function WorkshopConfigPage({ params }: PageProps<"/admin/offerings/[id]">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data: off } = await supabase.from("company_offerings").select("id, company_id, name, is_active").eq("id", id).maybeSingle();
  if (!off || !canAdmin(viewer, off.company_id, "offerings")) notFound();

  const groups = await supabase.from("workshop_groups").select("id, name, sessions, capacity, attendance, is_active, finished_at").eq("offering_id", id).order("starts_on");
  if (groups.error) throw groups.error;
  return (
    <WorkshopConfigView
      offering={off} t={t} locale={locale}
      groups={groups.data ?? []}
    />
  );
}
