package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const hex32 = "0123456789abcdef0123456789abcdef"

func writeBlocked(t *testing.T, updated time.Time, blocked map[string]entry) {
	t.Helper()
	raw, _ := json.Marshal(blockedDoc{Updated: updated, Blocked: blocked})
	if err := os.WriteFile(blockedFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func bearer(key string) http.Header { return http.Header{"Authorization": {"Bearer " + key}} }

func TestDecide(t *testing.T) {
	blockedFile = filepath.Join(t.TempDir(), "blocked.json")
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

	// Missing file: everything passes (fail open).
	if r := decide(bearer("cpx-laptop-"+hex32), now); r.Terminate {
		t.Fatal("missing file must not block")
	}

	writeBlocked(t, now.Add(-10*time.Second), map[string]entry{
		"laptop":            {Until: now.Add(time.Hour), Window: "5h"},
		"old":               {Until: now.Add(-time.Minute), Window: "day"},
		"unlabelled-d40869": {Until: now.Add(90 * time.Second), Window: "day"},
	})

	r := decide(bearer("cpx-laptop-"+hex32), now)
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

	for name, h := range map[string]http.Header{
		"other key":      bearer("cpx-desk-" + hex32),
		"expired block":  bearer("cpx-old-" + hex32),
		"no key":         {},
		"not a cpx key":  bearer("sk-laptop-" + hex32),
		"label prefix":   bearer("cpx-lap-" + hex32),
		"label is a sub": bearer("cpx-my-laptop-" + hex32),
	} {
		if decide(h, now).Terminate {
			t.Fatalf("%s must pass", name)
		}
	}

	// Same key in other headers, and the unlabelled main key (label as the collector writes it).
	if !decide(http.Header{"X-Api-Key": {"cpx-laptop-" + hex32}}, now).Terminate {
		t.Fatal("x-api-key must be checked")
	}
	if !decide(http.Header{"authorization": {"bearer cpx-laptop-" + hex32}}, now).Terminate {
		t.Fatal("header and scheme are case-insensitive")
	}
	r = decide(bearer("cpx-d40869c2ef1a66ed8cc98046462cb082a9003f4f73bf63a0"), now)
	if !r.Terminate || r.ResponseHeaders.Get("Retry-After") != "90" {
		t.Fatalf("unlabelled key: %+v", r)
	}

	// Stale file (quota checker stopped): fail open.
	writeBlocked(t, now.Add(-3*time.Minute), map[string]entry{"laptop": {Until: now.Add(time.Hour), Window: "5h"}})
	if decide(bearer("cpx-laptop-"+hex32), now).Terminate {
		t.Fatal("stale file must not block")
	}

	// A rewrite is picked up; a corrupt file fails open.
	writeBlocked(t, now, map[string]entry{"desk": {Until: now.Add(time.Hour), Window: "day"}})
	if !decide(bearer("cpx-desk-"+hex32), now).Terminate || decide(bearer("cpx-laptop-"+hex32), now).Terminate {
		t.Fatal("rewritten file not reloaded")
	}
	os.WriteFile(blockedFile, []byte("{not json"), 0o600)
	if decide(bearer("cpx-desk-"+hex32), now).Terminate {
		t.Fatal("corrupt file must not block")
	}
}
