"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";
import { clearApprovers, saveApprovers, saveExclusion, saveTargetCurrency, saveTargetDefault, saveUiSettings } from "@/actions/company-settings";
import { HIDEABLE_NAV, HIDEABLE_WIDGETS } from "@/schemas/company-settings";

type Result = { ok: boolean; error?: string };

/** Runs a server action, shows the saved toast or the error, and refreshes the page data. */
function useSave() {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, done?: () => void, failed?: () => void) => start(async () => {
    setError(null);
    const r = await fn();
    if (r.ok) { toast.success(t.companySettings.saved); done?.(); router.refresh(); } else { failed?.(); setError(r.error ?? t.common.errorBody); }
  });
  return { pending, error, run };
}

const Err = ({ text }: { text: string | null }) => (text ? <p className="text-sm text-destructive" role="alert">{text}</p> : null);
const checkbox = "size-4 rounded border accent-[var(--color-primary,#0b1f44)]";

export type PersonRow = { userId: string; name: string; role: string };

// -------------------------------------------------------------------------------------------------------------------- payment approvers
export function ApproversForm({ companyId, people, selected, restricted }: { companyId: string; people: PersonRow[]; selected: string[]; restricted: boolean }) {
  const { t } = useI18n();
  const c = t.companySettings;
  const [ids, setIds] = useState<string[]>(selected);
  const { pending, error, run } = useSave();
  const toggle = (id: string) => setIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const invalid = ids.length < 1 || ids.length > 10;
  return (
    <div className="grid gap-3" data-testid="approvers-form">
      <p className="text-sm text-muted-foreground">{restricted ? c.approversRestricted : c.approversOpen}</p>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {people.map((p) => (
          <li key={p.userId}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={checkbox} checked={ids.includes(p.userId)} onChange={() => toggle(p.userId)} />
              <span className="font-medium">{p.name}</span><span className="text-muted-foreground">· {p.role}</span>
            </label>
          </li>
        ))}
      </ul>
      {ids.length < 1 && <p className="text-sm text-amber-800">{c.approversNone}</p>}
      {ids.length > 10 && <p className="text-sm text-amber-800">{c.approversTooMany}</p>}
      <Err text={error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || invalid} onClick={() => run(() => saveApprovers({ companyId, userIds: ids }))}>{c.save}</Button>
        {restricted && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => clearApprovers({ companyId }))}>{c.revertApprovers}</Button>}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------------- target currency + defaults
export function TargetCurrencyForm({ companyId, current, options }: { companyId: string; current: string; options: string[] }) {
  const { t } = useI18n();
  const c = t.companySettings;
  const [cur, setCur] = useState(current);
  const { pending, error, run } = useSave();
  return (
    <div className="grid gap-1.5">
      <label htmlFor="target-currency" className="text-sm font-medium">{c.targetCurrency}</label>
      <div className="flex items-center gap-2">
        <select id="target-currency" value={cur} onChange={(e) => setCur(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <Button size="sm" disabled={pending || cur === current} onClick={() => run(() => saveTargetCurrency({ companyId, currency: cur }))}>{c.save}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{c.targetCurrencyHint}</p>
      <Err text={error} />
    </div>
  );
}

export function TargetDefaultRow({ companyId, userId, label, sub, value, currency }: { companyId: string; userId: string | null; label: string; sub?: string; value: number | null; currency: string }) {
  const { t } = useI18n();
  const [v, setV] = useState(value == null ? "" : String(value));
  const { pending, error, run } = useSave();
  const num = v.trim() === "" ? null : Number(v);
  const bad = num !== null && (!Number.isFinite(num) || num < 0);
  return (
    <tr>
      <td className="px-3 py-2"><span className="font-medium">{label}</span>{sub && <span className="text-muted-foreground"> · {sub}</span>}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Input type="number" min={0} step="0.01" dir="ltr" className="w-36" value={v} aria-label={`${t.companySettings.amount} ${label}`} onChange={(e) => setV(e.target.value)} />
          <span className="text-xs text-muted-foreground">{currency}</span>
          <Button size="sm" variant="outline" disabled={pending || bad} onClick={() => run(() => saveTargetDefault({ companyId, userId, amount: num }))}>{t.companySettings.save}</Button>
        </div>
        <Err text={error} />
      </td>
    </tr>
  );
}

// -------------------------------------------------------------------------------------------------------------------- performance exclusions
export function ExclusionRow({ companyId, person, excluded, reason }: { companyId: string; person: PersonRow; excluded: boolean; reason: string }) {
  const { t } = useI18n();
  const c = t.companySettings;
  const [on, setOn] = useState(excluded);
  const [why, setWhy] = useState(reason);
  const { pending, error, run } = useSave();
  const apply = (next: boolean) => { setOn(next); run(() => saveExclusion({ companyId, userId: person.userId, excluded: next, reason: next ? why : null }), undefined, () => setOn(!next)); };
  return (
    <tr>
      <td className="px-3 py-2"><span className="font-medium">{person.name}</span><span className="text-muted-foreground"> · {person.role}</span></td>
      <td className="px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className={checkbox} checked={on} disabled={pending} onChange={(e) => apply(e.target.checked)} aria-label={`${c.excluded}: ${person.name}`} />{c.excluded}
        </label>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Input value={why} maxLength={300} placeholder={c.reason} aria-label={`${c.reason}: ${person.name}`} onChange={(e) => setWhy(e.target.value)} disabled={!on} />
          {on && why !== reason && <Button size="sm" variant="outline" disabled={pending} onClick={() => apply(true)}>{c.save}</Button>}
        </div>
        <Err text={error} />
      </td>
    </tr>
  );
}

// -------------------------------------------------------------------------------------------------------------------- menu + dashboard
export function UiSettingsForm({ companyId, hidden, hiddenWidgets, mode, usingDefault }: { companyId: string; hidden: string[]; hiddenWidgets: string[]; mode: "standard" | "workshop"; usingDefault: boolean }) {
  const { t } = useI18n();
  const c = t.companySettings;
  const [off, setOff] = useState<string[]>(hidden);
  const [m, setM] = useState(mode);
  const [wOff, setWOff] = useState<string[]>(hiddenWidgets);
  const { pending, error, run } = useSave();
  const toggle = (h: string) => setOff((v) => (v.includes(h) ? v.filter((x) => x !== h) : [...v, h]));
  const toggleW = (h: string) => setWOff((v) => (v.includes(h) ? v.filter((x) => x !== h) : [...v, h]));
  return (
    <div className="grid gap-4" data-testid="ui-settings-form">
      {usingDefault && <p className="text-sm text-muted-foreground">{c.usingDefault}</p>}
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{c.menuTitle}</legend>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {HIDEABLE_NAV.map((h) => (
            <li key={h}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={checkbox} checked={off.includes(h)} onChange={() => toggle(h)} />{c.nav[h]}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{c.menuHint}</p>
      </fieldset>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{c.dashboardTitle}</legend>
        {(["standard", "workshop"] as const).map((x) => (
          <label key={x} className="flex items-center gap-2 text-sm">
            <input type="radio" name="dashboard-mode" checked={m === x} onChange={() => setM(x)} />{x === "standard" ? c.dashboardStandard : c.dashboardWorkshop}
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{c.widgetsTitle}</legend>
        <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="widgets">
          {HIDEABLE_WIDGETS.map((w) => (
            <li key={w}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={checkbox} checked={!wOff.includes(w)} onChange={() => toggleW(w)} />{c.widgets[w]}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{c.widgetsHint}</p>
      </fieldset>
      <Err text={error} />
      <div><Button size="sm" disabled={pending} onClick={() => run(() => saveUiSettings({ companyId, hiddenNav: off as (typeof HIDEABLE_NAV[number])[], dashboardMode: m, hiddenWidgets: wOff as (typeof HIDEABLE_WIDGETS[number])[] }))}>{c.save}</Button></div>
    </div>
  );
}
