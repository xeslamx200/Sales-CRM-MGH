"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { FileText, Loader2, Paperclip, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { createBrowserSupabase } from "@/client/supabase";
import { prepareMediaUpload, sendMedia, sendTemplate } from "@/actions/whatsapp";

export type MessageMediaInfo = {
  filename: string | null; mimeType: string | null; template: string | null; hasFile: boolean;
  /** image | video | audio | document | sticker when known (Kapso), else derived from the type */
  kind: string | null; voice: boolean; transcript: string | null;
};
export type TemplateOption = { name: string; language: string; body: string; params: number };

// Mirrors OUTBOUND_MEDIA in src/lib/whatsapp/graph.ts (the server re-checks).
const ACCEPT = [
  "image/jpeg", "image/png", "application/pdf", "text/plain", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/**
 * The file of a message, shown IN the conversation: image, sticker, audio / voice note (player + transcript), video, or a download link for
 * documents. The URL is a server route that checks access (RLS) and redirects to a 60 s signed URL; nothing links to Kapso or Meta.
 */
export function MessageMedia({ messageId, media }: { messageId: string; media: MessageMediaInfo }) {
  const { t } = useI18n();
  if (!media.hasFile) return null;
  const href = `/api/whatsapp/media/${messageId}`;
  const kind = media.kind ?? (media.mimeType?.startsWith("image/") ? "image" : media.mimeType?.startsWith("audio/") ? "audio" : media.mimeType?.startsWith("video/") ? "video" : "document");
  if (kind === "sticker" || (kind === "image" && media.mimeType === "image/webp" && !media.filename?.match(/\.(jpe?g|png)$/i))) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="mb-1 block" aria-label={t.inbox.sticker}>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL; not optimizable */}
        <img src={href} alt={t.inbox.sticker} loading="lazy" className="max-h-40 w-auto object-contain" />
      </a>
    );
  }
  if (kind === "audio") {
    return (
      <div className="mb-1 flex flex-col gap-1">
        <audio controls preload="none" src={href} className="h-10 w-64 max-w-full" aria-label={media.voice ? t.inbox.voiceNote : t.inbox.audio} />
        {media.transcript && (
          <p className="max-w-64 rounded-md bg-background/70 px-2 py-1 text-xs text-muted-foreground" dir="auto">
            <span className="font-medium">{t.inbox.transcript}: </span>{media.transcript}
          </p>
        )}
      </div>
    );
  }
  if (kind === "video") {
    return <video controls preload="metadata" src={href} className="mb-1 max-h-64 max-w-full rounded-md border" aria-label={t.inbox.video} />;
  }
  if (media.mimeType?.startsWith("image/")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="mb-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL; not optimizable */}
        <img src={href} alt={media.filename ?? t.inbox.image} loading="lazy" className="max-h-64 rounded-md border object-contain" />
      </a>
    );
  }
  return (
    <a href={href} className="mb-1 flex items-center gap-2 rounded-md border bg-background/70 px-2 py-1.5 text-xs hover:bg-muted">
      <FileText className="size-4 shrink-0" />
      <span className="truncate" dir="auto">{media.filename ?? t.inbox.file}</span>
      <span className="ms-auto shrink-0 text-primary">{t.inbox.download}</span>
    </a>
  );
}

/** Pick a file → signed upload straight to private Storage → send with the typed text as caption. */
export function AttachButton({
  conversationId, caption, disabled, onSent,
}: { conversationId: string; caption: string; disabled: boolean; onSent: () => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const upload = (file: File) =>
    start(async () => {
      const prep = await prepareMediaUpload({ conversationId, filename: file.name, mimeType: file.type, size: file.size });
      if (!prep.ok) {
        toast.error(prep.error);
        return;
      }
      const { error } = await createBrowserSupabase().storage.from("whatsapp-media").uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type });
      if (error) {
        toast.error(t.inbox.uploadFailed);
        return;
      }
      const res = await sendMedia({
        conversationId, path: prep.data.path, mimeType: file.type, filename: file.name,
        caption: caption.trim() || null, clientRequestId: crypto.randomUUID(),
      });
      if (!res.ok) toast.error(res.error);
      else if (res.data.status === "failed") toast.error(t.inbox.sendFailed);
      else onSent();
    });
  return (
    <>
      <input ref={input} type="file" accept={ACCEPT.join(",")} className="sr-only" aria-label={t.inbox.attach}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
      <Button type="button" variant="ghost" size="icon" disabled={disabled || pending} aria-label={t.inbox.attach}
        onClick={() => input.current?.click()}>
        {pending ? <Loader2 className="animate-spin" /> : <Paperclip />}
      </Button>
    </>
  );
}

/** Outside the 24-hour window: approved templates only, with their parameters filled in. */
export function TemplateComposer({ conversationId, templates }: { conversationId: string; templates: TemplateOption[] }) {
  const { t } = useI18n();
  const [key, setKey] = useState(templates[0] ? `${templates[0].name}|${templates[0].language}` : "");
  const [params, setParams] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const tpl = templates.find((x) => `${x.name}|${x.language}` === key);
  const preview = useMemo(
    () => (tpl ? tpl.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] || `{{${n}}}`) : ""),
    [tpl, params],
  );
  if (templates.length === 0) return <p className="text-sm text-muted-foreground">{t.inbox.noTemplates}</p>;
  const ready = tpl && Array.from({ length: tpl.params }, (_, i) => params[i]?.trim()).every(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="tpl">{t.inbox.template}</Label>
      <Select value={key} onValueChange={(v) => { setKey(v); setParams([]); }}>
        <SelectTrigger id="tpl" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {templates.map((x) => <SelectItem key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name} ({x.language})</SelectItem>)}
        </SelectContent>
      </Select>
      {tpl && Array.from({ length: tpl.params }, (_, i) => (
        <Input key={i} value={params[i] ?? ""} maxLength={1024} dir="auto" placeholder={`{{${i + 1}}}`} aria-label={`{{${i + 1}}}`}
          onChange={(e) => setParams((p) => { const n = [...p]; n[i] = e.target.value; return n; })} />
      ))}
      {tpl && <p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm" dir="auto">{preview}</p>}
      <Button disabled={!ready || pending} onClick={() => start(async () => {
        const res = await sendTemplate({ conversationId, name: tpl!.name, language: tpl!.language, params: params.slice(0, tpl!.params), clientRequestId: crypto.randomUUID() });
        if (!res.ok) toast.error(res.error);
        else if (res.data.status === "failed") toast.error(t.inbox.sendFailed);
        else setParams([]);
      })}>
        {pending ? <Loader2 className="animate-spin" /> : <Send className="rtl:-scale-x-100" />}{t.inbox.sendTemplate}
      </Button>
    </div>
  );
}
