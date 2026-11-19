# Usage collector and API (cloud-pc)

Deployed copies of the server side of the Usage page. See `docs/usage-api.md` for the contract.

| File | Installed at |
|---|---|
| `usage-collector.sh`, `usage-collector-test.sh`, `usage-report.sh`, `usage-api.py`, `usage-api-test.py` | `/opt/cli-proxy-api/` |
| `cli-proxy-usage-collector.service`, `cli-proxy-usage-api.service` | `/etc/systemd/system/` |
| `keytool.sh`, `keytool-test.sh` | `/opt/cli-proxy-api/` |
| `../plugin/key-quota/` (built as `key-quota.so`) | `/opt/cli-proxy-api/plugins/key-quota.so` |

The collector is the only reader of the proxy's usage queue: every read deletes records, so
never read the queue by hand while it runs. Data: `/var/lib/cli-proxy-api/usage.db`; prices:
`/var/lib/cli-proxy-api/usage-prices.db` (OpenRouter, refreshed daily).

## Per-key quotas

`keytool.sh limit <key> 5h=<usd> day=<usd>` (or `off`) writes `/opt/cli-proxy-api/quotas.json`;
`keytool.sh limits` shows use and blocks. `usage-api.py` checks the limits every 10 s against
list cost and writes `/var/lib/cli-proxy-api/quota-blocked.json`. The `key-quota` plugin reads
that file and answers `429` + `Retry-After` for blocked keys, before any upstream call. The key
name is the label in `usage.db`; the main key is `unlabelled-<first 6 chars>`.

Build and install the plugin on cloud-pc (needs Go in `/usr/local/go` and gcc). Rebuild after
every proxy upgrade, since the plugin ABI belongs to the proxy version:

```bash
cd plugin/key-quota && go test . && \
  CGO_ENABLED=1 go build -trimpath -buildmode=c-shared -ldflags "-s -w" -o key-quota.so .
install -m 0644 key-quota.so /opt/cli-proxy-api/plugins/key-quota.so && systemctl restart cli-proxy-api
```

Enabled in `config.yaml` by `plugins.enabled: true` and `plugins.configs.key-quota.enabled: true`.
Limits: a key goes over by up to ~20 s of traffic (collector + checker intervals), running
requests finish, and `/v1/realtime*` and `/v1/alpha/search` skip plugins.
