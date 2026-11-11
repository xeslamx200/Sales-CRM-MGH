"use client";
import { useTransition } from "react";
import { PlugZap, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { syncWhatsappTemplates, testWhatsappConnection } from "@/actions/whatsapp";
import { fmt } from "@/i18n";

/** Connection test and template sync for one number (company admins of its default company, super admins). */
export function NumberTools({ accountId }: { accountId: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
        const res = await testWhatsappConnection({ accountId });
        if (!res.ok) toast.error(res.error);
        else if (res.data.ok) toast.success(t.admin.connectionOk);
        else toast.error(fmt(t.admin.connectionFailed, { code: res.data.code ?? "?" }));
      })}>
        <PlugZap />{t.admin.testConnection}
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
        const res = await syncWhatsappTemplates({ accountId });
        if (!res.ok) toast.error(res.error);
        else toast.success(fmt(t.admin.templatesSynced, { count: res.data.count, approved: res.data.approved }));
      })}>
        <RefreshCw />{t.admin.syncTemplates}
      </Button>
    </div>
  );
}
