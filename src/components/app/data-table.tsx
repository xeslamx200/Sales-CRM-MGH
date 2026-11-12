import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/states";
import { fmt, type Dictionary } from "@/i18n";
import { formatNumber } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  className?: string;
};

/** Server-rendered table. Sorting/filtering/paging live in the URL. */
export function DataTable<T>({
  columns, rows, rowKey, empty, className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: { title: string; description?: string; action?: React.ReactNode };
  className?: string;
}) {
  if (rows.length === 0) return <EmptyState {...empty} />;
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            {columns.map((c) => (
              <TableHead key={c.key} className={cn("text-start", c.className)}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((c) => (
                <TableCell key={c.key} className={cn("align-middle", c.className)}>{c.cell(row)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Pagination links that preserve the other query parameters. */
export function Pagination({
  page, pageSize, total, searchParams, basePath, t,
}: {
  page: number;
  pageSize: number;
  total: number;
  searchParams: Record<string, string | string[] | undefined>;
  basePath: string;
  t: Dictionary;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (k === "page" || v == null) continue;
      for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
    }
    if (p > 1) sp.set("page", String(p));
    const q = sp.toString();
    return q ? `${basePath}?${q}` : basePath;
  };
  return (
    <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>{fmt(t.common.totalRows, { count: formatNumber(total) })}</span>
      <div className="flex items-center gap-2">
        <span>{fmt(t.common.page, { page: formatNumber(page), pages: formatNumber(pages) })}</span>
        <Button variant="outline" size="icon-sm" asChild={page > 1} disabled={page <= 1} aria-label={t.common.previous}>
          {page > 1 ? <Link href={href(page - 1)} prefetch={false}><ChevronRight className="ltr:rotate-180" /></Link> : <ChevronRight className="ltr:rotate-180" />}
        </Button>
        <Button variant="outline" size="icon-sm" asChild={page < pages} disabled={page >= pages} aria-label={t.common.next}>
          {page < pages ? <Link href={href(page + 1)} prefetch={false}><ChevronLeft className="ltr:rotate-180" /></Link> : <ChevronLeft className="ltr:rotate-180" />}
        </Button>
      </div>
    </div>
  );
}
