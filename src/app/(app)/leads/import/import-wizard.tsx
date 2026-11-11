"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { useI18n } from "@/components/i18n-provider";
import { commitImport, previewImport, type ImportPreview, type ImportResult } from "@/actions/import";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, toCsv } from "@/lib/csv.ts";
import { formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";

type Option = { value: string; label: string };

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportWizard({ companies, defaultCompanyId }: { companies: Option[]; defaultCompanyId: string }) {
  const { t, locale } = useI18n();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [skipDup, setSkipDup] = useState(true);
  const [pending, start] = useTransition();

  const reset = () => { setCsv(null); setPreview(null); setResult(null); setFileName(""); };

  const onFile = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(t.import.tooLarge);
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    start(async () => {
      const res = await previewImport({ companyId, csv: text, skipFileDuplicates: true });
      if (res.ok) setPreview(res.data);
      else toast.error(res.error);
    });
  };

  const template = () =>
    download("leads-template.csv", toCsv(
      ["الاسم", "الهاتف", "البريد الإلكتروني", "العنوان", "المصدر", "الحملة", "الأولوية", "القيمة المتوقعة", "ملاحظات", "بريد المسؤول"],
      [["سارة أحمد", "+97455550001", "sara@example.com", "استفسار عن دورة", "website", "خريف 2026", "medium", "1500", "", ""]],
    ));

  const n = (v: number) => formatNumber(v, locale);
  const issue = (k: string) => t.import.errors[k as keyof typeof t.import.errors] ?? k;
  const warning = (k: string) => t.import.warnings[k as keyof typeof t.import.warnings] ?? k;

  return (
    <div className="flex flex-col gap-4">
      <Section title={t.import.step1}>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">{fmt(t.import.limits, { rows: n(MAX_IMPORT_ROWS), mb: 2 })}</p>
          <p className="text-muted-foreground">{t.import.columnsHelp}</p>
          <div className="flex flex-wrap items-center gap-2">
            {companies.length > 1 && (
              <Select value={companyId} onValueChange={(v) => { setCompanyId(v); reset(); }}>
                <SelectTrigger className="w-56" aria-label={t.common.company}><SelectValue /></SelectTrigger>
                <SelectContent>{companies.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button variant="outline" asChild>
              <label className="cursor-pointer">
                <FileUp />{t.import.chooseFile}
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </Button>
            <Button variant="ghost" onClick={template}><Download />{t.import.template}</Button>
            {fileName && <span className="text-muted-foreground" dir="ltr">{fileName}</span>}
            {pending && <Loader2 className="size-4 animate-spin" />}
          </div>
        </div>
      </Section>

      {preview && !result && (
        <Section title={t.import.step2}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <StatusBadge tone="primary">{fmt(t.import.total, { count: n(preview.total) })}</StatusBadge>
              <StatusBadge tone="success">{fmt(t.import.valid, { count: n(preview.valid) })}</StatusBadge>
              {preview.invalid > 0 && <StatusBadge tone="danger">{fmt(t.import.invalid, { count: n(preview.invalid) })}</StatusBadge>}
              {preview.duplicatesInFile > 0 && <StatusBadge tone="warning">{fmt(t.import.duplicatesInFile, { count: n(preview.duplicatesInFile) })}</StatusBadge>}
              {preview.existingContacts > 0 && <StatusBadge tone="info">{fmt(t.import.existingContacts, { count: n(preview.existingContacts) })}</StatusBadge>}
            </div>
            {preview.unknownHeaders.length > 0 && (
              <p className="text-xs text-muted-foreground">{t.import.ignoredColumns}: {preview.unknownHeaders.join("، ")}</p>
            )}
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 text-start">{t.import.line}</TableHead>
                    <TableHead className="text-start">{t.common.name}</TableHead>
                    <TableHead className="text-start">{t.common.phone}</TableHead>
                    <TableHead className="text-start">{t.common.status}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...preview.problems, ...preview.sample.filter((s) => s.errors.length === 0)].slice(0, 100).map((r) => (
                    <TableRow key={r.line}>
                      <TableCell className="ltr-nums">{r.line}</TableCell>
                      <TableCell>{r.name || "—"}</TableCell>
                      <TableCell className="ltr-nums">{r.phone ?? "—"}</TableCell>
                      <TableCell className="flex flex-wrap gap-1">
                        {r.errors.map((e) => <StatusBadge key={e} tone="danger">{issue(e)}</StatusBadge>)}
                        {r.warnings.map((w) => <StatusBadge key={w} tone="warning">{warning(w)}</StatusBadge>)}
                        {r.errors.length === 0 && r.warnings.length === 0 && <StatusBadge tone="success">{t.import.ok}</StatusBadge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Checkbox id="skip-dup" checked={skipDup} onCheckedChange={(v) => setSkipDup(v === true)} />
                <Label htmlFor="skip-dup" className="font-normal">{t.import.skipDuplicates}</Label>
              </div>
              <Button
                disabled={pending || preview.valid === 0 || !csv}
                onClick={() =>
                  start(async () => {
                    const res = await commitImport({ companyId, csv: csv!, skipFileDuplicates: skipDup });
                    if (res.ok) setResult(res.data);
                    else toast.error(res.error);
                  })
                }
              >
                {pending && <Loader2 className="animate-spin" />}
                {fmt(t.import.importNow, { count: n(Math.max(0, preview.valid - (skipDup ? preview.duplicatesInFile : 0))) })}
              </Button>
            </div>
          </div>
        </Section>
      )}

      {result && (
        <Alert variant={result.failed > 0 ? "default" : "default"}>
          {result.failed > 0 ? <AlertTriangle /> : <CheckCircle2 />}
          <AlertTitle>{fmt(t.import.done, { count: n(result.imported) })}</AlertTitle>
          <AlertDescription>
            <p>{fmt(t.import.doneDetail, { linked: n(result.linkedExisting), failed: n(result.failed), skipped: n(result.skipped) })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {result.reportCsv && (
                <Button size="sm" variant="outline" onClick={() => download("import-errors.csv", result.reportCsv!)}>
                  <Download />{t.import.downloadReport}
                </Button>
              )}
              <Button size="sm" asChild><Link href="/leads">{t.nav.leads}</Link></Button>
              <Button size="sm" variant="ghost" onClick={reset}>{t.import.another}</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
