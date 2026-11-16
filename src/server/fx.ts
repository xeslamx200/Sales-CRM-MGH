import "server-only";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { applyFixedRates, FX_SOURCE_NAME, FX_SOURCE_URL, parseExchangeRates, ratesNeedRefresh, type RateTable } from "@/lib/fx.ts";

/** Rates as stored (any signed-in user may read public.fx_rates; the form uses them for the EGP preview). */
export async function readRates(): Promise<RateTable> {
  const supabase = await createClient();
  const { data } = await supabase.from("fx_rates").select("currency, rate_to_egp, fetched_at");
  const out: RateTable = {};
  for (const r of data ?? []) out[r.currency.trim()] = { rateToEgp: Number(r.rate_to_egp), fetchedAt: r.fetched_at };
  return out;
}

/** Fetch from the external source and store through the service-role RPC. Never throws: on any problem the stored rates stay as they are. */
export async function refreshRates(): Promise<boolean> {
  // the fixed rates (QAR) are stored even when the external source cannot be reached: they never go stale
  let fetched: Record<string, number> | null = null;
  try {
    const res = await fetch(FX_SOURCE_URL, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { accept: "application/json" } });
    if (res.ok) fetched = parseExchangeRates(await res.json());
  } catch {
    fetched = null;
  }
  try {
    const { error } = await createAdminClient().rpc("upsert_fx_rates", { p_rates: applyFixedRates(fetched), p_source: FX_SOURCE_NAME });
    return !error && fetched !== null;
  } catch {
    return false;
  }
}

/** Stored rates, refreshed first when they are missing or older than 6 hours. */
export async function currentRates(): Promise<{ table: RateTable; refreshed: boolean }> {
  let table = await readRates();
  if (!ratesNeedRefresh(table)) return { table, refreshed: false };
  const ok = await refreshRates();
  if (ok) table = await readRates();
  return { table, refreshed: ok };
}
