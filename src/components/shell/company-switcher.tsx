"use client";
import { useTransition } from "react";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { StatusBadge } from "@/components/app/status-badge";
import { setActiveCompany } from "@/actions/shell";

const ALL = "all";

export function CompanySwitcher({
  companies, activeId, canSelectAll,
}: { companies: { id: string; name: string; isSandbox?: boolean }[]; activeId: string | null; canSelectAll: boolean }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  if (companies.length === 0) return null;
  if (companies.length === 1 && !canSelectAll) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Building2 className="size-4" />
        <span className="max-w-48 truncate">{companies[0].name}</span>
        {companies[0].isSandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}
      </div>
    );
  }
  return (
    <Select
      value={activeId ?? ALL}
      disabled={pending}
      onValueChange={(v) =>
        start(async () => {
          const res = await setActiveCompany({ companyId: v });
          if (!res.ok) toast.error(res.error);
        })
      }
    >
      <SelectTrigger size="sm" className="w-56" aria-label={t.shell.selectCompany}>
        <Building2 className="size-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {canSelectAll && (
          <>
            <SelectItem value={ALL}>{t.common.allCompanies}</SelectItem>
            <SelectSeparator />
          </>
        )}
        {companies.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}{c.isSandbox ? ` · ${t.common.sandbox}` : ""}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
