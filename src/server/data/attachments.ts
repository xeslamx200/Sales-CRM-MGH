import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { isAdminOf, type Viewer } from "@/server/auth/viewer";
import type { AttachmentItem } from "@/components/crm/attachments";
import type { AttachmentEntityType } from "@/lib/attachments.ts";
import { formatBytes, formatDateTime } from "@/lib/format.ts";

/** Attachments of a record, as the viewer may see them (RLS), newest first. */
export async function listAttachments(
  supabase: ServerClient, viewer: Viewer, entityType: AttachmentEntityType, entityId: string, tz: string,
): Promise<AttachmentItem[]> {
  const { data, error } = await supabase.from("attachments")
    .select("id, company_id, file_name, mime_type, size_bytes, uploaded_by, created_at, uploader:profiles!attachments_uploaded_by_fkey(full_name)")
    .eq("entity_type", entityType).eq("entity_id", entityId).order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []).map((a) => ({
    id: a.id,
    fileName: a.file_name,
    mimeType: a.mime_type,
    sizeLabel: formatBytes(a.size_bytes, viewer.locale),
    uploadedBy: a.uploader?.full_name ?? null,
    createdAtLabel: formatDateTime(a.created_at, tz, viewer.locale),
    // Mirrors the attachments_delete policy; the database decides in the end.
    canDelete: a.uploaded_by === viewer.id || isAdminOf(viewer, a.company_id),
  }));
}
