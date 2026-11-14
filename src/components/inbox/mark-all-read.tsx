"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { markAllConversationsRead } from "@/actions/inbox";
import { fmt } from "@/i18n";

/** Chats read on the phone send no signal to the CRM, so they stay "unread" here: one click clears the counters of everything this person can see. */
export function MarkAllRead({ companyIds }: { companyIds: string[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button type="button" variant="outline" size="sm" className="rounded-full bg-card" disabled={pending || companyIds.length === 0} data-testid="mark-all-read"
      onClick={() => start(async () => {
        const res = await markAllConversationsRead({ companyIds });
        if (!res.ok) { toast.error(res.error); return; }
        toast.success(res.data.cleared === 0 ? t.inbox.markAllNone : fmt(t.inbox.markAllDone, { n: res.data.cleared }));
        router.refresh();
      })}>
      <CheckCheck /><span className="max-sm:hidden">{t.inbox.markAllRead}</span>
    </Button>
  );
}
