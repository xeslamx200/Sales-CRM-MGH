"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useI18n } from "@/components/i18n-provider";
import { setLeadInterest, setLeadOffering } from "@/actions/leads";
import { Constants, type Enums } from "@/types/database";

export type OfferingOption = { value: string; label: string; active: boolean };
const NONE = "__none__";

/**
 * Interest and course/service of a lead. Two independent fields: changing the
 * interest never touches the lead status, and the offering's source ("detected
 * automatically" / "selected by an employee") is recorded by the database.
 */
export function LeadQualification({
  leadId, interest, offeringId, offeringSource, offerings, disabled, idPrefix = "q",
}: {
  leadId: string;
  interest: Enums<"lead_interest">;
  offeringId: string | null;
  offeringSource: "auto_keyword" | "employee" | null;
  offerings: OfferingOption[];
  disabled?: boolean;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [interestValue, setInterestValue] = useState(interest);
  const [offeringValue, setOfferingValue] = useState(offeringId);
  const [source, setSource] = useState(offeringSource);
  // Inactive offerings stay visible when already selected, but can't be newly chosen.
  const options = offerings.filter((o) => o.active || o.value === offeringValue);

  const changeInterest = (v: Enums<"lead_interest">) => {
    const previous = interestValue;
    setInterestValue(v);
    start(async () => {
      const res = await setLeadInterest({ id: leadId, interest: v });
      if (!res.ok) {
        setInterestValue(previous);
        toast.error(res.error);
        return;
      }
      toast.success(t.autoLeads.savedInterest);
      router.refresh();
    });
  };
  const changeOffering = (v: string) => {
    const previous = { id: offeringValue, source };
    const next = v === NONE ? null : v;
    setOfferingValue(next);
    setSource(next ? "employee" : null);
    start(async () => {
      const res = await setLeadOffering({ id: leadId, offeringId: next });
      if (!res.ok) {
        setOfferingValue(previous.id);
        setSource(previous.source);
        toast.error(res.error);
        return;
      }
      toast.success(t.autoLeads.savedOffering);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-interest`}>{t.autoLeads.interest}</Label>
        <Select value={interestValue} onValueChange={(v) => changeInterest(v as Enums<"lead_interest">)} disabled={disabled || pending}>
          <SelectTrigger id={`${idPrefix}-interest`} size="sm" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Constants.public.Enums.lead_interest.map((i) => <SelectItem key={i} value={i}>{t.enums.leadInterest[i]}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t.autoLeads.interestHint}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-offering`}>{t.autoLeads.offering}</Label>
        <SearchableSelect
          id={`${idPrefix}-offering`} value={offeringValue ?? NONE} onChange={changeOffering} disabled={disabled || pending}
          options={[{ value: NONE, label: t.autoLeads.noOffering }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
          searchPlaceholder={t.autoLeads.offeringSearch} emptyText={t.autoLeads.offeringNoMatch}
        />
        {offeringValue && source && (
          <p className="text-xs text-muted-foreground">{source === "auto_keyword" ? t.autoLeads.offeringAuto : t.autoLeads.offeringEmployee}</p>
        )}
      </div>
    </div>
  );
}
