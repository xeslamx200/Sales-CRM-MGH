"use client";
import { useTransition } from "react";
import { MoreHorizontal, Play, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompleteTaskButton } from "@/components/crm/record-actions";
import { useI18n } from "@/components/i18n-provider";
import { setTaskStatus } from "@/actions/work";
import type { Enums } from "@/types/database";

export function TaskRowActions({ id, status }: { id: string; status: Enums<"task_status"> }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  if (status === "completed" || status === "canceled") return null;
  const set = (s: "open" | "in_progress" | "canceled") =>
    start(async () => {
      const res = await setTaskStatus({ id, status: s });
      if (!res.ok) toast.error(res.error);
    });
  return (
    <div className="flex items-center justify-end gap-1">
      <CompleteTaskButton taskId={id} size="icon-sm" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t.common.actions}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {status === "open" && <DropdownMenuItem onSelect={() => set("in_progress")}><Play />{t.tasks.start}</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onSelect={() => set("canceled")}><XCircle />{t.tasks.cancel}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
