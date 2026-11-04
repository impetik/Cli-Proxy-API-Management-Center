#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Read-only usage API over the collector's usage.db. Contract: cpa-dashboard docs/usage-api.md."""
from contextlib import closing
import hmac, json, os, sqlite3, subprocess, threading, time, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

E = os.environ.get
USAGE_DB = E("USAGE_DB", "/var/lib/cli-proxy-api/usage.db")
PRICES_DB = E("PRICES_DB", "/var/lib/cli-proxy-api/usage-prices.db")
KEY = open(E("KEY_FILE", "/root/.cliproxy-mgmt-key")).read().strip().encode()
BIND, PORT = E("BIND", "100.90.164.91"), int(E("PORT", "8318"))
SELF_IP = "100.90.164.91"
ORIGIN = "http://100.90.164.91:8317"
# Proxy model names whose OpenRouter id is not "<vendor>/<same name>". Checked against /api/v1/models.
ALIASES = {
    "claude-opus-5-5": "anthropic/claude-opus-5.5", "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
    "claude-haiku-5-5": "anthropic/claude-haiku-5.5", "claude-fable-5-1": "anthropic/claude-fable-5.1",
    "gemini-3.8-flash-high": "google/gemini-3.8-flash", "mistral-large-4": "mistralai/mistral-large-4-0",
}
GROUPS = {"key": "key_label", "model": "model", "provider": "provider || '/' || auth_type",
          "client": "client", "agent": "agent", "none": None}
BUCKETS = {"hour": "substr(ts, 1, 13) || ':00:00Z'", "day": "substr(ts, 1, 10) || 'T00:00:00Z'", None: None}

prices, by_suffix, fetched_at, hosts = {}, {}, None, {}


def load_prices():
    global prices, by_suffix, fetched_at
    with sqlite3.connect(PRICES_DB) as db:
        db.execute("CREATE TABLE IF NOT EXISTS prices (id TEXT PRIMARY KEY, prompt REAL, completion REAL, cache_read REAL, cache_write REAL)")
        db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        p = {r[0]: r[1:] for r in db.execute("SELECT * FROM prices")}
        fetched_at = (db.execute("SELECT v FROM meta WHERE k = 'fetched_at'").fetchone() or [None])[0]
    by_suffix = {i.split("/", 1)[-1]: i for i in sorted(p) if not i.startswith("~") and ":" not in i}
    prices = p


def fetch_prices():
    with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=60) as r:
        data = json.load(r)["data"]
    num = lambda v: float(v) if v not in (None, "") else None
    rows = [(m["id"], num(pr.get("prompt")), num(pr.get("completion")), num(pr.get("input_cache_read")),
             num(pr.get("input_cache_write"))) for m in data if (pr := m.get("pricing"))]
    with sqlite3.connect(PRICES_DB) as db:
        db.execute("DELETE FROM prices")
        db.executemany("INSERT INTO prices VALUES (?,?,?,?,?)", rows)
        db.execute("INSERT OR REPLACE INTO meta VALUES ('fetched_at', ?)", (iso(datetime.now(timezone.utc)),))
    load_prices()


def price_of(model):
    i = ALIASES.get(model, model)
    return prices.get(i) or prices.get(by_suffix.get(i))


def cost(model, inp, cr, cw, out):
    p = price_of(model)
    if not p or p[0] is None: return 0.0
    prompt, completion, read, write = p
    return inp * prompt + cr * (read if read is not None else prompt) + cw * (write if write is not None else prompt) + out * (completion or 0)


def client_name(ip, resolved, xff):
    if ip != SELF_IP: return hosts.get(ip, ip)
    for cand in (resolved, (xff or "").split(",")[0].strip()):
        if cand and cand != SELF_IP and cand in hosts: return hosts[cand]
    return "cloud-pc (tunnel)"


def agent(ua):
    ua = (ua or "").lower()
    for prefix, name in (("claude-cli", "claude-code"), ("claude-code", "claude-code"), ("codex", "codex"),
                         ("ai/", "ai-sdk"), ("ai-sdk", "ai-sdk"), ("node", "node"), ("curl", "curl")):
        if ua.startswith(prefix): return name
    return "other"


def loop(fn, every):
    while True:
        try: fn()
        except Exception as e: print(f"{fn.__name__} failed: {e}", flush=True)
        time.sleep(every)


def refresh_prices():
    if not fetched_at or datetime.fromisoformat(fetched_at) < datetime.now(timezone.utc) - timedelta(days=1):
        fetch_prices()


def refresh_hosts():
    global hosts
    st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, check=True, timeout=30).stdout)
    hosts = {ip: n["HostName"] for n in [st["Self"], *st.get("Peer", {}).values()] for ip in n.get("TailscaleIPs") or []}


def iso(d): return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def parse_ts(s):
    d = datetime.fromisoformat(s)
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def connect():
    db = sqlite3.connect(f"file:{USAGE_DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.create_function("cost", 5, cost, deterministic=True)
    db.create_function("client_name", 3, client_name)
    db.create_function("agent", 1, agent, deterministic=True)
    return db


# Normalised rows: tokens from raw.token_breakdown (schema 2), columns only as fallback.
NORM = """WITH n AS (SELECT ts, key_label, client_ip, user_agent, provider, model, endpoint, latency_ms, failed, status_code,
  COALESCE(json_extract(raw, '$.auth_type'), '') AS auth_type,
  COALESCE(json_extract(raw, '$.token_breakdown.input.uncached_tokens'), input_tokens, 0) AS inp,
  COALESCE(json_extract(raw, '$.token_breakdown.input.cache_read_tokens'), cache_read_tokens, 0) AS cr,
  COALESCE(json_extract(raw, '$.token_breakdown.input.cache_write_tokens'), cache_creation_tokens, 0) AS cw,
  COALESCE(json_extract(raw, '$.token_breakdown.output.total_tokens'), output_tokens, 0) AS out,
  COALESCE(json_extract(raw, '$.token_breakdown.output.reasoning_tokens'), reasoning_tokens, 0) AS rsn,
  COALESCE(json_extract(raw, '$.token_breakdown.total_tokens'), total_tokens, 0) AS tot,
  client_name(client_ip, json_extract(raw, '$.resolved_client_ip'), json_extract(raw, '$.x_forwarded_for')) AS client,
  agent(user_agent) AS agent
  FROM usage WHERE ts >= :from AND ts < :to),
c AS (SELECT *, cost(model, inp, cr, cw, out) AS lc, CASE WHEN auth_type = 'apikey' THEN cost(model, inp, cr, cw, out) ELSE 0 END AS bc FROM n)
"""
AGG = """COUNT(*) AS requests, SUM(failed) AS failed, SUM(inp) AS input_tokens, SUM(cr) AS cache_read_tokens,
  SUM(cw) AS cache_write_tokens, SUM(out) AS output_tokens, SUM(rsn) AS reasoning_tokens, SUM(tot) AS total_tokens,
  ROUND(SUM(lc), 6) AS list_cost_usd, ROUND(SUM(bc), 6) AS billed_cost_usd, CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avg_latency_ms"""


class Bad(Exception): pass


def one(q, name, default=None):
    v = q.get(name)
    if v and len(v) > 1: raise Bad(f"{name} given twice")
    return v[0] if v else default


def window(q):
    try:
        to = parse_ts(one(q, "to")) if one(q, "to") else datetime.now(timezone.utc)
        frm = parse_ts(one(q, "from")) if one(q, "from") else to - timedelta(days=7)
    except ValueError: raise Bad("from/to must be ISO 8601")
    if frm > to: raise Bad("from is after to")
    return {"from": iso(frm), "to": iso(to)}


def aggregate(q):
    w, g, b = window(q), one(q, "group", "none"), one(q, "bucket")
    if g not in GROUPS: raise Bad(f"group must be one of {', '.join(GROUPS)}")
    if b not in BUCKETS: raise Bad("bucket must be hour or day")
    cols = ([f"{BUCKETS[b]} AS t"] if b else []) + ([f"{GROUPS[g]} AS \"group\""] if GROUPS[g] else [])
    keys = ", ".join(c.split(" AS ")[1] for c in cols)
    sql = (NORM + f"SELECT {', '.join(cols + [AGG])} FROM c" + (f" GROUP BY {keys}" if keys else "")
           + " ORDER BY " + ("t, " if b else "") + "list_cost_usd DESC")
    with closing(connect()) as db:
        rows = [dict(r) for r in db.execute(sql, w)]
    rows = [r for r in rows if r["requests"]]  # no-group aggregate over an empty window yields one all-NULL row
    return {**w, "group": g, "bucket": b, "rows": rows}


def requests_(q):
    w = window(q)
    try: limit = min(int(one(q, "limit", "100")), 1000)
    except ValueError: raise Bad("limit must be an integer")
    if limit < 1: raise Bad("limit must be at least 1")
    where, args = [], dict(w, limit=limit)
    for name, col in (("key", "key_label"), ("model", "model"), ("client", "client")):
        if (v := one(q, name)) is not None: where.append(f"{col} = :{name}"); args[name] = v
    sql = (NORM + """SELECT ts, key_label AS key, client, client_ip, agent, user_agent, provider, auth_type, model, endpoint,
      inp AS input_tokens, cr AS cache_read_tokens, cw AS cache_write_tokens, out AS output_tokens, rsn AS reasoning_tokens,
      tot AS total_tokens, ROUND(lc, 6) AS list_cost_usd, ROUND(bc, 6) AS billed_cost_usd, latency_ms, failed, status_code
      FROM c""" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY ts DESC LIMIT :limit")
    with closing(connect()) as db:
        return {**w, "rows": [dict(r) for r in db.execute(sql, args)]}


def meta(q):
    with closing(connect()) as db:
        first, last = db.execute("SELECT MIN(ts), MAX(ts) FROM usage").fetchone()
        col = lambda sql: [r[0] for r in db.execute(sql)]
        keys = col("SELECT DISTINCT key_label FROM usage ORDER BY 1")
        models = col("SELECT DISTINCT model FROM usage ORDER BY 1")
        clients = col("""SELECT DISTINCT client_name(client_ip, json_extract(raw, '$.resolved_client_ip'),
                         json_extract(raw, '$.x_forwarded_for')) FROM usage ORDER BY 1""")
    return {"first_ts": first, "last_ts": last, "keys": keys, "models": models, "clients": clients,
            "pricing": {"source": "openrouter", "fetched_at": fetched_at,
                        "unpriced_models": [m for m in models if not price_of(m)]}}


ROUTES = {"/usage/aggregate": aggregate, "/usage/requests": requests_, "/usage/meta": meta}


class H(BaseHTTPRequestHandler):
    def send(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Headers", "Authorization")
        self.send_header("Vary", "Origin")
        if body is not None: self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self): self.send(204)

    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if not (auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().encode(), KEY)):
            return self.send(401, {"error": "unauthorized"})
        u = urlparse(self.path)
        if u.path not in ROUTES: return self.send(404, {"error": "not found"})
        try: self.send(200, ROUTES[u.path](parse_qs(u.query, keep_blank_values=True)))
        except Bad as e: self.send(400, {"error": str(e)})

    def log_message(self, fmt, *args): pass  # keep the journal free of query strings


if __name__ == "__main__":
    load_prices()
    if E("FETCH_PRICES", "1") == "1": threading.Thread(target=loop, args=(refresh_prices, 3600), daemon=True).start()
    if E("TAILSCALE", "1") == "1": threading.Thread(target=loop, args=(refresh_hosts, 300), daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
