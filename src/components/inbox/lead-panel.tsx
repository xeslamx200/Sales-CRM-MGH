"use client";
import Link from "next/link";
import { Target, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { AssignDialog } from "@/components/crm/record-actions";
import { LeadQualification, type OfferingOption } from "@/components/crm/lead-qualification";
import { useI18n } from "@/components/i18n-provider";
import type { Enums } from "@/types/database";

export type LeadPanelData = {
  id: string;
  title: string;
  status: Enums<"lead_status">;
  interest: Enums<"lead_interest">;
  offeringId: string | null;
  offeringSource: "auto_keyword" | "employee" | null;
  ownerId: string | null;
  ownerName: string | null;
  autoCreated: boolean;
  archived: boolean;
  offerings: OfferingOption[];
};

/**
 * The lead behind a conversation, inside the inbox: sales status, source, owner,
 * and the two qualification fields. Whether the viewer may edit it is decided by
 * RLS on leads (they only receive the lead if they can see it).
 */
export function LeadPanel({
  lead, canAssign, assignees,
}: { lead: LeadPanelData; canAssign: boolean; assignees: { value: string; label: string }[] }) {
  const { t } = useI18n();
  return (
    <section aria-label={t.autoLeads.leadPanel} className="flex flex-col gap-3 border-b bg-muted/30 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Target className="size-4 text-muted-foreground" aria-hidden />
          <Link href={`/leads/${lead.id}`} className="truncate font-medium text-primary hover:underline">{lead.title}</Link>
          <StatusBadge tone={toneFor(lead.status)}>{t.enums.leadStatus[lead.status]}</StatusBadge>
          <StatusBadge tone={lead.autoCreated ? "info" : "neutral"}>{lead.autoCreated ? t.autoLeads.automatic : t.autoLeads.manual}</StatusBadge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t.autoLeads.owner}: <span className="font-medium text-foreground">{lead.ownerName ?? t.common.unassigned}</span></span>
          {canAssign && !lead.archived && (
            <AssignDialog id={lead.id} ownerId={lead.ownerId} options={assignees}
              trigger={<Button variant="outline" size="xs"><UserCog />{t.common.assign}</Button>} />
          )}
        </div>
      </div>
      <LeadQualification
        key={`${lead.id}:${lead.interest}:${lead.offeringId ?? ""}`}
        idPrefix="inbox"
        leadId={lead.id}
        interest={lead.interest}
        offeringId={lead.offeringId}
        offeringSource={lead.offeringSource}
        offerings={lead.offerings}
        disabled={lead.archived}
      />
    </section>
  );
}
