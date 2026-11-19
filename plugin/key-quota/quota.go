package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// Written every 10 s by usage-api.py (check_quotas). Older than staleAfter means the checker
// stopped, and then nothing is blocked: a broken checker must never cut off every machine.
var blockedFile = "/var/lib/cli-proxy-api/quota-blocked.json"

const staleAfter = 2 * time.Minute

type entry struct {
	Until  time.Time `json:"until"`
	Window string    `json:"window"`
	// CallerScope of each key with this label (usage-api.py computes them like the host does).
	Scopes []string `json:"scopes"`
}

type blockedDoc struct {
	Updated time.Time        `json:"updated"`
	Blocked map[string]entry `json:"blocked"`
}

// What the host sends. CallerScope = sha256("cli-proxy-api:caller-scope:v1\x00" + the key it
// authenticated), however the client sent it (header or ?key=); see sdk/cliproxy/session/identity.go.
type interceptRequest struct {
	CallerScope string
}

type interceptResponse struct {
	Terminate       bool        `json:",omitempty"`
	StatusCode      int         `json:",omitempty"`
	ResponseHeaders http.Header `json:",omitempty"`
	ResponseBody    []byte      `json:",omitempty"`
}

type blocked struct {
	label string
	entry
}

var cache struct {
	sync.Mutex
	mod     time.Time
	size    int64
	updated time.Time
	byScope map[string]blocked
}

// Returns the checker's last run and the blocks by scope; empty when the file is missing or corrupt.
func load() (time.Time, map[string]blocked) {
	st, err := os.Stat(blockedFile)
	if err != nil {
		return time.Time{}, nil
	}
	cache.Lock()
	defer cache.Unlock()
	if !st.ModTime().Equal(cache.mod) || st.Size() != cache.size {
		var doc blockedDoc
		cache.updated, cache.byScope = time.Time{}, nil
		if raw, err := os.ReadFile(blockedFile); err == nil && json.Unmarshal(raw, &doc) == nil {
			cache.updated, cache.byScope = doc.Updated, map[string]blocked{}
			for label, e := range doc.Blocked {
				for _, s := range e.Scopes {
					cache.byScope[s] = blocked{label, e}
				}
			}
		}
		cache.mod, cache.size = st.ModTime(), st.Size()
	}
	return cache.updated, cache.byScope
}

var windowName = map[string]string{"5h": "5-hour", "day": "24-hour"}

func decide(scope string, now time.Time) interceptResponse {
	updated, byScope := load()
	b, ok := byScope[scope]
	if scope == "" || !ok || now.Sub(updated) > staleAfter || !now.Before(b.Until) {
		return interceptResponse{}
	}
	msg := fmt.Sprintf("Quota reached for key '%s' (%s limit). Resets at %s UTC.",
		b.label, windowName[b.Window], b.Until.UTC().Format("2006-01-02 15:04"))
	// Anthropic error shape; OpenAI-style clients read the same error.message.
	body, _ := json.Marshal(map[string]any{"type": "error",
		"error": map[string]string{"type": "rate_limit_error", "message": msg}})
	return interceptResponse{
		Terminate:  true,
		StatusCode: http.StatusTooManyRequests,
		ResponseHeaders: http.Header{
			"Retry-After":  {strconv.Itoa(int(math.Ceil(b.Until.Sub(now).Seconds())))},
			"Content-Type": {"application/json"},
		},
		ResponseBody: body,
	}
}
