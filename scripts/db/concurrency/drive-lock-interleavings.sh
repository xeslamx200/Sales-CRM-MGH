#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md).
# Creates two fresh Kapso production accounts (no conversations) per requested test and runs lock-interleavings.sh <test> against them.
#   drive-lock-interleavings.sh 1 2 3 6 id
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for t in "$@"; do
  a=$(mkacct); b=$(mkacct)
  echo "================ lock-interleavings.sh $t   (account A: ${a##*|}  account B: ${b##*|})"
  PNID="${a##*|}" ACC="${a%%|*}" PNID2="${b##*|}" ACC2="${b%%|*}" C_OLD="$ALPHA" C_NEW="$BETA" timeout 120 bash "$HERE/lock-interleavings.sh" "$t"
  echo "exit code: $?"
done
