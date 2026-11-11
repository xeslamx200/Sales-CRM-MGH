import Link from "next/link";
import { ArrowLeftRight, CalendarCheck, CheckCircle2, CircleDot, Mail, MessageCircle, NotebookPen, Phone, PlusCircle, Sparkles, Users } from "lucide-react";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import type { TimelineItem } from "@/server/data/timeline";
import type { Dictionary, Locale } from "@/i18n";
import { fmt } from "@/i18n";
import { formatDateTime, formatDuration } from "@/lib/format.ts";

const ACTIVITY_ICON = { call: Phone, meeting: Users, note: NotebookPen, email: Mail, whatsapp: MessageCircle, other: CircleDot } as const;

export function Timeline({ items, t, locale, tz }: { items: TimelineItem[]; t: Dictionary; locale: Locale; tz: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t.timeline.empty}</p>;
  return (
    <ol className="relative flex flex-col gap-4 border-s ps-5">
      {items.map((item, i) => {
        const { icon: Icon, body } = render(item, t, locale);
        return (
          <li key={i} className="relative">
            <span className="absolute -start-[1.95rem] top-0.5 flex size-6 items-center justify-center rounded-full border bg-card">
              <Icon className="size-3.5 text-muted-foreground" />
            </span>
            <div className="text-sm">{body}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {formatDateTime(item.at, tz, locale)}
              {item.actor && <> · {item.actor}</>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function render(item: TimelineItem, t: Dictionary, locale: Locale): { icon: React.ComponentType<{ className?: string }>; body: React.ReactNode } {
  switch (item.kind) {
    case "created":
      return { icon: PlusCircle, body: item.automatic ? t.timeline.createdAuto : t.timeline.created };
    case "status":
      return {
        icon: ArrowLeftRight,
        body: (
          <span className="flex flex-wrap items-center gap-1">
            {t.timeline.statusChanged}
            {item.from && <StatusBadge tone={toneFor(item.from)}>{t.enums.leadStatus[item.from]}</StatusBadge>}
            <span aria-hidden className="inline-block ltr:rotate-180">←</span>
            <StatusBadge tone={toneFor(item.to)}>{t.enums.leadStatus[item.to]}</StatusBadge>
          </span>
        ),
      };
    case "assignment":
      return {
        icon: Users,
        body: (
          <>
            {fmt(t.timeline.assigned, { from: item.from ?? t.common.unassigned, to: item.to ?? t.common.unassigned })}
            {item.reason && <p className="text-muted-foreground">{t.common.reason}: {item.reason}</p>}
          </>
        ),
      };
    case "activity":
      return {
        icon: ACTIVITY_ICON[item.type],
        body: (
          <>
            <span className="font-medium">{t.enums.activityType[item.type]}</span>
            {item.durationSeconds != null && item.durationSeconds > 0 && <> · <span className="ltr-nums">{formatDuration(item.durationSeconds, locale)}</span></>}
            {item.outcome && <> · {item.outcome}</>}
            {item.body && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{item.body}</p>}
          </>
        ),
      };
    case "task":
      return {
        icon: item.status === "completed" ? CheckCircle2 : CalendarCheck,
        body: (
          <>
            <span className="font-medium">{item.status === "completed" ? t.timeline.taskCompleted : t.timeline.taskCreated}</span>
            {": "}{item.title}{" "}
            <StatusBadge tone={toneFor(item.status)}>{t.enums.taskStatus[item.status]}</StatusBadge>
            {item.assignee && <span className="text-muted-foreground"> · {item.assignee}</span>}
            {item.outcome && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{item.outcome}</p>}
          </>
        ),
      };
    case "conversation":
      return {
        icon: MessageCircle,
        body: (
          <>
            <Link href={`/inbox?c=${item.id}`} className="text-primary hover:underline">{t.timeline.conversation}</Link>{" "}
            <StatusBadge tone={toneFor(item.status)}>{t.enums.conversationStatus[item.status]}</StatusBadge>
            {item.unread > 0 && <> · <span className="ltr-nums">{fmt(t.timeline.unread, { count: item.unread })}</span></>}
          </>
        ),
      };
    default:
      return { icon: Sparkles, body: null };
  }
}
