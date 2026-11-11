import { redirect } from "next/navigation";

/** Customer payments is now the "Bookings" tab of the one Bookings & payments section; old links keep working with their filters. */
export default async function CustomerPaymentsRedirect({ searchParams }: PageProps<"/customer-payments">) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  redirect(q.toString() ? `/bookings?${q}` : "/bookings");
}
