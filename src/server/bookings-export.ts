import "server-only";
import { toCsv, type Cell } from "@/lib/export/csv.ts";
import { toXlsx } from "@/lib/export/xlsx.ts";
import type { Dictionary, Locale } from "@/i18n";
import { formatDate } from "@/lib/format.ts";

export type ExportRow = {
  customer_name: string; phone: string | null; email?: string | null; offering_name?: string; group_name: string; country: string; attendance: string;
  booked_at: string; booking_status: string; currency: string; list_price: number; discount_amount: number; final_price: number; confirmed: number;
  pending: number; rejected: number; remaining: number; payment_status: string; discount_status: string;
};

export function exportHeader(t: Dictionary): string[] {
  const b = t.bookings;
  return [b.xCustomer, b.xPhone, b.xEmail, b.xWorkshop, b.xGroup, b.xCountry, b.xAttendance, b.xBooked, b.xBookingStatus, b.xCurrency, b.xOriginal, b.xDiscount, b.xFinal,
    b.xConfirmed, b.xPending, b.xRejected, b.xRemaining, b.xPayStatus, b.xDiscountStatus];
}

/** One row per booking. Money stays numeric and in the booking's own currency (one column, never summed across currencies). */
export function exportRows(rows: ExportRow[], t: Dictionary, locale: Locale, tz: string): Cell[][] {
  const b = t.bookings;
  return rows.map((r) => [
    r.customer_name, r.phone, r.email ?? null, r.offering_name ?? null, r.group_name, r.country, r.attendance === "online" ? b.online : b.offline,
    formatDate(r.booked_at, tz, locale), b.bookingStatus[r.booking_status as keyof typeof b.bookingStatus] ?? r.booking_status, r.currency,
    Number(r.list_price), Number(r.discount_amount), Number(r.final_price), Number(r.confirmed), Number(r.pending), Number(r.rejected), Number(r.remaining),
    b.payStatus[r.payment_status as keyof typeof b.payStatus] ?? r.payment_status, b.discStatus[r.discount_status as keyof typeof b.discStatus] ?? r.discount_status,
  ]);
}

/** CSV or Excel attachment. The rows were loaded with the caller's own session (RLS and the database visibility rules already applied). */
export function exportResponse(format: "csv" | "xlsx", baseName: string, rows: ExportRow[], t: Dictionary, locale: Locale, tz: string, rtl: boolean): Response {
  const header = exportHeader(t);
  const body = exportRows(rows, t, locale, tz);
  const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "export";
  // HTTP header values must be Latin-1: an ASCII fallback in filename= and the real (Arabic or other) name in filename*= (RFC 5987)
  const asciiName = safeName.replace(/[^ -~]+/g, "_").replace(/_+/g, "_") || "export";
  const stamp = new Date().toISOString().slice(0, 10);
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
  if (format === "xlsx") {
    const bytes = toXlsx(t.bookings.title, header, body, { rtl });
    return new Response(Buffer.from(bytes), {
      headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${asciiName}-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(safeName)}-${stamp}.xlsx` },
    });
  }
  return new Response(toCsv(header, body), {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${asciiName}-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(safeName)}-${stamp}.csv` },
  });
}
