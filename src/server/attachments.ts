import "server-only";
import { randomBytes } from "node:crypto";
import { createClient, type ServerClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { AppError } from "@/server/action";
import { limitUser } from "@/server/rate-limit";
import {
  ATTACHMENT_TYPES, attachmentDisplayName, attachmentPath, checkAttachment, isImageAttachment, type AttachmentEntityType,
} from "@/lib/attachments.ts";

export const ATTACHMENT_BUCKET = "attachments";
const SIGNED_URL_SECONDS = 60;

/**
 * Record attachments. Every decision about WHO may do something is made with
 * the user's session (RLS on leads/payments/attachments + app.guard_attachment).
 * The service role is used only for Storage I/O afterwards: issuing the
 * signed upload URL, checking the uploaded object, signing a download URL and
 * removing objects.
 */

/** The record as the user sees it; null when RLS hides it. */
async function recordCompany(supabase: ServerClient, entityType: AttachmentEntityType, entityId: string): Promise<string> {
  const { data } = entityType === "lead"
    ? await supabase.from("leads").select("company_id").eq("id", entityId).maybeSingle()
    : await supabase.from("payments").select("company_id").eq("id", entityId).maybeSingle();
  if (!data) throw new AppError("auth.forbidden");
  return data.company_id;
}

/** Step 1: validate the declared file and issue a one-time signed upload URL for this record's folder. */
export async function prepareAttachmentUpload(input: { entityType: AttachmentEntityType; entityId: string; mimeType: string; size: number }) {
  const checked = checkAttachment(input.mimeType, input.size);
  if (!checked.ok) throw new AppError(checked.error);
  const supabase = await createClient();
  const companyId = await recordCompany(supabase, input.entityType, input.entityId);
  await limitUser(supabase, "attachment");
  const path = attachmentPath(companyId, input.entityType, input.entityId, randomBytes(12).toString("hex"), checked.ext);
  const { data, error } = await createAdminClient().storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new AppError("generic");
  return { path: data.path, token: data.token };
}

/**
 * Step 2: confirm the object exists with the declared type and an allowed
 * size, then insert the row with the user's session. If the row is refused,
 * the uploaded object is removed so nothing is left behind.
 */
export async function finalizeAttachment(input: { entityType: AttachmentEntityType; entityId: string; path: string; fileName: string; mimeType: string }) {
  const supabase = await createClient();
  const companyId = await recordCompany(supabase, input.entityType, input.entityId);
  const ext = ATTACHMENT_TYPES[input.mimeType];
  const prefix = `${companyId}/${input.entityType}/${input.entityId}/`;
  if (!ext || !input.path.startsWith(prefix) || !/^[0-9a-f]{24}\.[a-z0-9]{1,8}$/.test(input.path.slice(prefix.length))
      || !input.path.endsWith(`.${ext}`)) {
    throw new AppError("attachment.invalid_path");
  }
  const storage = createAdminClient().storage.from(ATTACHMENT_BUCKET);
  const { data: info, error: infoError } = await storage.info(input.path);
  if (infoError || !info) throw new AppError("media.not_uploaded");
  const size = info.size ?? 0;
  const storedType = info.contentType?.split(";")[0];
  const checked = checkAttachment(input.mimeType, size);
  if (!checked.ok || (storedType && storedType !== input.mimeType)) {
    await storage.remove([input.path]);
    throw new AppError(checked.ok ? "attachment.unsupported_type" : checked.error);
  }
  const { data, error } = await supabase.from("attachments").insert({
    company_id: companyId, entity_type: input.entityType, entity_id: input.entityId, storage_path: input.path,
    file_name: attachmentDisplayName(input.fileName), mime_type: input.mimeType, size_bytes: size,
  }).select("id").single();
  if (error || !data) {
    await storage.remove([input.path]);
    throw error ?? new AppError("generic");
  }
  return { id: data.id };
}

/** A 60-second URL for an attachment the user can see (RLS). Images open inline, the rest download. */
export async function attachmentUrl(id: string): Promise<string> {
  const supabase = await createClient();
  const { data: row } = await supabase.from("attachments").select("storage_path, file_name, mime_type").eq("id", id).maybeSingle();
  if (!row) throw new AppError("attachment.not_found");
  await limitUser(supabase, "attachment");
  const { data, error } = await createAdminClient().storage.from(ATTACHMENT_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_SECONDS, isImageAttachment(row.mime_type) ? {} : { download: row.file_name });
  if (error || !data) throw new AppError("attachment.not_found");
  return data.signedUrl;
}

/** Delete with the user's session (uploader or company admin, per RLS), then remove the object. */
export async function deleteAttachment(id: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("attachments").delete().eq("id", id).select("storage_path, entity_type, entity_id");
  const row = data?.[0];
  if (!row) throw new AppError("auth.forbidden");
  const { error } = await createAdminClient().storage.from(ATTACHMENT_BUCKET).remove([row.storage_path]);
  if (error) console.warn("[attachments] object removal failed", { id });
  return { entityType: row.entity_type, entityId: row.entity_id };
}
