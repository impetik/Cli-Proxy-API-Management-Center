#!/usr/bin/env bash
# Self-check for `keytool.sh limit` against a temp quotas file. Runs on cloud-pc: it reads the
# live key list (read-only) to check that limits only go to keys that exist.
set -uo pipefail
cd "$(dirname "$0")"
export QUOTAS_FILE=$(mktemp -d)/quotas.json
fail() { echo "keytool-test: FAIL $*"; exit 1; }
q() { jq -c . "$QUOTAS_FILE"; }
A=$(./keytool.sh list | awk 'NR>2 && $1 != "(unlabelled)" {print $1}' | sed -n 1p)
B=$(./keytool.sh list | awk 'NR>2 && $1 != "(unlabelled)" {print $1}' | sed -n 2p)
[ -n "$A" ] && [ -n "$B" ] || fail "needs two labelled keys on this proxy"

./keytool.sh limit "$A" 5h=5 day=20 >/dev/null || fail "set"
[ "$(q)" = "{\"$A\":{\"5h\":5,\"day\":20}}" ] || fail "set: $(q)"
./keytool.sh limit "$(echo "$B" | tr a-z A-Z)" day=2.5 >/dev/null || fail "name normalised like add"
./keytool.sh limit "$A" 5h=1 >/dev/null || fail "replace"
[ "$(q)" = "{\"$A\":{\"5h\":1},\"$B\":{\"day\":2.5}}" ] || fail "replace: $(q)"
for bad in "5h=0" "day=-1" "week=3" "5h=abc" "5h="; do
  ./keytool.sh limit "$A" "$bad" >/dev/null 2>&1 && fail "accepted $bad"
done
./keytool.sh limit no-such-key-xyz 5h=1 >/dev/null 2>&1 && fail "accepted a name with no key"
[ "$(q)" = "{\"$A\":{\"5h\":1},\"$B\":{\"day\":2.5}}" ] || fail "bad input changed the file: $(q)"
./keytool.sh limit "$A" off >/dev/null || fail "off"
./keytool.sh limit no-such-key-xyz off >/dev/null || fail "off must work for any name (stale entries)"
[ "$(q)" = "{\"$B\":{\"day\":2.5}}" ] || fail "off: $(q)"
[ "$(stat -c %a "$QUOTAS_FILE")" = 600 ] || fail "mode"
echo "keytool-test: all assertions passed"
