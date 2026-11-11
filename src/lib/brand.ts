/**
 * Company branding: three colours chosen by the company admin (dark navy = sidebar and dark cards, highlight = the gold accent, primary = buttons and
 * links). Everything else (soft backgrounds, borders, text on the accent, the gradient) is derived here, so one small set of CSS variables restyles the
 * whole application. Pure functions, no network.
 */

export type BrandColors = { navy: string; gold: string; blue: string };

export const DEFAULT_BRAND: BrandColors = { navy: "#0b2a52", gold: "#f9c846", blue: "#1a468a" };

export const BRAND_PRESETS: { key: string; colors: BrandColors }[] = [
  { key: "mgh", colors: DEFAULT_BRAND },
  { key: "forest", colors: { navy: "#0a3d2e", gold: "#f2b705", blue: "#1f6f54" } },
  { key: "plum", colors: { navy: "#3b1d4f", gold: "#f4b942", blue: "#6a3d9a" } },
  { key: "slate", colors: { navy: "#1f2937", gold: "#38bdf8", blue: "#2563eb" } },
  { key: "crimson", colors: { navy: "#5b1220", gold: "#f6c453", blue: "#b4233a" } },
];

export const HEX = /^#[0-9a-f]{6}$/;

export function normalizeHex(v: string): string | null {
  const s = v.trim().toLowerCase();
  const m = /^#?([0-9a-f]{6})$/.exec(s) ?? (/^#?([0-9a-f]{3})$/.exec(s) ? [s, /^#?([0-9a-f]{3})$/.exec(s)![1].split("").map((c) => c + c).join("")] : null);
  return m ? `#${m[1]}` : null;
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function toHex(c: [number, number, number]): string {
  return `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
}

/** Colour `a` blended with `b` (t = share of b, 0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or near-black, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  return contrast("#ffffff", bg) >= contrast("#111827", bg) ? "#ffffff" : "#111827";
}

export type BrandIssue = "navy_contrast" | "gold_on_navy" | "blue_contrast";

/** What would make the application hard to read: white text must be readable on the navy and on the primary colour, the highlight must stand out on the navy. */
export function brandIssues(c: BrandColors): BrandIssue[] {
  const out: BrandIssue[] = [];
  if (contrast("#ffffff", c.navy) < 4.5) out.push("navy_contrast");
  if (contrast(c.gold, c.navy) < 3) out.push("gold_on_navy");
  if (contrast("#ffffff", c.blue) < 4.5) out.push("blue_contrast");
  return out;
}

/** The CSS variables that restyle the application for these colours (values are hex only, so they are safe to put in a style element). */
export function brandCssVars(c: BrandColors): Record<string, string> {
  const goldFg = readableOn(c.gold);
  const text = mix(c.navy, "#000000", 0.25);
  return {
    "--brand-navy": c.navy, "--brand-navy-2": mix(c.navy, "#ffffff", 0.16), "--brand-navy-3": mix(c.navy, "#000000", 0.3),
    "--brand-gold": c.gold, "--brand-gold-fg": goldFg, "--brand-gold-ink": mix(c.gold, "#000000", 0.5), "--brand-blue": c.blue,
    "--primary": c.blue, "--primary-foreground": "#ffffff", "--ring": c.blue, "--brand": c.gold, "--brand-foreground": goldFg,
    "--sidebar": c.navy, "--sidebar-primary": c.gold, "--sidebar-primary-foreground": goldFg, "--sidebar-ring": c.gold,
    "--sidebar-accent": mix(c.navy, "#ffffff", 0.1), "--sidebar-border": mix(c.navy, "#ffffff", 0.15),
    "--accent": mix(c.gold, "#ffffff", 0.78), "--accent-foreground": c.navy, "--secondary-foreground": c.navy,
    "--foreground": text, "--card-foreground": text, "--popover-foreground": text, "--chart-1": c.blue, "--chart-3": c.gold,
  };
}

/** `:root{...}` text for a style element; refuses anything that is not a plain hex colour. */
export function brandStyleText(vars: Record<string, string>): string {
  const body = Object.entries(vars).filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && HEX.test(v)).map(([k, v]) => `${k}:${v}`).join(";");
  return `:root{${body}}`;
}

export function sameBrand(a: BrandColors, b: BrandColors): boolean {
  return a.navy === b.navy && a.gold === b.gold && a.blue === b.blue;
}
