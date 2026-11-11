"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

const FAST_MS = 3_000;

/**
 * Keeps the inbox live: asks a tiny endpoint every 3 seconds (only while the tab is visible) whether anything changed, and refreshes the page data
 * the moment it did. A new message therefore shows up in the list and in the open conversation without pressing refresh. It does not poll a hidden
 * tab, checks again the instant the tab is shown, and backs off after errors.
 */
export function InboxLive() {
  const router = useRouter();
  const { t } = useI18n();
  const last = useRef<string | null>(null);
  const [ok, setOk] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/api/inbox/pulse", { cache: "no-store", credentials: "same-origin" });
          if (res.ok) {
            const { token } = (await res.json()) as { token: string | null };
            failures = 0; setOk(true);
            if (token !== null) {
              if (last.current !== null && last.current !== token) router.refresh();
              last.current = token;
            }
          } else { failures++; setOk(false); }
        } catch { failures++; setOk(false); }
      }
      timer = setTimeout(tick, Math.min(FAST_MS * 2 ** Math.min(failures, 4), 30_000));
    };
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [router]);

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-foreground/10" data-testid="inbox-live" title={ok ? t.inbox.liveOn : t.inbox.liveOff}>
      <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
      {ok ? t.inbox.live : t.inbox.liveOff}
    </span>
  );
}
