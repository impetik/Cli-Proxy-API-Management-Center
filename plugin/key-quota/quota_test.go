package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exactly what usage-api.py writes (iso(): millisecond precision, Z).
const pyBlocked = `{"updated": "2026-11-19T11:59:50.000Z", "blocked": {
 "laptop": {"until": "2026-11-19T13:00:00.000Z", "window": "5h", "scopes": ["s-laptop-1", "s-laptop-2"]},
 "old": {"until": "2026-11-19T11:59:00.000Z", "window": "day", "scopes": ["s-old"]},
 "noscopes": {"until": "2026-11-19T13:00:00.000Z", "window": "day"}}}`

var now = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

func write(t *testing.T, s string) {
	t.Helper()
	if err := os.WriteFile(blockedFile, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDecide(t *testing.T) {
	blockedFile = filepath.Join(t.TempDir(), "blocked.json")

	if decide("s-laptop-1", now).Terminate {
		t.Fatal("missing file must not block")
	}
	write(t, pyBlocked)

	r := decide("s-laptop-2", now) // any of the label's keys
	if !r.Terminate || r.StatusCode != 429 || r.ResponseHeaders.Get("Retry-After") != "3600" {
		t.Fatalf("blocked key: %+v", r)
	}
	var body struct {
		Type  string
		Error struct{ Type, Message string }
	}
	if err := json.Unmarshal(r.ResponseBody, &body); err != nil || body.Type != "error" ||
		body.Error.Type != "rate_limit_error" ||
		body.Error.Message != "Quota reached for key 'laptop' (5-hour limit). Resets at 2026-11-19 13:00 UTC." {
		t.Fatalf("body: %s %v", r.ResponseBody, err)
	}
	for name, scope := range map[string]string{"other key": "s-desk", "expired block": "s-old", "no scope": ""} {
		if decide(scope, now).Terminate {
			t.Fatalf("%s must pass", name)
		}
	}

	// Stale file (quota checker stopped): fail open.
	if decide("s-laptop-1", now.Add(3*time.Minute)).Terminate {
		t.Fatal("stale file must not block")
	}
	// A rewrite is picked up; a corrupt file fails open.
	write(t, strings.Replace(pyBlocked, `"s-laptop-1", `, "", 1))
	if decide("s-laptop-1", now).Terminate || !decide("s-laptop-2", now).Terminate {
		t.Fatal("rewritten file not reloaded")
	}
	write(t, "{not json")
	if decide("s-laptop-2", now).Terminate {
		t.Fatal("corrupt file must not block")
	}
}

// The JSON the host sends and expects (field names from sdk/pluginapi and internal/pluginhost/rpc_schema.go).
func TestHandleWire(t *testing.T) {
	blockedFile = filepath.Join(t.TempDir(), "blocked.json")
	write(t, strings.Replace(pyBlocked, "2026-11-19T11:59:50.000Z", time.Now().UTC().Format(time.RFC3339), 1))

	raw, _ := json.Marshal(handle("plugin.register", []byte(`{"config_yaml":"","schema_version":10}`)))
	var reg struct {
		OK     bool `json:"ok"`
		Result struct {
			SchemaVersion int             `json:"schema_version"`
			Capabilities  map[string]bool `json:"capabilities"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &reg) != nil || !reg.OK || reg.Result.SchemaVersion != 7 ||
		!reg.Result.Capabilities["request_interceptor"] {
		t.Fatalf("register: %s", raw)
	}

	// Real block times are relative to now, so only check the shape and status here.
	write(t, `{"updated":"`+time.Now().UTC().Format(time.RFC3339)+`","blocked":{"k":{"until":"`+
		time.Now().Add(time.Hour).UTC().Format(time.RFC3339)+`","window":"day","scopes":["abc"]}}}`)
	raw, _ = json.Marshal(handle("request.intercept_before", []byte(`{"CallerScope":"abc","Headers":{}}`)))
	var res struct {
		OK     bool `json:"ok"`
		Result struct {
			Terminate       bool
			StatusCode      int
			ResponseHeaders map[string][]string
			ResponseBody    []byte
		} `json:"result"`
	}
	if json.Unmarshal(raw, &res) != nil || !res.OK || !res.Result.Terminate || res.Result.StatusCode != 429 ||
		len(res.Result.ResponseHeaders["Retry-After"]) != 1 || len(res.Result.ResponseBody) == 0 {
		t.Fatalf("intercept_before: %s", raw)
	}
	for _, m := range []struct{ method, body string }{
		{"request.intercept_before", `{"CallerScope":"other"}`},
		{"request.intercept_before", `not json`},
		{"request.intercept_after", `{"CallerScope":"abc"}`},
	} {
		raw, _ = json.Marshal(handle(m.method, []byte(m.body)))
		if string(raw) != `{"ok":true,"result":{}}` {
			t.Fatalf("%s %s: %s", m.method, m.body, raw)
		}
	}
}
