#!/usr/bin/env bash
# Usage: usage-report.sh [since] [until]   (any `date -d` string; default: last 7 days)
set -euo pipefail
DB=${USAGE_DB:-/var/lib/cli-proxy-api/usage.db}
# date validates the input, so the values are safe to embed in SQL.
s=$(date -u -d "${1:-7 days ago}" +%Y-%m-%dT%H:%M:%S.000Z)
u=$(date -u -d "${2:-now}" +%Y-%m-%dT%H:%M:%S.999Z)
echo "Usage $s .. $u"
sqlite3 -box "$DB" <<SQL
SELECT key_label, model, count(*) AS requests, sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(failed) AS failures
FROM usage WHERE ts BETWEEN '$s' AND '$u' GROUP BY 1, 2 ORDER BY requests DESC;
SELECT client_ip, group_concat(DISTINCT key_label) AS keys, count(*) AS requests, sum(input_tokens) AS input,
       sum(output_tokens) AS output, sum(cache_read_tokens) AS cache_read, sum(failed) AS failures
FROM usage WHERE ts BETWEEN '$s' AND '$u' GROUP BY 1 ORDER BY requests DESC;
SQL
