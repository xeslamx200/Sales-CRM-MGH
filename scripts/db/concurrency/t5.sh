#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md). Deterministic regression tests for the stale-contact defect of
# app.kapso_resolve_conversation (fixed by supabase/proposed/20261104000972_kapso_bsuid_contact_lock_recheck.sql):
#   fix1 : attach a BSUID to the conversation of a contact that is being merged
#   fix2 : promote a BSUID-only conversation (phone becomes known) while its contact is being merged
# Choreography: a transaction runs merge_contacts and stays open (holding both contact locks and the uncommitted move of the conversation);
# the webhook starts meanwhile, reads the conversation (still pointing at the merged-away contact) and blocks on the contact lock; the merge
# then commits. Before the fix the webhook keeps using the stale contact.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SUPER=$(q "select id from tests.users where key='super'")
JWT="select set_config('request.jwt.claims','{\"sub\":\"$SUPER\",\"role\":\"authenticated\"}',false);"

fix1() {
  local a ACC P ph1 ph2 bs K M conv_m
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph1=$(phone); ph2=$(phone); bs="BS-FIX1-$(next)"
  # K: a bsuid-only contact (no phone) ; M: a phone contact
  qa "select * from public.ingest_kapso_inbound('$P','wamid.fix1.k.$ACC',null,'BSK-$bs',null,'KeepFix1','text','hi',null,now());" >/dev/null
  qa "select * from public.ingest_kapso_inbound('$P','wamid.fix1.m.$ACC','$ph2',null,null,'MergeFix1','text','hi',null,now());" >/dev/null
  K=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='BSK-$bs'")
  M=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_wa_id='$ph2'")
  sess MG; sess WH
  send MG "$JWT"; send MG "begin; select public.merge_contacts('$K','$M'); select pg_sleep(2.5);"; sleep 0.8
  send WH "select * from public.ingest_kapso_inbound('$P','wamid.fix1.w.$ACC','$ph2','BSN-$bs',null,'MergeFix1','text','again',null,now());"
  wait_blocked WH && pass "T-FIX1-1 the webhook waits for the contact lock while the merge is in progress" || fail "T-FIX1-1" "webhook not blocked"
  send MG "commit;"; wait_unblocked WH; sleep 0.6; endsess MG; endsess WH
  check "T-FIX1-2 the merge completed (M merged into K)" "$(q "select (merged_into_id='$K')::text from public.contacts where id='$M'")" "true"
  check "T-FIX1-3 the new BSUID identity belongs to the SURVIVING contact, not to the merged-away one" "$(q "select (select count(*) from public.contact_identities where value='BSN-$bs' and contact_id='$K')||'/'||(select count(*) from public.contact_identities where contact_id='$M')")" "1/0"
  check "T-FIX1-4 no company link was (re)created for the merged contact" "$(q "select count(*) from public.contact_companies where contact_id='$M'")" "0"
  check "T-FIX1-5 the conversation belongs to the survivor and carries the bsuid" "$(q "select (contact_id='$K')::text||'/'||coalesce(customer_bsuid,'-') from public.conversations where whatsapp_account_id='$ACC' and customer_wa_id='$ph2'")" "true/BSN-$bs"
  check "T-FIX1-6 no identity of this account points at a merged contact" "$(q "select count(*) from public.contact_identities i join public.contacts k on k.id=i.contact_id where i.whatsapp_account_id='$ACC' and k.merged_into_id is not null")" "0"
}

fix2() {
  local a ACC P ph1 ph2 bs K M
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph1=$(phone); ph2=$(phone); bs="BS-FIX2-$(next)"
  qa "select * from public.ingest_kapso_inbound('$P','wamid.fix2.k.$ACC','$ph1',null,null,'KeepFix2','text','hi',null,now());" >/dev/null
  qa "select * from public.ingest_kapso_inbound('$P','wamid.fix2.m.$ACC',null,'$bs',null,'MergeFix2','text','hi',null,now());" >/dev/null
  K=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_wa_id='$ph1'")
  M=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")
  sess MG2; sess WH2
  send MG2 "$JWT"; send MG2 "begin; select public.merge_contacts('$K','$M'); select pg_sleep(2.5);"; sleep 0.8
  send WH2 "select * from public.ingest_kapso_inbound('$P','wamid.fix2.w.$ACC','$ph2','$bs',null,'MergeFix2','text','phone appears',null,now());"
  wait_blocked WH2 && pass "T-FIX2-1 the webhook (promotion path) waits for the contact lock" || fail "T-FIX2-1" "webhook not blocked"
  send MG2 "commit;"; wait_unblocked WH2; sleep 0.6; endsess MG2; endsess WH2
  check "T-FIX2-2 the merged-away contact did NOT receive the phone" "$(q "select coalesce(phone_e164,'null') from public.contacts where id='$M'")" "null"
  check "T-FIX2-3 the conversation (now the survivor's) was promoted with the new phone" "$(q "select (contact_id='$K')::text||'/'||coalesce(customer_wa_id,'-') from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")" "true/$ph2"
  check "T-FIX2-4 no company link for the merged contact; no identity on it" "$(q "select (select count(*) from public.contact_companies where contact_id='$M')||'/'||(select count(*) from public.contact_identities where contact_id='$M')")" "0/0"
}

for t in "$@"; do case "$t" in fix1) fix1;; fix2) fix2;; esac; done
check "T-LOCK-7 invariant" "$(inv_company)" "0"
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"
