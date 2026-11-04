# Usage API (impetik fork)

A read-only sidecar on cloud-pc serves usage history for the dashboard's Usage page.
The proxy itself keeps no history; `cli-proxy-usage-collector.service` drains the proxy's
usage queue into `/var/lib/cli-proxy-api/usage.db` (table `usage`, one row per request).

- Base URL: `http://100.90.164.91:8318` (tailnet only). The dashboard derives it from its
  own API base: same host, port 8318.
- Auth: `Authorization: Bearer <management key>` — the same key the dashboard already
  sends to the Management API. Wrong or missing key: `401`.
- CORS: allows origin `http://100.90.164.91:8317`, method `GET`, header `Authorization`.
- All times are UTC ISO 8601. `from` is inclusive, `to` exclusive. Defaults: last 7 days.

## Token and cost fields (every aggregate row)

`requests`, `failed`, `input_tokens` (uncached input), `cache_read_tokens`,
`cache_write_tokens`, `output_tokens` (includes reasoning), `reasoning_tokens`,
`total_tokens`, `list_cost_usd`, `billed_cost_usd`, `avg_latency_ms`.

- `list_cost_usd`: tokens × the model's public API price. For subscription accounts
  (`auth_type` = `oauth`: Claude, Codex, Antigravity) this is what the usage would have
  cost on the API, not money spent.
- `billed_cost_usd`: money actually spent: only API-key providers (`auth_type` =
  `apikey`, e.g. OpenRouter). Zero for subscription traffic.
- A request whose model has no known price adds 0 to cost and its model is listed in
  `meta.unpriced_models`.

## Endpoints

### `GET /usage/aggregate`

Query: `from`, `to`, `group` (one of `key`, `model`, `provider`, `client`, `agent`,
`none`), `bucket` (`hour`, `day`, or omitted for no time split).

```json
{ "from": "...", "to": "...", "group": "key", "bucket": "day",
  "rows": [ { "t": "2026-11-04T00:00:00Z", "group": "ali", "requests": 12, "...": 0 } ] }
```

- `t` is present only when `bucket` is set. `group` is absent when `group=none`.
- Group values: `key` → key label (`ali`, `dirso-builder-staging`, `unlabelled-d40869`);
  `model` → model; `provider` → `provider/auth_type`; `client` → Tailscale machine name
  for the caller's IP (falls back to the IP); `agent` → user-agent family
  (`claude-code`, `codex`, `node`, `other`…).
- Rows are sorted by `t`, then by `list_cost_usd` descending.

### `GET /usage/requests`

Query: `from`, `to`, `limit` (default 100, max 1000), optional `key`, `model`, `client`.
Newest first. Each row: `ts`, `key`, `client` (machine name), `client_ip`, `agent`,
`user_agent`, `provider`, `auth_type`, `model`, `endpoint`, token fields, `list_cost_usd`,
`billed_cost_usd`, `latency_ms`, `failed`, `status_code`.

### `GET /usage/sessions`

One row per client session (`raw.session_id`; for Claude Code it is the Claude Code session
id). Query: `from`, `to`, `limit` (default 100, max 1000), optional `key`, `client`, `agent`.
Sorted by `last_ts` descending. Each row: `session`, `first_ts`, `last_ts`, `key`, `client`,
`agent`, `models` (array, by cost descending), plus every aggregate field above. A session
seen under several keys/clients/agents reports the one with the most requests.

`/usage/requests` also accepts `session=<id>` and returns `session` on each row.

### `GET /usage/meta`

`{ "first_ts", "last_ts", "keys": [...], "models": [...], "clients": [...],
"pricing": { "source": "openrouter", "fetched_at": "...", "unpriced_models": [...] } }`
