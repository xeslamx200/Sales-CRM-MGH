/**
 * Protocol / account compatibility (fail closed). The webhook protocol is a deployment setting (KAPSO_PROTOCOL); the account model is in
 * the database (kapso_account_protocol, supabase/migrations/20261104000978). Neither is trusted alone:
 *
 *                      sandbox account   production account          misconfigured account   unknown / inactive   pre-Rev6 schema
 *   v1 (default)       process           QUARANTINE v2_required      QUARANTINE              process (DB refuses)  process (all sandbox)
 *   v2 (explicit)      process           process                     QUARANTINE              process (DB refuses)  — (v2 needs Rev6: 503)
 *
 * "misconfigured" = the account row contradicts itself (environment vs connection mode vs the sandbox flag of its company); a person has to
 * fix it. v2 serves sandbox accounts through the Rev6 wrappers, which delegate phone-only sandbox traffic to the unchanged 0960 functions.
 * Production traffic therefore only ever flows when KAPSO_PROTOCOL=v2 is set explicitly.
 */
export type KapsoProtocol = "v1" | "v2";
export type AccountClass = "sandbox" | "production" | "misconfigured" | "pre_rev6" | null;
export type ProtocolDecision = "process" | "protocol.v2_required" | "account.misconfigured";

export function protocolDecision(protocol: KapsoProtocol, account: AccountClass): ProtocolDecision {
  if (account === "misconfigured") return "account.misconfigured";
  if (protocol === "v1" && account === "production") return "protocol.v2_required";
  return "process";
}
