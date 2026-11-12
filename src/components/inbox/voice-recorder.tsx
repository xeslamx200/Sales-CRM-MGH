"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Mic, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { createBrowserSupabase } from "@/client/supabase";
import { prepareMediaUpload, sendMedia } from "@/actions/whatsapp";
import { webmOpusToOgg } from "@/lib/audio/ogg-opus.ts";

const MAX_SECONDS = 5 * 60;
const MIN_MS = 700;

/** Best format this browser can record: OGG/Opus (Firefox) as is; WebM/Opus (Chrome, Edge) repacked to OGG; MP4/AAC (Safari) sent as an audio file. */
function pickFormat(): { mime: string; kind: "ogg" | "webm" | "mp4" } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const ok = (m: string) => MediaRecorder.isTypeSupported(m);
  if (ok("audio/ogg;codecs=opus")) return { mime: "audio/ogg;codecs=opus", kind: "ogg" };
  if (ok("audio/webm;codecs=opus")) return { mime: "audio/webm;codecs=opus", kind: "webm" };
  if (ok("audio/mp4")) return { mime: "audio/mp4", kind: "mp4" };
  return null;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Record a voice note in the chat like on the phone: tap the microphone, talk, tap send (or the bin to throw it away).
 * The recording is converted to OGG/Opus in the browser (what WhatsApp needs for a voice note), uploaded straight to private Storage and sent.
 */
export function VoiceRecorder({ conversationId, disabled, onSent, onRecordingChange }: { conversationId: string; disabled: boolean; onSent: () => void; onRecordingChange?: (on: boolean) => void }) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sending, startSending] = useTransition();
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; kind: "ogg" | "webm" | "mp4" } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { onRecordingChange?.(recording); }, [recording, onRecordingChange]);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((x) => x.stop());
  };
  // leaving the page (or switching conversation) throws an unfinished recording away and frees the microphone
  useEffect(() => () => { const r = rec.current; rec.current = null; if (timer.current) clearInterval(timer.current); if (r) { r.recorder.onstop = null; if (r.recorder.state !== "inactive") r.recorder.stop(); r.stream.getTracks().forEach((x) => x.stop()); } }, [conversationId]);

  const cancel = () => {
    const r = rec.current;
    rec.current = null;
    if (r) { r.recorder.onstop = null; if (r.recorder.state !== "inactive") r.recorder.stop(); }
    if (r) { if (timer.current) clearInterval(timer.current); timer.current = null; r.stream.getTracks().forEach((x) => x.stop()); }
    setRecording(false);
  };

  const finish = (send: boolean) => {
    const r = rec.current;
    if (!r) return;
    if (!send) return cancel();
    rec.current = null;
    setRecording(false);
    const long = Date.now() - r.startedAt >= MIN_MS;
    r.recorder.onstop = () => {
      release();
      if (!long) return void toast.error(t.inbox.voiceTooShort);
      startSending(async () => {
        try {
          const blob = new Blob(r.chunks, { type: r.recorder.mimeType });
          const raw = new Uint8Array(await blob.arrayBuffer());
          const ogg = r.kind === "webm" ? webmOpusToOgg(raw) : raw;
          const mimeType = r.kind === "mp4" ? "audio/mp4" : "audio/ogg";
          const filename = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${r.kind === "mp4" ? "m4a" : "ogg"}`;
          const prep = await prepareMediaUpload({ conversationId, filename, mimeType, size: ogg.byteLength });
          if (!prep.ok) return void toast.error(prep.error);
          const { error } = await createBrowserSupabase().storage.from("whatsapp-media").uploadToSignedUrl(prep.data.path, prep.data.token, new Blob([ogg as BlobPart], { type: mimeType }), { contentType: mimeType });
          if (error) { console.error("[upload]", error); return void toast.error(`${t.inbox.uploadFailed} (${error.message})`); }
          const res = await sendMedia({ conversationId, path: prep.data.path, mimeType, filename, caption: null, clientRequestId: crypto.randomUUID() });
          if (!res.ok) toast.error(res.error);
          else if (res.data.status === "failed") toast.error(t.inbox.sendFailed);
          else onSent();
        } catch (err) {
          console.error("[voice]", err);
          toast.error(`${t.inbox.uploadFailed} (${err instanceof Error ? err.message : "error"})`);
        }
      });
    };
    if (r.recorder.state !== "inactive") r.recorder.stop(); else r.recorder.onstop?.(new Event("stop"));
  };

  const start = async () => {
    const format = pickFormat();
    if (!format || !navigator.mediaDevices?.getUserMedia) return void toast.error(t.inbox.micUnsupported);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      return void toast.error(name === "NotFoundError" || name === "OverconstrainedError" ? t.inbox.micMissing : t.inbox.micBlocked);
    }
    const recorder = new MediaRecorder(stream, { mimeType: format.mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.current = { recorder, stream, chunks, startedAt: Date.now(), kind: format.kind };
    recorder.start();
    setSeconds(0);
    setRecording(true);
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - (rec.current?.startedAt ?? Date.now())) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) finish(true);
    }, 250);
  };

  if (recording) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-[#f3f5f9] px-3 py-2" data-testid="voice-recording">
        <Button type="button" variant="ghost" size="icon" onClick={cancel} aria-label={t.inbox.cancelRecording} data-testid="voice-cancel"><Trash2 /></Button>
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden />
        <span className="text-sm tabular-nums" role="timer" aria-label={t.inbox.recordingVoice}>{clock(seconds)}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{t.inbox.recordingVoice}</span>
        <Button type="button" size="icon-lg" className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => finish(true)} aria-label={t.inbox.sendVoice} data-testid="voice-send"><Send className="rtl:-scale-x-100" /></Button>
      </div>
    );
  }
  return (
    <Button type="button" variant="ghost" size="icon" disabled={disabled || sending} onClick={start} aria-label={t.inbox.recordVoice} title={t.inbox.recordVoice} data-testid="voice-start">
      {sending ? <Loader2 className="animate-spin" /> : <Mic />}
    </Button>
  );
}
