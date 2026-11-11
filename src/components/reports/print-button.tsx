"use client";
import { useEffect } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog (choose "Save as PDF") once the report is on screen; the button repeats it. */
export function PrintButton({ label, auto = true }: { label: string; auto?: boolean }) {
  useEffect(() => {
    if (!auto) return;
    const id = window.setTimeout(() => window.print(), 600);
    return () => window.clearTimeout(id);
  }, [auto]);
  return <Button type="button" onClick={() => window.print()} className="print:hidden"><Printer />{label}</Button>;
}
