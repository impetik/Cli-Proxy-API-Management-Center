#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Self-check for usage-api.py: fixed rows in temp DBs, server on a temp port, asserts."""
import json, os, socket, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
usage_db, prices_db, key_file = (os.path.join(tmp, n) for n in ("usage.db", "prices.db", "key"))
KEY = "test-key-123"
open(key_file, "w").write(KEY + "\n")

def raw(auth, unc, cr, cw, out, rsn, session, resolved="", xff=""):
    return json.dumps({"auth_type": auth, "session_id": session, "resolved_client_ip": resolved, "x_forwarded_for": xff,
        "token_breakdown": {"schema_version": 2, "total_tokens": unc + cr + cw + out,
            "input": {"uncached_tokens": unc, "cache_read_tokens": cr, "cache_write_tokens": cw},
            "output": {"total_tokens": out, "reasoning_tokens": rsn}}})

db = sqlite3.connect(usage_db)
db.execute("""CREATE TABLE usage (request_id TEXT PRIMARY KEY, ts TEXT, key_label TEXT, client_ip TEXT,
  user_agent TEXT, provider TEXT, model TEXT, alias TEXT, endpoint TEXT, input_tokens INTEGER,
  output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  total_tokens INTEGER, latency_ms INTEGER, failed INTEGER, status_code INTEGER, raw TEXT)""")
rows = [
    # Anthropic style: input excludes cache.
    ("r1", "2026-11-03T10:00:00.000Z", "ali", "100.114.209.35", "claude-cli/2.1.318 (external, cli)", "claude",
     "claude-opus-5-5", 2, 50, 0, 1000, 100, 1152, 100, 0, 200, raw("oauth", 2, 1000, 100, 50, 0, "s-A")),
    # OpenAI style: input column INCLUDES the 800 cached tokens; the breakdown splits them.
    ("r2", "2026-11-03T11:00:00.000Z", "ali", "100.114.209.35", "node", "codex",
     "gpt-6.1-sol", 1000, 10, 5, 800, 0, 1010, 300, 0, 200, raw("oauth", 200, 800, 0, 10, 5, "s-A")),
    # OpenRouter API-key row arriving through the tunnel (client_ip is cloud-pc itself).
    ("r3", "2026-11-04T09:00:00.000Z", "dirso-builder-staging", "100.90.164.91",
     "ai/7.0.150 ai-sdk-provider-utils/5.0.61 cloudflare-workers", "openrouter", "glm-5.3-prime",
     110, 100, 0, 10, 0, 210, 400, 0, 200, raw("apikey", 100, 10, 0, 100, 0, "s-B", "100.90.164.91", "2a06:98c0::1")),
    # Unknown model, failed.
    ("r4", "2026-11-04T10:00:00.000Z", "ali", "100.80.254.44", "claude-cli/2.1.318 (external, cli)", "claude",
     "mystery-1", 5, 5, 0, 0, 0, 10, 500, 1, 500, raw("oauth", 5, 0, 0, 5, 0, "s-A")),
]
db.executemany("""INSERT INTO usage (request_id, ts, key_label, client_ip, user_agent, provider, model, input_tokens,
  output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed,
  status_code, raw) VALUES (""" + ",".join("?" * 17) + ")", rows)
db.commit(); db.close()

p = sqlite3.connect(prices_db)
p.execute("CREATE TABLE prices (id TEXT PRIMARY KEY, prompt REAL, completion REAL, cache_read REAL, cache_write REAL)")
p.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
p.executemany("INSERT INTO prices VALUES (?,?,?,?,?)", [
    ("anthropic/claude-opus-5.5", 4e-6, 2e-5, 2e-7, 5e-6),
    ("openai/gpt-6.1-sol", 2e-6, 1e-5, 1e-7, 2.5e-6),
    ("z-ai/glm-5.3-prime", 2.8e-6, 8.8e-6, None, None),  # missing cache prices -> prompt price
])
p.execute("INSERT INTO meta VALUES ('fetched_at', '2026-11-04T00:00:00Z')")
p.commit(); p.close()

with socket.socket() as s:
    s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
env = dict(os.environ, USAGE_DB=usage_db, PRICES_DB=prices_db, KEY_FILE=key_file, BIND="127.0.0.1",
           PORT=str(port), FETCH_PRICES="0", TAILSCALE="0")
srv = subprocess.Popen(["uv", "run", "--script", os.path.join(HERE, "usage-api.py")], env=env)
base = f"http://127.0.0.1:{port}"

def call(path, key=KEY, method="GET"):
    req = urllib.request.Request(base + path, method=method)
    if key: req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req) as r: return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read()

try:
    for _ in range(100):
        try: call("/usage/meta"); break
        except OSError: time.sleep(0.1)
    R = "from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z"
    close = lambda a, b: abs(a - b) < 1e-9

    assert call("/usage/meta", key=None)[0] == 401
    assert call("/usage/meta", key="wrong")[0] == 401
    assert call(f"/usage/aggregate?{R}&group=bogus")[0] == 400
    assert call(f"/usage/aggregate?{R}&bucket=week")[0] == 400
    assert call("/usage/aggregate?from=yesterday")[0] == 400
    assert call(f"/usage/requests?{R}&limit=abc")[0] == 400

    st, h, _ = call("/usage/aggregate", key=None, method="OPTIONS")
    assert st == 204 and h["Access-Control-Allow-Origin"] == "http://100.90.164.91:8317", h
    assert h["Access-Control-Allow-Methods"] == "GET" and h["Access-Control-Allow-Headers"] == "Authorization", h

    st, h, body = call(f"/usage/aggregate?{R}&group=none")
    assert st == 200 and h["Access-Control-Allow-Origin"] == "http://100.90.164.91:8317"
    row, = json.loads(body)["rows"]
    assert "group" not in row and "t" not in row, row
    assert (row["requests"], row["failed"]) == (4, 1), row
    assert row["input_tokens"] == 2 + 200 + 100 + 5, row          # uncached only, cache never double counted
    assert row["cache_read_tokens"] == 1810 and row["cache_write_tokens"] == 100, row
    assert row["output_tokens"] == 165 and row["reasoning_tokens"] == 5, row
    # r1 0.001708 + r2 0.00058 (not 1000 * prompt) + r3 0.001188 (cache read at prompt price) + r4 0
    assert close(row["list_cost_usd"], 0.003476), row
    assert close(row["billed_cost_usd"], 0.001188), row           # only the apikey row
    assert row["avg_latency_ms"] == 325, row

    rows_ = json.loads(call(f"/usage/aggregate?{R}&group=provider")[2])["rows"]
    assert [r["group"] for r in rows_] == ["claude/oauth", "openrouter/apikey", "codex/oauth"], rows_

    rows_ = json.loads(call(f"/usage/aggregate?{R}&group=key&bucket=day")[2])["rows"]
    assert [(r["t"], r["group"]) for r in rows_] == [
        ("2026-11-03T00:00:00Z", "ali"), ("2026-11-04T00:00:00Z", "dirso-builder-staging"),
        ("2026-11-04T00:00:00Z", "ali")], rows_

    rows_ = json.loads(call(f"/usage/aggregate?{R}&group=client")[2])["rows"]
    assert {r["group"] for r in rows_} == {"100.114.209.35", "100.80.254.44", "cloud-pc (tunnel)"}, rows_
    rows_ = json.loads(call(f"/usage/aggregate?{R}&group=agent")[2])["rows"]
    assert {r["group"] for r in rows_} == {"claude-code", "node", "ai-sdk"}, rows_

    reqs = json.loads(call(f"/usage/requests?{R}&limit=2")[2])["rows"]
    assert [r["model"] for r in reqs] == ["mystery-1", "glm-5.3-prime"], reqs
    assert reqs[1]["auth_type"] == "apikey" and reqs[1]["client"] == "cloud-pc (tunnel)", reqs[1]
    reqs = json.loads(call(f"/usage/requests?{R}&model=gpt-6.1-sol")[2])["rows"]
    assert len(reqs) == 1 and close(reqs[0]["list_cost_usd"], 0.00058) and reqs[0]["billed_cost_usd"] == 0, reqs

    # Sessions: s-A spans 2 clients, 3 models, 2 agents -> majority values, models by cost.
    sess = json.loads(call(f"/usage/sessions?{R}")[2])["rows"]
    assert [s["session"] for s in sess] == ["s-A", "s-B"], sess          # last_ts descending
    a = sess[0]
    assert (a["key"], a["client"], a["agent"]) == ("ali", "100.114.209.35", "claude-code"), a
    assert a["models"] == ["claude-opus-5-5", "gpt-6.1-sol", "mystery-1"], a
    assert (a["first_ts"], a["last_ts"]) == ("2026-11-03T10:00:00.000Z", "2026-11-04T10:00:00.000Z"), a
    assert (a["requests"], a["failed"], a["input_tokens"]) == (3, 1, 207) and close(a["list_cost_usd"], 0.002288), a
    assert sess[1]["client"] == "cloud-pc (tunnel)" and close(sess[1]["billed_cost_usd"], 0.001188), sess[1]
    one_ = lambda qs: [s["session"] for s in json.loads(call(f"/usage/sessions?{R}&{qs}")[2])["rows"]]
    assert one_("limit=1") == ["s-A"]
    assert one_("key=dirso-builder-staging") == ["s-B"] and one_("agent=claude-code") == ["s-A"]
    assert one_("client=cloud-pc%20(tunnel)") == ["s-B"] and one_("client=100.80.254.44") == []
    # On 11-04 alone s-A is newest (r4, $0) but s-B costs more.
    D = "from=2026-11-04T00:00:00Z&to=2026-11-05T00:00:00Z"
    srt = lambda qs: [s["session"] for s in json.loads(call(f"/usage/sessions?{D}&{qs}")[2])["rows"]]
    assert srt("") == srt("sort=recent") == ["s-A", "s-B"] and srt("sort=cost") == ["s-B", "s-A"]
    for bad in ("limit=abc", "limit=0", "from=nope", "sort=bogus"):
        assert call(f"/usage/sessions?{bad}")[0] == 400, bad
    reqs = json.loads(call(f"/usage/requests?{R}&session=s-B")[2])["rows"]
    assert [(r["session"], r["model"]) for r in reqs] == [("s-B", "glm-5.3-prime")], reqs

    meta = json.loads(call("/usage/meta")[2])
    assert meta["pricing"]["unpriced_models"] == ["mystery-1"], meta
    assert meta["first_ts"] == "2026-11-03T10:00:00.000Z" and meta["pricing"]["source"] == "openrouter", meta
    print("usage-api-test: all assertions passed")
finally:
    srv.terminate(); srv.wait()
