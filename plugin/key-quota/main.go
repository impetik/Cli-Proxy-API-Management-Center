// key-quota: CLIProxyAPI plugin that answers 429 for client keys over their 5-hour or daily quota.
// The quota checker (server/usage-api.py) decides who is blocked; this plugin only enforces it.
// Native ABI v1 + JSON methods, no host module import (layouts: internal/pluginhost/loader_unix.go).
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int KeyQuotaCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void KeyQuotaFree(void*, size_t);
extern void KeyQuotaShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"time"
	"unsafe"
)

const version = "0.2.0"

//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, p *C.cliproxy_plugin_api) C.int {
	if p == nil {
		return 1
	}
	p.abi_version = 1
	p.call = C.cliproxy_plugin_call_fn(C.KeyQuotaCall)
	p.free_buffer = C.cliproxy_plugin_free_fn(C.KeyQuotaFree)
	p.shutdown = C.cliproxy_plugin_shutdown_fn(C.KeyQuotaShutdown)
	return 0
}

//export KeyQuotaCall
func KeyQuotaCall(method *C.char, req *C.uint8_t, n C.size_t, out *C.cliproxy_buffer) C.int {
	var body []byte
	if req != nil && n > 0 && n < 1<<31 {
		body = C.GoBytes(unsafe.Pointer(req), C.int(n))
	}
	if out == nil {
		return 1
	}
	// A panic here would take the whole proxy down (the host cannot recover a plugin's runtime).
	result := envelope{OK: true, Result: interceptResponse{}}
	func() {
		defer func() { _ = recover() }()
		result = handle(C.GoString(method), body)
	}()
	raw, _ := json.Marshal(result)
	out.ptr, out.len = C.CBytes(raw), C.size_t(len(raw))
	return 0
}

//export KeyQuotaFree
func KeyQuotaFree(p unsafe.Pointer, _ C.size_t) { C.free(p) }

//export KeyQuotaShutdown
func KeyQuotaShutdown() {}

type envelope struct {
	OK     bool `json:"ok"`
	Result any  `json:"result,omitempty"`
	Error  any  `json:"error,omitempty"`
}

func handle(method string, body []byte) envelope {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		// Schema 7: the host may skip copying request bodies, which this plugin never reads.
		return envelope{OK: true, Result: map[string]any{
			"schema_version": 7,
			"metadata": map[string]any{"Name": "Key Quota", "Version": version, "Author": "impetik",
				"GitHubRepository": "https://github.com/impetik/Cli-Proxy-API-Management-Center"},
			"capabilities": map[string]bool{"request_interceptor": true,
				"request_interceptor_omit_body_before": true, "request_interceptor_omit_body_after": true},
		}}
	case "plugin.shutdown", "request.intercept_after":
		return envelope{OK: true, Result: interceptResponse{}}
	case "request.intercept_before":
		var r interceptRequest
		if err := json.Unmarshal(body, &r); err != nil {
			return envelope{OK: true, Result: interceptResponse{}} // unreadable request: fail open
		}
		return envelope{OK: true, Result: decide(r.CallerScope, time.Now())}
	}
	return envelope{Error: map[string]string{"code": "unknown_method", "message": "unknown method: " + method}}
}

func main() {}
