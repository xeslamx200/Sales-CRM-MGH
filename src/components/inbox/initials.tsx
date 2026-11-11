import { cn } from "@/lib/utils";

/** Two letters for an avatar: first letters of the first two words, else the first two characters (digits-only names give e.g. "20"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const chars = (s: string) => Array.from(s);
  if (words.length >= 2) return (chars(words[0])[0] + chars(words[1])[0]).toUpperCase();
  return chars(words[0] ?? "?").slice(0, 2).join("").toUpperCase();
}

/** Round avatar in the MGH style: navy with gold letters when `strong`, soft blue otherwise. Decorative (the name is next to it). */
export function Initials({ name, strong = false, className }: { name: string; strong?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn(
      "flex size-10 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold ltr-nums",
      strong ? "bg-sidebar text-sidebar-primary" : "bg-[#e8edf5] text-primary",
      className,
    )}>{initialsOf(name)}</span>
  );
}
