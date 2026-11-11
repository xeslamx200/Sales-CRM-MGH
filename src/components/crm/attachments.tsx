"use client";
import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Image as ImageIcon, Loader2, Paperclip, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { createBrowserSupabase } from "@/client/supabase";
import { finalizeAttachmentUpload, prepareAttachment, removeAttachment } from "@/actions/attachments";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, isImageAttachment, type AttachmentEntityType } from "@/lib/attachments.ts";

export type AttachmentItem = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeLabel: string;
  uploadedBy: string | null;
  createdAtLabel: string;
  canDelete: boolean;
};

/** Upload button: signed URL from the server, browser → private Storage, then the server records it. */
export function AttachmentUpload({ entityType, entityId }: { entityType: AttachmentEntityType; entityId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const upload = (file: File) =>
    start(async () => {
      if (!ATTACHMENT_TYPES[file.type]) return void toast.error(t.attachments.unsupported);
      if (file.size > ATTACHMENT_MAX_BYTES) return void toast.error(t.attachments.tooLarge);
      const prep = await prepareAttachment({ entityType, entityId, mimeType: file.type, size: file.size });
      if (!prep.ok) return void toast.error(prep.error);
      const { error } = await createBrowserSupabase().storage.from("attachments")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type });
      if (error) return void toast.error(t.attachments.uploadFailed);
      const res = await finalizeAttachmentUpload({ entityType, entityId, path: prep.data.path, fileName: file.name, mimeType: file.type });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t.attachments.uploaded);
      router.refresh();
    });
  return (
    <>
      <input ref={input} type="file" accept={Object.keys(ATTACHMENT_TYPES).join(",")} className="sr-only" tabIndex={-1}
        aria-label={t.attachments.upload} data-testid="attachment-input"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => input.current?.click()}>
        {pending ? <Loader2 className="animate-spin" /> : <Paperclip />}{pending ? t.attachments.uploading : t.attachments.upload}
      </Button>
    </>
  );
}

export function AttachmentList({ items }: { items: AttachmentItem[] }) {
  const { t } = useI18n();
  const router = useRouter();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t.attachments.empty}</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm" aria-label={t.attachments.title}>
      {items.map((a) => {
        const Icon = isImageAttachment(a.mimeType) ? ImageIcon : FileText;
        return (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer"
                  className="block truncate font-medium text-primary hover:underline" dir="auto">{a.fileName}</a>
                <p className="text-xs text-muted-foreground">
                  <span className="ltr-nums">{a.sizeLabel}</span> · {a.uploadedBy ?? "—"} · {a.createdAtLabel}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <Button asChild variant="ghost" size="icon-sm">
                <a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" aria-label={`${t.attachments.download}: ${a.fileName}`}><Download /></a>
              </Button>
              {a.canDelete && (
                <ConfirmDialog
                  trigger={<Button variant="ghost" size="icon-sm" aria-label={`${t.common.delete}: ${a.fileName}`}><Trash2 /></Button>}
                  title={t.attachments.deleteTitle}
                  description={t.attachments.deleteHint}
                  confirmLabel={t.common.delete}
                  destructive
                  successMessage={t.attachments.deleted}
                  onConfirm={async () => {
                    const res = await removeAttachment({ id: a.id });
                    if (res.ok) router.refresh();
                    return res;
                  }}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
