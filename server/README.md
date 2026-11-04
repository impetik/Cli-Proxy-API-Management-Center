# Usage collector and API (cloud-pc)

Deployed copies of the server side of the Usage page. See `docs/usage-api.md` for the contract.

| File | Installed at |
|---|---|
| `usage-collector.sh`, `usage-collector-test.sh`, `usage-report.sh`, `usage-api.py`, `usage-api-test.py` | `/opt/cli-proxy-api/` |
| `cli-proxy-usage-collector.service`, `cli-proxy-usage-api.service` | `/etc/systemd/system/` |

The collector is the only reader of the proxy's usage queue: every read deletes records, so
never read the queue by hand while it runs. Data: `/var/lib/cli-proxy-api/usage.db`; prices:
`/var/lib/cli-proxy-api/usage-prices.db` (OpenRouter, refreshed daily).
