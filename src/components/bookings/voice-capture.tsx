"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Sparkles, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

// The browser's speech recognition (Chrome / Edge). Not part of the standard TypeScript DOM types.
type RecResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type RecEvent = { resultIndex: number; results: ArrayLike<RecResult> };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void;
  onresult: ((e: RecEvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

const LANGS = [
  { value: "ar-EG", key: "langEg" },
  { value: "ar-SA", key: "langSa" },
  { value: "ar-QA", key: "langQa" },
  { value: "en-US", key: "langEn" },
] as const;

/**
 * Dictate a whole booking: the microphone turns the voice into text (in the browser), the text is analysed and the booking form fills itself.
 * The text stays editable and can be analysed again; nothing is saved until the employee reviews the form and presses Create.
 */
export function VoiceCapture({ onAnalyze, disabled }: { onAnalyze: (text: string) => void; disabled?: boolean }) {
  const { t, locale } = useI18n();
  const v = t.voiceBooking;
  // null while rendering on the server, then whether this browser has speech recognition
  const supported = useSyncExternalStore(
    () => () => undefined,
    () => { const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }; return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition); },
    () => null as boolean | null,
  );
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [lang, setLang] = useState<string>(locale === "ar" ? "ar-EG" : "en-US");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalText = useRef("");
  const latest = useRef("");

  useEffect(() => () => { rec.current?.stop(); }, []);
  useEffect(() => { latest.current = text; }, [text]);

  const errorText = (code: string) => {
    switch (code) {
      case "not-allowed": return v.permissionDenied;
      case "service-not-allowed": return v.speechServiceBlocked;
      case "audio-capture": return v.micNotFound;
      case "no-speech": return v.noSpeech;
      case "network": return v.networkError;
      default: return v.genericError;
    }
  };

  const start = async () => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    setError(null);
    // ask for the microphone itself first: it shows the permission prompt and tells apart "blocked", "no microphone" and "in use"
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((tr) => tr.stop());
      } catch (e) {
        const name = (e as { name?: string }).name ?? "Error";
        const msg = name === "NotAllowedError" || name === "SecurityError" ? v.permissionDenied
          : name === "NotFoundError" || name === "OverconstrainedError" ? v.micNotFound
          : name === "NotReadableError" || name === "AbortError" ? `${v.micBusy} ${v.micBlockedByWindows}` : v.genericError;
        setError(`${msg} (${v.errorCode}: ${name})`);
        return;
      }
    }
    const r = new Ctor();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    finalText.current = latest.current ? `${latest.current.trim()} ` : "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += `${res[0].transcript} `; else interim += res[0].transcript;
      }
      setText((finalText.current + interim).trim());
    };
    r.onerror = (e) => {
      setError(`${errorText(e.error)} (${v.errorCode}: ${e.error})`);
      setListening(false);
    };
    r.onend = () => {
      setListening(false);
      // stopping the microphone analyses what was said, so the form fills itself
      const said = latest.current.trim();
      if (said) onAnalyze(said);
    };
    rec.current = r;
    try { r.start(); setListening(true); } catch (e) { setError(`${v.genericError} (${v.errorCode}: ${(e as { name?: string }).name ?? "start"})`); setListening(false); }
  };
  const stop = () => rec.current?.stop();

  return (
    <section className="rounded-xl border bg-card" data-testid="voice-capture" aria-label={v.title}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-full bg-accent text-[color:var(--brand-gold-ink)]"><Mic className="size-4" /></span>
          <div>
            <h2 className="text-sm font-semibold">{v.title}</h2>
            <p className="text-xs text-muted-foreground">{v.hint}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {v.language}
          <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={listening} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" aria-label={v.language}>
            {LANGS.map((l) => <option key={l.value} value={l.value}>{v[l.key]}</option>)}
          </select>
        </label>
      </div>
      <div className="grid gap-3 p-4">
        {supported === false && <p className="text-sm text-amber-800" role="status">{v.unsupported}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {supported !== false && (
            listening
              ? <Button type="button" variant="destructive" onClick={stop} data-testid="voice-stop"><Square />{v.stop}</Button>
              : <Button type="button" onClick={() => { void start(); }} disabled={disabled || supported === null} data-testid="voice-start"><Mic />{v.start}</Button>
          )}
          {listening && <span className="flex items-center gap-2 text-sm text-destructive" role="status"><span className="size-2 animate-pulse rounded-full bg-destructive" />{v.listening}</span>}
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" placeholder={v.placeholder} aria-label={v.transcript}
          className={cn("w-full rounded-md border bg-background px-3 py-2 text-sm", listening && "border-destructive/50")} data-testid="voice-text" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || !text.trim() || listening} onClick={() => onAnalyze(text.trim())} data-testid="voice-analyze"><Sparkles />{v.analyze}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={!text} onClick={() => { setText(""); finalText.current = ""; }}><Trash2 />{v.clear}</Button>
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <p className="text-xs text-muted-foreground">{v.example}</p>
      </div>
    </section>
  );
}
