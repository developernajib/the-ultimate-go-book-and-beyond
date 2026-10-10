## 102Q.3 Cloudflare Workers (Edge)

Cloudflare Workers run JavaScript (and now WASM) at 300+ edge locations.

### Go on Cloudflare Workers via WASM

```go
// worker/main.go
//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

func main() {
	// Register Go functions as JavaScript exports
	js.Global().Set("handleRequest", js.FuncOf(handleRequest))

	// Keep the WASM module alive
	select {}
}

func handleRequest(this js.Value, args []js.Value) any {
	if len(args) == 0 {
		return js.ValueOf("error: no request provided")
	}

	req := args[0]
	method := req.Get("method").String()
	url := req.Get("url").String()

	// Route
	switch {
	case method == "GET" && contains(url, "/api/echo"):
		return handleEcho(req)
	case method == "GET" && contains(url, "/api/time"):
		return handleTime(req)
	default:
		return makeResponse(404, "not found")
	}
}

func handleEcho(req js.Value) any {
	// Extract query params
	urlStr := req.Get("url").String()
	msg := extractQueryParam(urlStr, "msg")
	if msg == "" {
		msg = "hello"
	}

	body, _ := json.Marshal(map[string]string{"echo": msg})
	return makeResponse(200, string(body))
}

func handleTime(req js.Value) any {
	body, _ := json.Marshal(map[string]any{
		"timestamp": js.Global().Get("Date").New().Call("toISOString").String(),
	})
	return makeResponse(200, string(body))
}

func makeResponse(status int, body string) any {
	// Return a JS object that Workers runtime can use
	obj := js.Global().Get("Object").New()
	obj.Set("status", status)
	obj.Set("body", body)
	obj.Set("headers", js.Global().Get("Object").New())
	return obj
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func extractQueryParam(url, key string) string {
	idx := -1
	for i := 0; i < len(url); i++ {
		if url[i] == '?' {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ""
	}
	query := url[idx+1:]
	prefix := key + "="
	parts := splitStr(query, "&")
	for _, part := range parts {
		if hasPrefix(part, prefix) {
			return part[len(prefix):]
		}
	}
	return ""
}

func splitStr(s, sep string) []string {
	var result []string
	start := 0
	for i := 0; i <= len(s)-len(sep); i++ {
		if s[i:i+len(sep)] == sep {
			result = append(result, s[start:i])
			start = i + len(sep)
		}
	}
	result = append(result, s[start:])
	return result
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
```

```javascript
// worker/worker.js - Cloudflare Worker JS glue
import './wasm_exec.js';

const go = new Go();
let initialized = false;

async function init() {
  if (initialized) return;
  const response = await fetch('/worker.wasm');
  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(result.instance);
  initialized = true;
}

addEventListener('fetch', async (event) => {
  await init();

  const result = handleRequest({
    method: event.request.method,
    url: event.request.url,
    headers: Object.fromEntries(event.request.headers),
  });

  event.respondWith(new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  }));
});
```

```bash
# Build for Cloudflare Workers
GOOS=js GOARCH=wasm go build -o worker.wasm ./worker/
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" ./worker/

# Deploy with Wrangler
wrangler deploy
```

---

### Junior → FAANG: Cloudflare Workers Constraints as the Interview Differentiator

The CPU time limit is the constraint that most engineers miss when first encountering Cloudflare Workers. The free tier provides 10ms of CPU time per request. The paid tier provides 50ms. This is CPU time, not wall-clock time: waiting on a fetch() call does not consume CPU time. This distinction matters because a Workers function can have a wall-clock duration of 30 seconds (while waiting on upstream APIs) but only 5ms of CPU time. Understanding this distinction changes how you optimize: the bottleneck is CPU-bound computation, not I/O latency.

The WASM compilation target for TinyGo on Workers has a critical constraint: no goroutines. TinyGo's WASM target compiles to a single-threaded model. If your Go code relies on goroutines for any functionality, it will not compile correctly for the Workers WASM target. This means the subset of Go that runs on Workers is limited to sequential, synchronous code with no concurrency primitives. Knowing this boundary before an interview or design discussion prevents proposing a Workers deployment for workloads that require concurrent processing.

First-job habit: test Workers functions locally with Wrangler's local mode before deploying. The local mode simulates the V8 isolate environment including CPU time limits, which surface CPU-bound performance problems before they appear in production.

### Senior @ FAANG: Edge Architecture and the Workload Classification Problem

At staff level, the Cloudflare Workers deployment pattern raises the workload classification question that individual teams cannot answer alone: which of the organization's workloads are appropriate for edge deployment? The classification criteria include CPU time budget (does the request processing fit within 50ms of CPU time?), state requirements (does the handler need persistent state beyond KV and Durable Objects?), dependency constraints (does the handler call internal services that are not accessible from edge PoPs?), and compliance constraints (is the data allowed to be processed in geographies outside the primary region?).

The compliance constraint is the most commonly overlooked. Many organizations processing user data have contractual or regulatory requirements that restrict which geographic regions data can transit. Cloudflare Workers processes requests at the nearest PoP to the user by default, which may include PoPs in regions outside the organization's approved data processing geography. Cloudflare's Smart Placement and Regional Services features allow constraining execution to specific regions, but these features require explicit configuration and add latency compared to the default nearest-PoP routing. The staff engineer's contribution is a data classification framework that specifies which data classes can be processed at the edge without geographic restriction, which require regional constraint, and which cannot be processed at the edge at all.

The Durable Objects pattern for coordinated edge state is architecturally significant: it provides strongly-consistent distributed state at the edge without a centralized database. The use cases are coordination problems: rate limiting, session affinity, collaborative features. The gotcha is that a Durable Object is a single-threaded JavaScript (or WASM) class instance, and all requests to the same Durable Object ID are serialized through that instance. Under high load, a popular Durable Object becomes a bottleneck. The organizational standard should require load testing Durable Object-backed handlers before production launch, with throughput targets defined relative to the Durable Object's measured request throughput limit.
