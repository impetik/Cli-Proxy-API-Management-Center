#!/usr/bin/env bash
# Self-check for usage-collector.sh: feeds a fixed batch through process_file into a temp DB.
set -euo pipefail
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
export USAGE_DB="$dir/usage.db" USAGE_SPILL="$dir/spill"
source "$(dirname "$0")/usage-collector.sh"
init_db

H=0123456789abcdef0123456789abcdef
rec() { # request_id api_key source timestamp
  printf '{"timestamp":"%s","request_id":"%s","api_key":"%s","source":"%s","client_ip":"100.1.2.3","user_agent":"ua cpx-ali-%s","provider":"p","model":"m","alias":"a","endpoint":"/v1/x","latency_ms":5,"failed":true,"fail":{"status_code":429,"body":"%s"},"response_headers":{"X-Big":"h"},"tokens":{"input_tokens":10,"output_tokens":2,"reasoning_tokens":0,"cached_tokens":7,"cache_read_tokens":0,"cache_creation_tokens":0,"total_tokens":12}}' \
    "$4" "$1" "$2" "$3" "$H" "$(head -c 5000 /dev/zero | tr '\0' x)"
}
printf '[%s,%s,%s]' \
  "$(rec r1 "cpx-desktop-imfthhm-$H" "sk-or-v1-abcdef0123456789" "2026-11-04T12:00:01.123456789+03:00")" \
  "$(rec r2 "cpx-d40869000000000000000000000000000000000000000000" "hnk_secretsecretsecret" "2026-11-04T09:00:02Z")" \
  "$(rec r1 "cpx-desktop-imfthhm-$H" "dup" "2026-11-04T09:00:03Z")" > "$dir/batch.json"

process_file "$dir/batch.json"
process_file "$dir/batch.json"   # re-run (spill retry) must not duplicate

q() { sqlite3 "$USAGE_DB" "$1"; }
fail() { echo "FAIL: $*"; exit 1; }
[ "$(q 'select count(*) from usage')" = 2 ] || fail "row count"
[ "$(q "select key_label from usage where request_id='r1'")" = desktop-imfthhm ] || fail "labelled key"
[ "$(q "select key_label from usage where request_id='r2'")" = unlabelled-d40869 ] || fail "unlabelled key"
[ "$(q "select ts from usage where request_id='r1'")" = 2026-11-04T09:00:01.123Z ] || fail "ts normalised to UTC"
[ "$(q "select status_code||'/'||failed||'/'||cache_read_tokens from usage where request_id='r1'")" = 429/1/7 ] || fail "columns"
[ "$(q "select count(*) from usage where json_extract(raw,'$.response_headers') is not null or json_extract(raw,'$.fail.body') is not null")" = 0 ] || fail "response_headers/fail.body kept"
[ "$(q "select json_extract(raw,'$.source') from usage where request_id='r1'")" = 'sk-or-v1***' ] || fail "sk-or mask"
[ "$(q "select json_extract(raw,'$.source') from usage where request_id='r2'")" = 'hnk_secr***' ] || fail "hnk mask"
[ "$(q "select count(*) from usage where instr(raw,'cpx-') or instr(raw,'sk-or-v1-') or instr(raw,'hnk_secrets')")" = 0 ] || fail "secret in raw"
sqlite3 "$USAGE_DB" 'PRAGMA wal_checkpoint(TRUNCATE)' >/dev/null
! grep -aqE "cpx-|sk-or-v1-|hnk_secrets" "$USAGE_DB" || fail "secret in db file"
[ "$(q 'PRAGMA journal_mode')" = wal ] || fail "wal"
[ "$(q "select auth_type||'/'||inp||'/'||cr||'/'||cw||'/'||out||'/'||rsn||'/'||tot||'/'||session from usage where request_id='r1'")" = /10/7/0/2/0/12/r1 ] || fail "derived columns"
[ "$(q 'select count(*) from usage where tot is null')" = 0 ] || fail "unfilled rows"
echo "PASS: 2 rows, labels, masking, dedupe, ts, headers dropped"

# SIGTERM must end the collector cleanly (exit 0, no orphaned sleep). The queue URL points nowhere:
# reading the real queue deletes its records.
USAGE_QUEUE_URL=http://127.0.0.1:9/none USAGE_KEYFILE=/dev/null bash "$(dirname "$0")/usage-collector.sh" 2>/dev/null &
pid=$!; sleep 1; kill -TERM $pid
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
kill -0 $pid 2>/dev/null && fail "still running 2 s after SIGTERM"
rc=0; wait $pid || rc=$?; [ $rc = 0 ] || fail "exit code $rc after SIGTERM"
! pgrep -P $$ -x sleep >/dev/null || fail "orphaned sleep"
echo "PASS: clean SIGTERM exit"
