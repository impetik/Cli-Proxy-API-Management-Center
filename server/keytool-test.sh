#!/usr/bin/env bash
# Self-check for `keytool.sh limit` against a temp quotas file (no proxy needed).
set -uo pipefail
cd "$(dirname "$0")"
export QUOTAS_FILE=$(mktemp -d)/quotas.json CLIPROXY_MGMT_KEY=unused
fail() { echo "keytool-test: FAIL $*"; exit 1; }
q() { jq -c . "$QUOTAS_FILE"; }

./keytool.sh limit laptop 5h=5 day=20 >/dev/null || fail "set"
[ "$(q)" = '{"laptop":{"5h":5,"day":20}}' ] || fail "set: $(q)"
./keytool.sh limit desk day=2.5 >/dev/null || fail "second key"
./keytool.sh limit laptop 5h=1 >/dev/null || fail "replace"
[ "$(q)" = '{"laptop":{"5h":1},"desk":{"day":2.5}}' ] || fail "replace: $(q)"
for bad in "5h=0" "day=-1" "week=3" "5h=abc" "5h="; do
  ./keytool.sh limit laptop "$bad" >/dev/null 2>&1 && fail "accepted $bad"
done
[ "$(q)" = '{"laptop":{"5h":1},"desk":{"day":2.5}}' ] || fail "bad input changed the file: $(q)"
./keytool.sh limit laptop off >/dev/null || fail "off"
[ "$(q)" = '{"desk":{"day":2.5}}' ] || fail "off: $(q)"
[ "$(stat -c %a "$QUOTAS_FILE" 2>/dev/null || stat -f %Lp "$QUOTAS_FILE")" = 600 ] || fail "mode"
echo "keytool-test: all assertions passed"
