#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Read-only usage API over the collector's usage.db, plus per-key quota checks. Contract: docs/usage-api.md."""
from contextlib import closing
import hashlib, hmac, json, os, re, signal, sqlite3, subprocess, sys, threading, time, urllib.request
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

E = os.environ.get
USAGE_DB = E("USAGE_DB", "/var/lib/cli-proxy-api/usage.db")
PRICES_DB = E("PRICES_DB", "/var/lib/cli-proxy-api/usage-prices.db")
KEY = open(E("KEY_FILE", "/root/.cliproxy-mgmt-key")).read().strip().encode()
QUOTAS_FILE = E("QUOTAS_FILE", "/opt/cli-proxy-api/quotas.json")
BLOCKED_FILE = E("BLOCKED_FILE", "/var/lib/cli-proxy-api/quota-blocked.json")
BIND, PORT = E("BIND", "100.90.164.91"), int(E("PORT", "8318"))
SELF_IP = "100.90.164.91"
ORIGIN = "http://100.90.164.91:8317"
PROXY_BASE = E("PROXY_BASE", ORIGIN)  # management API, for the client key list
# Proxy model names whose OpenRouter id is not "<vendor>/<same name>". Checked against /api/v1/models.
ALIASES = {
    "claude-opus-5-5": "anthropic/claude-opus-5.5", "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
    "claude-haiku-5-5": "anthropic/claude-haiku-5.5", "claude-fable-5-1": "anthropic/claude-fable-5.1",
    "gemini-3.8-flash-high": "google/gemini-3.8-flash", "mistral-large-4": "mistralai/mistral-large-4-0",
}
GROUPS = {"key": "key_label", "model": "model", "provider": "provider || '/' || auth_type",
          "client": "client", "agent": "agent", "none": None}
BUCKETS = {"hour": "substr(ts, 1, 13) || ':00:00Z'", "day": "substr(ts, 1, 10) || 'T00:00:00Z'", None: None}

WINDOWS = {"5h": timedelta(hours=5), "day": timedelta(hours=24)}  # both rolling

# ponytail: one query at a time. Every query calls Python functions per row, so parallel queries only
# fight over the GIL (6 parallel calls took 18 s, run in turn 8 s). Separate processes if that is ever too slow.
DB_LOCK = threading.Lock()
last_scopes = {}
prices, by_suffix, fetched_at, hosts, quota_state = {}, {}, None, {}, {"updated": None, "keys": {}}


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


# Normalised rows. The token, auth and session columns are filled from raw by the collector (FILL).
# c is MATERIALIZED: sessions() reads it five times, and SQLite would otherwise rebuild it each time.
NORM = """WITH n AS (SELECT ts, key_label, client_ip, user_agent, provider, model, endpoint, latency_ms, failed, status_code,
  auth_type, inp, cr, cw, out, rsn, tot, client_name(client_ip, resolved_ip, xff) AS client, agent(user_agent) AS agent, session
  FROM usage WHERE ts >= :from AND ts < :to),
c AS MATERIALIZED (SELECT *, cost(model, inp, cr, cw, out) AS lc, CASE WHEN auth_type = 'apikey' THEN cost(model, inp, cr, cw, out) ELSE 0 END AS bc FROM n)
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


def filtered(q, cols):
    """Window + limit + exact-match filters -> (WHERE clause, params)."""
    try: limit = min(int(one(q, "limit", "100")), 1000)
    except ValueError: raise Bad("limit must be an integer")
    if limit < 1: raise Bad("limit must be at least 1")
    where, args = [], dict(window(q), limit=limit)
    for name, col in cols:
        if (v := one(q, name)) is not None: where.append(f"{col} = :{name}"); args[name] = v
    return (" WHERE " + " AND ".join(where) if where else ""), args


def requests_(q):
    where, args = filtered(q, (("key", "key_label"), ("model", "model"), ("client", "client"), ("session", "session")))
    sql = (NORM + """SELECT ts, session, key_label AS key, client, client_ip, agent, user_agent, provider, auth_type, model, endpoint,
      inp AS input_tokens, cr AS cache_read_tokens, cw AS cache_write_tokens, out AS output_tokens, rsn AS reasoning_tokens,
      tot AS total_tokens, ROUND(lc, 6) AS list_cost_usd, ROUND(bc, 6) AS billed_cost_usd, latency_ms, failed, status_code
      FROM c""" + where + " ORDER BY ts DESC LIMIT :limit")
    with closing(connect()) as db:
        return {"from": args["from"], "to": args["to"], "rows": [dict(r) for r in db.execute(sql, args)]}


# Majority value of a column per session (ties broken alphabetically).
PICK = """{0} AS (SELECT session, {1} AS v, ROW_NUMBER() OVER (PARTITION BY session ORDER BY COUNT(*) DESC, {1}) AS rn
  FROM c GROUP BY session, {1})"""


def sessions(q):
    where, args = filtered(q, (("key", "pk.v"), ("client", "pc.v"), ("agent", "pa.v")))
    order = {"recent": "a.last_ts DESC", "cost": "a.list_cost_usd DESC, a.last_ts DESC"}.get(one(q, "sort", "recent"))
    if not order: raise Bad("sort must be recent or cost")
    sql = (NORM + ", " + ", ".join(PICK.format(n, col) for n, col in (("pk", "key_label"), ("pc", "client"), ("pa", "agent")))
           + """, m AS (SELECT session, model, SUM(lc) AS mc FROM c GROUP BY session, model)
      SELECT a.*, pk.v AS key, pc.v AS client, pa.v AS agent,
        (SELECT json_group_array(model) FROM (SELECT model FROM m WHERE m.session = a.session ORDER BY mc DESC, model)) AS models
      FROM (SELECT session, MIN(ts) AS first_ts, MAX(ts) AS last_ts, """ + AGG + """ FROM c GROUP BY session) a
      JOIN pk ON pk.session = a.session AND pk.rn = 1 JOIN pc ON pc.session = a.session AND pc.rn = 1
      JOIN pa ON pa.session = a.session AND pa.rn = 1""" + where + f" ORDER BY {order} LIMIT :limit")
    with closing(connect()) as db:
        rows = [{**dict(r), "models": json.loads(r["models"])} for r in db.execute(sql, args)]
    return {"from": args["from"], "to": args["to"], "rows": rows}


def meta(q):
    with closing(connect()) as db:
        first, last = db.execute("SELECT MIN(ts), MAX(ts) FROM usage").fetchone()
        col = lambda sql: [r[0] for r in db.execute(sql)]
        keys = col("SELECT DISTINCT key_label FROM usage ORDER BY 1")
        models = col("SELECT DISTINCT model FROM usage ORDER BY 1")
        clients = col("SELECT DISTINCT client_name(client_ip, resolved_ip, xff) FROM usage ORDER BY 1")
    return {"first_ts": first, "last_ts": last, "keys": keys, "models": models, "clients": clients,
            "pricing": {"source": "openrouter", "fetched_at": fetched_at,
                        "unpriced_models": [m for m in models if not price_of(m)]}}


def key_label(key):
    """The label usage-collector.sh stores for a client key (its jq scrub), or None if it stores none."""
    m = re.search(r"cpx-([A-Za-z0-9-]+)", key)
    if not m: return None
    k = m[1]
    return k[:-33] if re.fullmatch(r".+-[0-9a-f]{32}", k) else "unlabelled-" + k[:6]


def caller_scopes():
    """label -> CallerScope of each client key, as the proxy computes it (sdk/cliproxy/session/identity.go)."""
    req = urllib.request.Request(PROXY_BASE + "/v0/management/api-keys", headers={"Authorization": "Bearer " + KEY.decode()})
    with urllib.request.urlopen(req, timeout=10) as r: keys = json.load(r)["api-keys"]
    out = {}
    for k in (k.strip() for k in keys):  # the host trims keys before hashing
        if (label := key_label(k)):
            out.setdefault(label, []).append(hashlib.sha256(b"cli-proxy-api:caller-scope:v1\x00" + k.encode()).hexdigest())
    return out


def check_quotas():
    """List cost per key over each rolling window; write the keys at or over a limit to BLOCKED_FILE."""
    global quota_state
    try:
        with open(QUOTAS_FILE) as f: limits = json.load(f)
    except FileNotFoundError: limits = {}
    global last_scopes
    try: last_scopes = caller_scopes() if limits else {}
    except Exception as e: print(f"key list fetch failed, using the last one: {e!r}", flush=True)  # keys rarely change
    scopes = last_scopes
    keys = {}
    with DB_LOCK, closing(connect()) as db:
        now = datetime.now(timezone.utc)
        for key, lim in limits.items():
            span = {"from": iso(now - WINDOWS["day"]), "to": iso(now + timedelta(minutes=1)), "k": key}
            rows = db.execute("""SELECT ts, cost(model, inp, cr, cw, out) FROM usage
                                 WHERE key_label = :k AND ts >= :from AND ts < :to ORDER BY ts""", span).fetchall()
            st = {"limits": lim, "used": {}, "blocked_until": None, "blocked_window": None}
            for w, d in WINDOWS.items():
                win = [(t, c) for t, c in rows if t >= iso(now - d)]
                used = sum(c for _, c in win)
                st["used"][w] = round(used, 6)
                if lim.get(w, 0) <= 0 or used < lim[w]: continue
                for t, c in win:  # the key is free again once enough of its oldest usage leaves the window
                    used -= c
                    if used < lim[w]: break
                until = iso(parse_ts(t) + d)
                if not st["blocked_until"] or until > st["blocked_until"]: st["blocked_until"], st["blocked_window"] = until, w
            keys[key] = st
    quota_state = {"updated": iso(now), "keys": keys}
    blocked = {k: {"until": v["blocked_until"], "window": v["blocked_window"], "scopes": scopes.get(k, [])}
               for k, v in keys.items() if v["blocked_until"]}
    with open(BLOCKED_FILE + ".tmp", "w") as f: json.dump({"updated": iso(now), "blocked": blocked}, f)
    os.replace(BLOCKED_FILE + ".tmp", BLOCKED_FILE)


ROUTES = {"/usage/quotas": lambda q: quota_state, "/usage/aggregate": aggregate, "/usage/requests": requests_, "/usage/sessions": sessions, "/usage/meta": meta}


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
        try:
            with nullcontext() if u.path == "/usage/quotas" else DB_LOCK:  # quotas is in memory
                body = ROUTES[u.path](parse_qs(u.query, keep_blank_values=True))
            self.send(200, body)
        except Bad as e: self.send(400, {"error": str(e)})
        except Exception as e:
            print(f"{u.path} failed: {e!r}", flush=True)
            self.send(500, {"error": "internal error"})

    def log_message(self, fmt, *args): pass  # keep the journal free of query strings


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # systemd's stop is a clean exit, not a failure
    load_prices()
    if E("FETCH_PRICES", "1") == "1": threading.Thread(target=loop, args=(refresh_prices, 3600), daemon=True).start()
    if E("TAILSCALE", "1") == "1": threading.Thread(target=loop, args=(refresh_hosts, 300), daemon=True).start()
    threading.Thread(target=loop, args=(check_quotas, 10), daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
