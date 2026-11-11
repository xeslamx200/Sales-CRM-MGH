"use client";
import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { useI18n } from "@/components/i18n-provider";
import { createBrowserSupabase } from "@/client/supabase";
import { finalizeAttachmentUpload, prepareAttachment } from "@/actions/attachments";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from "@/lib/attachments.ts";

/**
 * The payment proof (a photo or PDF of the transfer / receipt) so the approver can check the amount written by the employee against the document.
 * The picker only validates type and size; the file is uploaded by uploadProof AFTER the payment exists (it is attached to the payment id),
 * through the existing private upload flow.
 */
export function ProofField({ file, onFile, error, onError, required }: {
  file: File | null; onFile: (f: File | null) => void; error: string | null; onError: (e: string | null) => void; required?: boolean;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => {
    onError(null);
    if (!f) return;
    if (!ATTACHMENT_TYPES[f.type]) return void onError(t.attachments.unsupported);
    if (f.size > ATTACHMENT_MAX_BYTES) return void onError(t.attachments.tooLarge);
    onFile(f);
  };
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor="proof-input">{t.payments.proof}{required ? " *" : ""}</FieldLabel>
      <input ref={input} id="proof-input" data-testid="proof-input" type="file" className="sr-only" accept={Object.keys(ATTACHMENT_TYPES).join(",")}
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => input.current?.click()}><Paperclip />{t.payments.chooseFile}</Button>
        {file && (
          <span className="flex min-w-0 items-center gap-1 rounded-lg bg-accent px-2 py-1 text-sm">
            <span className="truncate" dir="auto">{file.name}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t.common.delete} onClick={() => onFile(null)}><X /></Button>
          </span>
        )}
      </div>
      <FieldDescription>{t.payments.proofHint}</FieldDescription>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Field>
  );
}

/** Attach the proof to an existing payment (private bucket, signed upload). Returns false if any step fails; the payment itself is never rolled back. */
export async function uploadProof(paymentId: string, file: File): Promise<boolean> {
  try {
    const prep = await prepareAttachment({ entityType: "payment", entityId: paymentId, mimeType: file.type, size: file.size });
    if (!prep.ok) return false;
    const up = await createBrowserSupabase().storage.from("attachments").uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type });
    if (up.error) return false;
    const fin = await finalizeAttachmentUpload({ entityType: "payment", entityId: paymentId, path: prep.data.path, fileName: file.name, mimeType: file.type });
    return fin.ok;
  } catch {
    return false;
  }
}
