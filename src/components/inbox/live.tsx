"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

const FAST_MS = 8_000;
const IDLE_MS = 10 * 60_000;   // nobody touched the page for 10 minutes: stop asking until they come back

/**
 * Keeps the inbox live: asks a tiny endpoint every 8 seconds (only while the tab is visible and used within the last 10 minutes) whether anything
 * changed, and refreshes the page data when it did. A refresh already running is never stacked with another (every refresh re-renders the page on
 * the server, and queued refreshes made saving feel stuck). It does not poll a hidden tab, checks again the instant the tab is shown, and backs
 * off after errors.
 */
export function InboxLive() {
  const router = useRouter();
  const { t } = useI18n();
  const last = useRef<string | null>(null);
  const [ok, setOk] = useState(true);
  const [refreshing, startRefresh] = useTransition();
  const busy = useRef(false);
  const lastTouch = useRef(0);   // set when the effect starts (Date.now() is not allowed while rendering)
  useEffect(() => { busy.current = refreshing; }, [refreshing]);

  useEffect(() => {
    lastTouch.current = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible" && Date.now() - lastTouch.current < IDLE_MS) {
        try {
          const res = await fetch("/api/inbox/pulse", { cache: "no-store", credentials: "same-origin" });
          if (res.ok) {
            const { token } = (await res.json()) as { token: string | null };
            failures = 0; setOk(true);
            if (token !== null) {
              if (last.current === null) last.current = token;
              else if (last.current !== token && !busy.current) { last.current = token; startRefresh(() => router.refresh()); }   // busy: keep the old token, ask again next time
            }
          } else { failures++; setOk(false); }
        } catch { failures++; setOk(false); }
      }
      timer = setTimeout(tick, Math.min(FAST_MS * 2 ** Math.min(failures, 4), 30_000));
    };
    const onVisible = () => { if (document.visibilityState === "visible") { lastTouch.current = Date.now(); clearTimeout(timer); void tick(); } };
    const touch = () => { lastTouch.current = Date.now(); };
    document.addEventListener("visibilitychange", onVisible);
    for (const ev of ["pointerdown", "keydown", "scroll"] as const) window.addEventListener(ev, touch, { passive: true });
    void tick();
    return () => {
      stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible);
      for (const ev of ["pointerdown", "keydown", "scroll"] as const) window.removeEventListener(ev, touch);
    };
  }, [router]);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-foreground/10" data-testid="inbox-live" title={ok ? t.inbox.liveOn : t.inbox.liveOff}>
      <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
      {ok ? t.inbox.live : t.inbox.liveOff}
    </span>
  );
}
