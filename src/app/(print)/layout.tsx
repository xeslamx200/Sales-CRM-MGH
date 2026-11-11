/** Bare layout for printable pages: no sidebar or header, so "Save as PDF" contains the report only. */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[1400px] bg-background p-6 text-foreground print:max-w-none print:p-0">{children}</main>;
}
