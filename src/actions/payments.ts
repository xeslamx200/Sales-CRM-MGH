"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { AppError, check, must, runAction, type ActionResult } from "@/server/action";
import { requirePermission } from "@/server/auth/permissions";
import { limitUser } from "@/server/rate-limit";
import { normalizePhone } from "@/lib/phone.ts";
import { balanceSchema, paymentSchema, reviewSchema, searchSchema, type PaymentInput, type ReviewInput } from "@/schemas/payments";

/** Country code used for LOCAL phone numbers typed by an employee: Egyptian companies (Cairo time zone) use 20, the rest keep the app default. */
const countryCodeFor = (timezone: string | null | undefined) => (timezone === "Africa/Cairo" ? "20" : "974");

export type CustomerHit = { id: string; name: string; phone: string | null };

/** Customers of one company that the user may see (RLS), matched by name or phone digits. At most 8. */
export async function searchCustomers(input: z.input<typeof searchSchema>): Promise<ActionResult<CustomerHit[]>> {
  return runAction(searchSchema, input, async ({ companyId, q }) => {
    const supabase = await createClient();
    await limitUser(supabase, "search");
    const safe = q.replace(/[%,()*\\"']/g, " ").trim();
    const digits = safe.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
    const ors = [`full_name.ilike.*${safe}*`];
    if (digits.length >= 4) ors.push(`phone_e164.like.*${digits.replace(/^0+/, "")}*`);
    const { data, error } = await supabase.from("contacts")
      .select("id, full_name, phone_e164, contact_companies!inner(company_id)")
      .eq("contact_companies.company_id", companyId).is("merged_into_id", null).or(ors.join(",")).limit(8);
    if (error) throw error;
    return (data ?? []).map((c) => ({ id: c.id, name: c.full_name, phone: c.phone_e164 }));
  });
}

export type Balance = { priceEgp: number | null; confirmedEgp: number; pendingEgp: number };

/** What a customer has paid (confirmed / pending) for one workshop, over ALL payments of that pair. */
export async function customerBalance(input: z.input<typeof balanceSchema>): Promise<ActionResult<Balance>> {
  return runAction(balanceSchema, input, async ({ contactId, offeringId }) => {
    const supabase = await createClient();
    const [r] = must(await supabase.rpc("payment_balance", { p_contact_id: contactId, p_offering_id: offeringId }));
    return { priceEgp: r.price_egp == null ? null : Number(r.price_egp), confirmedEgp: Number(r.confirmed_egp), pendingEgp: Number(r.pending_egp) };
  });
}

/**
 * Record a payment (status pending). Order: workshop (its company) -> customer (existing, or created/linked from name + phone) ->
 * record_payment, which re-checks everything and reads the exchange rate itself. The proof image is uploaded by the browser afterwards
 * through the attachments flow, against the returned payment id.
 */
export async function savePayment(input: PaymentInput): Promise<ActionResult<{ paymentId: string }>> {
  return runAction(paymentSchema, input, async (d) => {
    const supabase = await createClient();
    await limitUser(supabase, "payment");
    const off = check(await supabase.from("company_offerings").select("company_id").eq("id", d.offeringId).maybeSingle());
    if (!off) throw new AppError("payment.offering_not_found");
    await requirePermission(off.company_id, "record_payments");
    let contactId = d.contactId;
    if (!contactId) {
      const { data: company } = await supabase.from("companies").select("timezone").eq("id", off.company_id).maybeSingle();
      const phone = normalizePhone(d.newPhone, countryCodeFor(company?.timezone));
      if (!phone.ok) throw new AppError("phone.invalid");
      const [r] = must(await supabase.rpc("find_or_create_contact", {
        p_company_id: off.company_id, p_full_name: d.newName ?? "", p_phone_e164: phone.e164,
      }));
      contactId = r.contact_id;
    }
    const id = must(await supabase.rpc("record_payment", {
      p_contact_id: contactId, p_offering_id: d.offeringId, p_amount: d.amount, p_currency: d.currency, p_kind: d.kind,
      p_paid_on: d.paidOn ?? undefined, p_note: d.note ?? undefined,
    }));
    revalidatePath("/payments");
    return { paymentId: id };
  });
}

/** Confirm or reject (managers). The database enforces who may do what and the allowed transitions. */
export async function reviewPayment(input: ReviewInput): Promise<ActionResult<null>> {
  return runAction(reviewSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("review_payment", { p_id: d.id, p_decision: d.decision, p_note: d.note ?? undefined }));
    revalidatePath("/payments");
    return null;
  });
}
