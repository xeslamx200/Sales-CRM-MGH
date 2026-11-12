"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";
import { removeLogo, resetBranding, saveBranding, saveLogo } from "@/actions/branding";
import { BRAND_PRESETS, DEFAULT_BRAND, brandCssVars, brandIssues, normalizeHex, sameBrand, type BrandColors } from "@/lib/brand";
import { cn } from "@/lib/utils";

const MAX_LOGO = 512 * 1024;
type Result = { ok: boolean; error?: string };

function ColorField({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const hex = normalizeHex(value);
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} (${t.branding.hex})`} value={hex ?? "#000000"} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1" />
        <Input id={id} dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} maxLength={7} className={cn("w-full min-w-0 max-w-32 font-mono", !hex && "border-destructive")} aria-invalid={!hex} />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Colours (three, with ready-made sets and a live preview) and the logo of the company. Company admins only (the database enforces it). */
export function BrandingForm({ companyId, initial, custom, logoSrc, plate: plateInitial }: { companyId: string; initial: BrandColors; custom: boolean; logoSrc: string | null; plate: boolean }) {
  const { t } = useI18n();
  const b = t.branding;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [navy, setNavy] = useState(initial.navy);
  const [gold, setGold] = useState(initial.gold);
  const [blue, setBlue] = useState(initial.blue);
  const [plate, setPlate] = useState(plateInitial);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const colors = { navy: normalizeHex(navy), gold: normalizeHex(gold), blue: normalizeHex(blue) };
  const valid = colors.navy && colors.gold && colors.blue ? ({ navy: colors.navy, gold: colors.gold, blue: colors.blue } satisfies BrandColors) : null;
  const issues = valid ? brandIssues(valid) : [];
  const shownLogo = preview ?? logoSrc;
  const run = (fn: () => Promise<Result>, done: string, after?: () => void) => start(async () => {
    setError(null);
    const r = await fn();
    if (r.ok) { toast.success(done); after?.(); router.refresh(); } else setError(r.error ?? t.common.errorBody);
  });

  const pick = (c: BrandColors) => { setNavy(c.navy); setGold(c.gold); setBlue(c.blue); };
  const onFile = (f: File | null) => {
    if (!f) return;
    setError(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) { setError(b.fileType); return; }
    if (f.size > MAX_LOGO) { setError(b.fileTooLarge); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const base64 = url.slice(url.indexOf(",") + 1);
      run(() => saveLogo({ companyId, mimeType: f.type as "image/png", base64 }), b.logoSaved, () => setPreview(url));
    };
    reader.readAsDataURL(f);
    if (file.current) file.current.value = "";
  };

  const vars = valid ? (brandCssVars(valid) as React.CSSProperties) : undefined;
  const dirty = valid ? !sameBrand(valid, initial) || plate !== plateInitial : false;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="branding-form">
      <div className="grid gap-5">
        <div className="grid gap-2">
          <p className="text-sm font-medium">{b.presets}</p>
          <div className="flex flex-wrap gap-2">
            {BRAND_PRESETS.map((p) => {
              const on = valid && sameBrand(valid, p.colors);
              return (
                <button key={p.key} type="button" onClick={() => pick(p.colors)} aria-pressed={Boolean(on)} data-testid={`preset-${p.key}`}
                  className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-muted", on && "border-primary ring-1 ring-primary")}>
                  <span className="flex -space-x-1 rtl:space-x-reverse">
                    {[p.colors.navy, p.colors.gold, p.colors.blue].map((c, i) => <span key={i} className="size-4 rounded-full ring-2 ring-background" style={{ background: c }} />)}
                  </span>
                  {b.presetNames[p.key as keyof typeof b.presetNames]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <ColorField id="brand-navy" label={b.navy} hint={b.navyHint} value={navy} onChange={setNavy} />
          <ColorField id="brand-gold" label={b.gold} hint={b.goldHint} value={gold} onChange={setGold} />
          <ColorField id="brand-blue" label={b.blue} hint={b.blueHint} value={blue} onChange={setBlue} />
        </div>
        {issues.length > 0 && (
          <ul className="grid gap-1 text-sm text-destructive" role="alert" data-testid="brand-issues">
            {issues.map((i) => <li key={i}>{b.issues[i]}</li>)}
          </ul>
        )}

        <div className="grid gap-2">
          <p className="text-sm font-medium">{b.logo}</p>
          <div className="flex flex-wrap items-center gap-3">
            <div className={cn("flex h-16 min-w-40 items-center justify-center rounded-xl border px-4", plate ? "bg-white" : "bg-[var(--brand-navy)]")} style={vars}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the company's own uploaded image / the static default logo */}
              <img src={shownLogo ?? "/mgh-logo.png"} alt={b.logo} className="max-h-12 w-auto object-contain" data-testid="logo-preview" />
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id="logo-file" data-testid="logo-input" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => file.current?.click()}><ImagePlus />{b.chooseLogo}</Button>
              {(logoSrc || preview) && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => removeLogo({ companyId }), b.logoRemoved, () => setPreview(null))}><Trash2 />{b.removeLogo}</Button>}
            </div>
          </div>
          {!logoSrc && !preview && <p className="text-xs text-muted-foreground">{b.usingDefaultLogo}</p>}
          <p className="text-xs text-muted-foreground">{b.logoHint}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 rounded border" checked={plate} onChange={(e) => setPlate(e.target.checked)} />{b.plate}
          </label>
          <p className="text-xs text-muted-foreground">{b.plateHint}</p>
        </div>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending || !valid || issues.length > 0 || (!dirty && custom)}
            onClick={() => valid && run(() => saveBranding({ companyId, navy: valid.navy, gold: valid.gold, blue: valid.blue, logoPlate: plate }), b.saved)}>{b.save}</Button>
          <Button size="sm" variant="outline" disabled={pending || (!custom && sameBrand(valid ?? DEFAULT_BRAND, DEFAULT_BRAND))}
            onClick={() => run(() => resetBranding({ companyId }), b.resetDone, () => { pick(DEFAULT_BRAND); setPlate(false); setPreview(null); })}><RotateCcw />{b.reset}</Button>
        </div>
      </div>

      <div className="grid content-start gap-2" aria-label={b.preview}>
        <p className="text-sm font-medium">{b.preview}</p>
        <div className="flex overflow-hidden rounded-xl border" style={vars} data-testid="brand-preview">
          <div className="flex w-28 flex-col gap-2 p-3" style={{ background: "var(--brand-navy)" }}>
            <div className={cn("flex h-8 items-center justify-center rounded-md px-1", plate ? "bg-white" : "")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- preview of the chosen logo */}
              <img src={shownLogo ?? "/mgh-logo.png"} alt="" className="max-h-6 w-auto object-contain" />
            </div>
            <div className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-white ring-1" style={{ background: "rgba(255,255,255,0.1)", ["--tw-ring-color" as string]: "var(--brand-gold)" }}>{b.previewMenu}</div>
            <div className="rounded-lg px-2 py-1.5 text-[11px] text-white/70">···</div>
          </div>
          <div className="grid flex-1 content-start gap-2 bg-background p-3">
            <span className="inline-flex w-fit rounded-md px-3 py-1.5 text-xs font-medium" style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}>{b.previewButton}</span>
            <span className="inline-flex w-fit rounded-md px-3 py-1.5 text-xs font-medium" style={{ background: "var(--brand-gold)", color: "var(--brand-gold-fg)" }}>{b.gold}</span>
            <span className="text-xs underline" style={{ color: "var(--primary)" }}>{b.previewLink}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
