package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
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
}

type blockedDoc struct {
	Updated time.Time        `json:"updated"`
	Blocked map[string]entry `json:"blocked"`
}

// Only the fields this plugin reads or writes; names match sdk/pluginapi (no json tags there).
type interceptRequest struct {
	Headers http.Header
}

type interceptResponse struct {
	Terminate       bool        `json:",omitempty"`
	StatusCode      int         `json:",omitempty"`
	ResponseHeaders http.Header `json:",omitempty"`
	ResponseBody    []byte      `json:",omitempty"`
}

var cache struct {
	sync.Mutex
	mod  time.Time
	size int64
	doc  blockedDoc
}

func load() blockedDoc {
	st, err := os.Stat(blockedFile)
	if err != nil {
		return blockedDoc{}
	}
	cache.Lock()
	defer cache.Unlock()
	if !st.ModTime().Equal(cache.mod) || st.Size() != cache.size {
		var doc blockedDoc
		if raw, err := os.ReadFile(blockedFile); err == nil && json.Unmarshal(raw, &doc) == nil {
			cache.doc = doc
		} else {
			cache.doc = blockedDoc{}
		}
		cache.mod, cache.size = st.ModTime(), st.Size()
	}
	return cache.doc
}

// Same label the usage collector stores: cpx-<label>-<32 hex>, else unlabelled-<first 6 chars>.
var labelled = regexp.MustCompile(`^(.+)-[0-9a-f]{32}$`)

func label(key string) string {
	k, ok := strings.CutPrefix(key, "cpx-")
	if !ok || k == "" {
		return ""
	}
	if m := labelled.FindStringSubmatch(k); m != nil {
		return m[1]
	}
	return "unlabelled-" + k[:min(6, len(k))]
}

func clientKey(h http.Header) string {
	for name, vals := range h {
		if len(vals) == 0 {
			continue
		}
		v := strings.TrimSpace(vals[0])
		switch strings.ToLower(name) {
		case "authorization":
			if len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
				return strings.TrimSpace(v[7:])
			}
		case "x-api-key", "x-goog-api-key":
			return v
		}
	}
	return ""
}

var windowName = map[string]string{"5h": "5-hour", "day": "24-hour"}

func decide(h http.Header, now time.Time) interceptResponse {
	doc := load()
	if now.Sub(doc.Updated) > staleAfter {
		return interceptResponse{}
	}
	l := label(clientKey(h))
	e, ok := doc.Blocked[l]
	if l == "" || !ok || !now.Before(e.Until) {
		return interceptResponse{}
	}
	msg := fmt.Sprintf("Quota reached for key '%s' (%s limit). Resets at %s UTC.",
		l, windowName[e.Window], e.Until.UTC().Format("2006-01-02 15:04"))
	// Anthropic error shape; OpenAI-style clients read the same error.message.
	body, _ := json.Marshal(map[string]any{"type": "error",
		"error": map[string]string{"type": "rate_limit_error", "message": msg}})
	return interceptResponse{
		Terminate:  true,
		StatusCode: http.StatusTooManyRequests,
		ResponseHeaders: http.Header{
			"Retry-After":  {strconv.Itoa(int(math.Ceil(e.Until.Sub(now).Seconds())))},
			"Content-Type": {"application/json"},
		},
		ResponseBody: body,
	}
}
