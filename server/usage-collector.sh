#!/usr/bin/env bash
# Drains CLIProxyAPI's usage queue into SQLite every 10 s. Sourceable (the test reuses process_file).
# Every popped batch is written to $SPILL before insert and deleted only after the insert succeeds.
DB=${USAGE_DB:-/var/lib/cli-proxy-api/usage.db}
SPILL=${USAGE_SPILL:-/var/lib/cli-proxy-api/usage-spill}
URL='http://100.90.164.91:8317/v8/management/observability/usage/queue?count=500'
KEYFILE=/root/.cliproxy-mgmt-key
umask 077

log() { echo "usage-collector: $*" >&2; }

# Raw JSON array -> cleaned array. Client keys become labels; upstream keys keep 8 chars.
clean() {
  jq -c '
    def scrub: gsub("cpx-(?<k>[A-Za-z0-9-]+)";
                    .k | if test("^.+-[0-9a-f]{32}$") then sub("-[0-9a-f]{32}$"; "") else "unlabelled-" + .[:6] end)
             | gsub("(?<k>(sk-or-v1-|hnk_)[A-Za-z0-9_-]+)"; .k[:8] + "***");
    map(del(.response_headers)
        | if ((.fail.body? // "") | tostring | length) > 4096 then del(.fail.body) else . end
        | walk(if type == "string" then scrub else . end))'
}

init_db() {
  mkdir -p "$(dirname "$DB")" "$SPILL"
  sqlite3 "$DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS usage (
  request_id TEXT PRIMARY KEY, ts TEXT, key_label TEXT, client_ip TEXT, user_agent TEXT,
  provider TEXT, model TEXT, alias TEXT, endpoint TEXT,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_tokens INTEGER,
  latency_ms INTEGER, failed INTEGER, status_code INTEGER, raw TEXT);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_key_label ON usage(key_label);
SQL
}

# $1 = file holding a raw popped batch. Returns non-zero (file kept by caller) on any failure.
process_file() {
  local c; c=$(mktemp) || return 1
  if ! clean < "$1" > "$c"; then rm -f "$c"; return 1; fi
  # Path is our own mktemp name; record values only reach SQLite through json_each.
  sqlite3 -bail "$DB" >/dev/null <<SQL
.timeout 10000
INSERT OR IGNORE INTO usage SELECT
  json_extract(value,'\$.request_id'),
  coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(value,'\$.timestamp')), json_extract(value,'\$.timestamp')),
  json_extract(value,'\$.api_key'), json_extract(value,'\$.client_ip'), json_extract(value,'\$.user_agent'),
  json_extract(value,'\$.provider'), json_extract(value,'\$.model'), json_extract(value,'\$.alias'), json_extract(value,'\$.endpoint'),
  json_extract(value,'\$.tokens.input_tokens'), json_extract(value,'\$.tokens.output_tokens'), json_extract(value,'\$.tokens.reasoning_tokens'),
  max(coalesce(json_extract(value,'\$.tokens.cache_read_tokens'),0), coalesce(json_extract(value,'\$.tokens.cached_tokens'),0)),
  json_extract(value,'\$.tokens.cache_creation_tokens'), json_extract(value,'\$.tokens.total_tokens'),
  json_extract(value,'\$.latency_ms'), json_extract(value,'\$.failed'), json_extract(value,'\$.fail.status_code'),
  value
FROM json_each(CAST(readfile('$c') AS TEXT));
SQL
  local rc=$?; rm -f "$c"; return $rc
}

drain() {
  local f
  for f in "$SPILL"/*.json; do   # retry earlier batches first
    [ -e "$f" ] || break
    if process_file "$f"; then rm -f "$f"; else log "insert failed, kept $f"; fi
  done
  while [ -z "${stop:-}" ]; do
    f="$SPILL/$(date -u +%Y%m%dT%H%M%S%N).json"
    if ! curl -sSf --max-time 30 -o "$f.part" \
         -H @<(printf 'Authorization: Bearer %s\n' "$(<"$KEYFILE")") "$URL"; then
      log "queue fetch failed"; rm -f "$f.part"; return
    fi
    if [ "$(jq length "$f.part" 2>/dev/null)" = 0 ]; then rm -f "$f.part"; return; fi
    mv "$f.part" "$f"
    if process_file "$f"; then rm -f "$f"; else log "insert failed, kept $f"; return; fi
  done
}

main() {
  trap 'stop=1' TERM INT   # finish the current batch before exiting
  init_db || exit 1
  while [ -z "${stop:-}" ]; do drain; sleep 10 & wait $!; done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi
