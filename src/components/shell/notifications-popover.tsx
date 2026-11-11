"use client";
import { useTransition } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/components/i18n-provider";
import { markNotificationsRead } from "@/actions/shell";
import { fmt } from "@/i18n";
import { formatDateTime } from "@/lib/format.ts";
import { entityHref } from "@/components/shell/entity-href";
import { cn } from "@/lib/utils";

export type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
};

export function NotificationsPopover({
  items, unread, timeZone,
}: { items: NotificationItem[]; unread: number; timeZone: string }) {
  const { t, locale } = useI18n();
  const [pending, start] = useTransition();
  const markRead = (ids: string[] | null) =>
    start(async () => {
      const res = await markNotificationsRead({ ids });
      if (!res.ok) toast.error(res.error);
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t.notifications.title}>
          <Bell />
          {unread > 0 && (
            <span className="ltr-nums absolute -top-0.5 -end-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t.notifications.title}</span>
          {unread > 0 && (
            <Button variant="link" size="sm" className="h-auto p-0" disabled={pending} onClick={() => markRead(null)}>
              {t.notifications.markAllRead}
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t.notifications.empty}</p>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="divide-y">
              {items.map((n) => {
                const href = entityHref(n.entity_type, n.entity_id);
                const content = (
                  <div className={cn("flex flex-col gap-0.5 px-3 py-2 text-sm", !n.read_at && "bg-accent/60")}>
                    <span className="font-medium">{n.title}</span>
                    {n.body && <span className="text-muted-foreground">{n.body}</span>}
                    <span className="text-xs text-muted-foreground">{formatDateTime(n.created_at, timeZone, locale)}</span>
                  </div>
                );
                return (
                  <li key={n.id}>
                    {href ? (
                      <Link href={href} className="block hover:bg-muted" onClick={() => !n.read_at && markRead([n.id])}>
                        {content}
                      </Link>
                    ) : content}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
        {unread > 0 && (
          <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{fmt(t.notifications.unread, { count: unread })}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
