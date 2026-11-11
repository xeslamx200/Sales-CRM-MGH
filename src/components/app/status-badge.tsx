import { cn } from "@/lib/utils";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-sky-50 text-sky-800 border-sky-200",
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  warning: "bg-amber-50 text-amber-900 border-amber-200",
  danger: "bg-red-50 text-red-800 border-red-200",
  primary: "bg-primary/10 text-primary border-primary/20",
};

export function StatusBadge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Consistent colors for statuses across lists, Kanban and detail pages. */
export const TONE_BY_STATUS: Record<string, Tone> = {
  // leads
  new: "info", contacted: "primary", qualified: "success", unqualified: "neutral", converted: "success", lost: "danger",
  // tasks / leads
  open: "info", won: "success",
  // tasks
  in_progress: "primary", completed: "success", canceled: "neutral",
  // conversations / messages
  pending: "warning", resolved: "neutral", received: "neutral", queued: "warning", sent: "info",
  delivered: "primary", read: "success", failed: "danger",
  // priority
  low: "neutral", medium: "info", high: "warning", urgent: "danger",
  // whatsapp numbers
  pending_setup: "warning", test: "info", active: "success", disabled: "neutral",
};

export function toneFor(status: string | null | undefined): Tone {
  return (status && TONE_BY_STATUS[status]) || "neutral";
}
