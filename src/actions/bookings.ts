"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, must, runAction, type ActionResult } from "@/server/action";
import { limitUser } from "@/server/rate-limit";
import { requestLocale } from "@/server/i18n";
import { errorKey, userMessage } from "@/lib/errors.ts";
import {
  approveDiscountSchema, bookingPaymentSchema, bookingSchema, cancelBookingSchema, discountRequestSchema, rejectDiscountSchema, workshopOptionsSchema,
  type ApproveDiscountInput, type BookingInput, type BookingPaymentInput, type CancelBookingInput, type DiscountRequestInput, type RejectDiscountInput,
} from "@/schemas/bookings";
import type { z } from "zod";

// Every rule (price lookup and freezing, discount policy and approval, capacity, duplicates, overpayment, who may do what) is enforced by the database
// functions of migrations 985 / 986. These actions validate the shape, call them with the user's own session, and translate errors.

export type GroupOption = { id: string; name: string; sessions: string[]; capacity: number | null; booked: number; attendance: "online" | "offline" | null };
export type PriceOption = { country: string; attendance: "online" | "offline"; currency: string; price: number };

/** Active groups (with seats taken) and active prices of one workshop, for the booking form. */
export async function workshopOptions(input: z.input<typeof workshopOptionsSchema>): Promise<ActionResult<{ groups: GroupOption[]; prices: PriceOption[] }>> {
  return runAction(workshopOptionsSchema, input, async ({ offeringId }) => {
    const supabase = await createClient();
    const [groups, stats, prices] = await Promise.all([
      supabase.from("workshop_groups").select("id, name, sessions, capacity, attendance, is_active").eq("offering_id", offeringId).eq("is_active", true).order("starts_on"),
      supabase.rpc("workshop_group_stats", { p_offering_id: offeringId }),
      supabase.from("workshop_prices").select("country, attendance, currency, price").eq("offering_id", offeringId).eq("is_active", true).order("country"),
    ]);
    if (groups.error) throw groups.error;
    if (stats.error) throw stats.error;
    if (prices.error) throw prices.error;
    const booked = new Map((stats.data ?? []).map((s) => [s.group_id, Number(s.booked)]));
    return {
      groups: (groups.data ?? []).map((g) => ({ id: g.id, name: g.name, sessions: g.sessions, capacity: g.capacity, booked: booked.get(g.id) ?? 0, attendance: g.attendance as GroupOption["attendance"] })),
      prices: (prices.data ?? []).map((p) => ({ country: p.country, attendance: p.attendance as PriceOption["attendance"], currency: p.currency, price: Number(p.price) })),
    };
  });
}

/** Create a booking. A discount above 10 % does NOT apply: the booking is created at the full price and the discount waits for approval. */
export async function createBooking(input: BookingInput): Promise<ActionResult<{ bookingId: string; paymentId: string | null; paymentError: string | null }>> {
  return runAction(bookingSchema, input, async (d) => {
    const supabase = await createClient();
    const id = must(await supabase.rpc("create_workshop_booking", {
      p_contact_id: d.contactId, p_group_id: d.groupId, p_country: d.country, p_attendance: d.attendance,
      p_discount_type: d.discountType, p_discount_value: d.discountValue ?? 0, p_discount_reason: d.discountReason ?? undefined, p_note: d.note ?? undefined,
    }));
    revalidatePath("/bookings");
    // optional first payment: a separate, checked call (the booking exists either way; a refused payment is reported, never hidden)
    let paymentError: string | null = null;
    let paymentId: string | null = null;
    if (d.paidNow != null) {
      try {
        await limitUser(supabase, "payment");
        paymentId = must(await supabase.rpc("record_booking_payment", { p_booking_id: id, p_amount: d.paidNow }));
        revalidatePath("/payments"); revalidatePath("/customer-payments");
      } catch (err) {
        paymentError = userMessage(errorKey(err), await requestLocale());
      }
    }
    return { bookingId: id, paymentId, paymentError };
  });
}

export async function cancelBooking(input: CancelBookingInput): Promise<ActionResult<null>> {
  return runAction(cancelBookingSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("cancel_workshop_booking", { p_id: d.bookingId, p_reason: d.reason }));
    revalidatePath("/bookings"); revalidatePath(`/bookings/${d.bookingId}`);
    return null;
  });
}

/** Record a payment on a booking, in the booking's currency (status pending until an approver decides). */
export async function recordBookingPayment(input: BookingPaymentInput): Promise<ActionResult<{ paymentId: string }>> {
  return runAction(bookingPaymentSchema, input, async (d) => {
    const supabase = await createClient();
    await limitUser(supabase, "payment");
    const id = must(await supabase.rpc("record_booking_payment", { p_booking_id: d.bookingId, p_amount: d.amount, p_paid_on: d.paidOn ?? undefined, p_note: d.note ?? undefined }));
    revalidatePath(`/bookings/${d.bookingId}`); revalidatePath("/payments"); revalidatePath("/customer-payments");
    return { paymentId: id };
  });
}

export async function requestDiscount(input: DiscountRequestInput): Promise<ActionResult<null>> {
  return runAction(discountRequestSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("request_booking_discount", { p_booking_id: d.bookingId, p_type: d.type, p_value: d.value, p_reason: d.reason }));
    revalidatePath(`/bookings/${d.bookingId}`); revalidatePath("/bookings");
    return null;
  });
}

export async function approveDiscount(input: ApproveDiscountInput): Promise<ActionResult<null>> {
  return runAction(approveDiscountSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("approve_booking_discount", { p_request_id: d.requestId, p_note: d.note ?? undefined }));
    revalidatePath("/bookings"); revalidatePath("/customer-payments");
    return null;
  });
}

export async function rejectDiscount(input: RejectDiscountInput): Promise<ActionResult<null>> {
  return runAction(rejectDiscountSchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("reject_booking_discount", { p_request_id: d.requestId, p_reason: d.reason }));
    revalidatePath("/bookings");
    return null;
  });
}
