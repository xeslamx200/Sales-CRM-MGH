/**
 * File attachments on records: allowed types and limits. Must match the
 * `attachments` bucket (0890) and app.guard_attachment (0920).
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** MIME type → stored file extension. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export const ATTACHMENT_ENTITY_TYPES = ["lead", "payment"] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

/** Images open in the browser; every other type is served as a download. */
export function isImageAttachment(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType);
}

export type AttachmentCheck = { ok: true; ext: string } | { ok: false; error: "attachment.unsupported_type" | "attachment.too_large" };

/** Validate a declared upload before any URL is issued. */
export function checkAttachment(mimeType: string, size: number): AttachmentCheck {
  const ext = ATTACHMENT_TYPES[mimeType];
  if (!ext) return { ok: false, error: "attachment.unsupported_type" };
  if (!Number.isInteger(size) || size <= 0 || size > ATTACHMENT_MAX_BYTES) return { ok: false, error: "attachment.too_large" };
  return { ok: true, ext };
}

/** Object key inside the bucket. The original file name is kept in the row, never in the key. */
export function attachmentPath(companyId: string, entityType: AttachmentEntityType, entityId: string, random: string, ext: string): string {
  return `${companyId}/${entityType}/${entityId}/${random}.${ext}`;
}

/** Display name: strip path separators and control characters, keep the rest (Arabic included). */
export function attachmentDisplayName(name: string): string {
  const base = name.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/\s+/g, " ").trim();
  return (base.length > 255 ? base.slice(base.length - 255) : base) || "file";
}
