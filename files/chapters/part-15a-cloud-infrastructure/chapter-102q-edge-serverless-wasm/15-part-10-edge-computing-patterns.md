## 102Q.13 Edge Computing Patterns

### Platform Comparison

| Feature | Cloudflare Workers | Lambda@Edge | Fastly Compute | Deno Deploy |
|---------|-------------------|-------------|---------------|-------------|
| Runtime | V8 isolates + WASM | Node.js / custom | WASM (Wasm32-WASI) | V8 + Deno |
| Cold start | ~0ms (isolate reuse) | 100-500ms | ~0ms | ~0ms |
| Go support | TinyGo → WASM | Go Lambda (regional only) | TinyGo → WASM | Compile to WASM |
| Global PoPs | 300+ | CloudFront PoPs | 90+ | 35+ |
| Max CPU/request | 30s (paid) / 10ms (free) | 5s (viewer) / 30s (origin) | 50ms (soft) | 400ms |
| Persistent state | Durable Objects, KV | None (stateless) | KV | Deno KV |
| Pricing model | Per-request + CPU-ms | Per-request + GB-ms | Per-request | Per-request |
| Wasm Component Model | Partial (Workers AI) | No | Yes | No |

**When to choose:**
- **Cloudflare Workers**: Global auth, rate limiting, A/B testing. highest PoP density. Durable Objects for coordination.
- **Lambda@Edge**: Already on AWS. Need CloudFront integration. Can tolerate longer cold starts.
- **Fastly Compute**: Wasm-first. Best Component Model support. deterministic performance.
- **Deno Deploy**: TypeScript/JS teams. simpler deployment. Not ideal for Go.

### A/B Testing at the Edge

Route traffic at the CDN layer - no origin latency for the routing decision:

```go
// Cloudflare Worker (TinyGo, GOOS=js GOARCH=wasm)
// go:build js && wasm

package main

import (
    "crypto/rand"
    "encoding/hex"
    "syscall/js"
)

func handleRequest(this js.Value, args []js.Value) any {
    request := args[0]
    cookieHeader := request.Get("headers").Call("get", "Cookie").String()

    variantCookie := extractCookie(cookieHeader, "ab_variant")

    var variant string
    if variantCookie != "" {
        variant = variantCookie
    } else {
        // Assign variant: 50/50 split
        b := make([]byte, 1)
        rand.Read(b)
        if b[0] < 128 {
            variant = "control"
        } else {
            variant = "treatment"
        }
    }

    // Rewrite URL based on variant
    url := request.Get("url").String()
    if variant == "treatment" {
        url = rewriteToTreatment(url)
    }

    // Build new request with variant header
    init := js.Global().Get("Object").New()
    init.Set("method", request.Get("method"))
    init.Set("headers", request.Get("headers"))

    newReq := js.Global().Get("Request").New(url, init)

    // Fetch and tag response with Set-Cookie
    fetchPromise := js.Global().Call("fetch", newReq)
    return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, p []js.Value) any {
        resolve := p[0]
        fetchPromise.Call("then", js.FuncOf(func(_ js.Value, args []js.Value) any {
            resp := args[0]
            // Clone response and inject cookie
            newHeaders := js.Global().Get("Headers").New(resp.Get("headers"))
            newHeaders.Call("set", "Set-Cookie",
                "ab_variant="+variant+"; Path=/; Max-Age=86400; SameSite=Lax")
            newResp := js.Global().Get("Response").New(
                resp.Get("body"),
                map[string]any{
                    "status":  resp.Get("status"),
                    "headers": newHeaders,
                },
            )
            resolve.Invoke(newResp)
            return nil
        }))
        return nil
    }))
}

func extractCookie(header, name string) string {
    // parse "key=val; key2=val2"
    start := 0
    for start < len(header) {
        end := start
        for end < len(header) && header[end] != ';' {
            end++
        }
        pair := trimSpace(header[start:end])
        if len(pair) > len(name)+1 && pair[:len(name)] == name && pair[len(name)] == '=' {
            return pair[len(name)+1:]
        }
        start = end + 1
        for start < len(header) && header[start] == ' ' {
            start++
        }
    }
    return ""
}

func trimSpace(s string) string {
    start, end := 0, len(s)
    for start < end && s[start] == ' ' {
        start++
    }
    for end > start && s[end-1] == ' ' {
        end--
    }
    return s[start:end]
}

func rewriteToTreatment(url string) string {
    // example: swap /v1/ for /v2/ in the path
    for i := 0; i+3 < len(url); i++ {
        if url[i:i+4] == "/v1/" {
            return url[:i] + "/v2/" + url[i+4:]
        }
    }
    return url
}

func randomHex(n int) string {
    b := make([]byte, n)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func main() {
    _ = randomHex
    js.Global().Set("handleRequest", js.FuncOf(handleRequest))
    select {} // keep alive
}
```

### Edge Authentication: JWT Validation Before Origin

Validating JWTs at the edge eliminates an entire round-trip to the origin for unauthorized requests:

```go
// jwt_edge.go - TinyGo Cloudflare Worker
// Validates HS256 JWT - rejects invalid tokens before forwarding to origin.
//go:build js && wasm

package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "strings"
    "syscall/js"
)

var jwtSecret = []byte("replace-with-env-secret") // inject via Worker secret binding

type jwtClaims struct {
    Sub string `json:"sub"`
    Exp int64  `json:"exp"`
}

func validateJWT(token string) (*jwtClaims, bool) {
    parts := strings.SplitN(token, ".", 3)
    if len(parts) != 3 {
        return nil, false
    }

    // Verify signature: HMAC-SHA256(header.payload, secret)
    message := parts[0] + "." + parts[1]
    mac := hmac.New(sha256.New, jwtSecret)
    mac.Write([]byte(message))
    expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
    if expectedSig != parts[2] {
        return nil, false
    }

    // Decode claims
    payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return nil, false
    }
    var claims jwtClaims
    if err := json.Unmarshal(payloadJSON, &claims); err != nil {
        return nil, false
    }

    return &claims, true
}

func authMiddleware(this js.Value, args []js.Value) any {
    request := args[0]
    authHeader := request.Get("headers").Call("get", "Authorization").String()

    token := ""
    if strings.HasPrefix(authHeader, "Bearer ") {
        token = authHeader[7:]
    }

    if token == "" {
        return unauthorizedResponse("missing token")
    }

    claims, ok := validateJWT(token)
    if !ok {
        return unauthorizedResponse("invalid token")
    }

    // Inject verified identity header for origin
    newHeaders := js.Global().Get("Headers").New(request.Get("headers"))
    newHeaders.Call("set", "X-Verified-User-ID", claims.Sub)

    newReq := js.Global().Get("Request").New(
        request.Get("url"),
        map[string]any{
            "method":  request.Get("method"),
            "headers": newHeaders,
            "body":    request.Get("body"),
        },
    )
    return js.Global().Call("fetch", newReq)
}

func unauthorizedResponse(msg string) js.Value {
    body := `{"error":"` + msg + `"}`
    headers := js.Global().Get("Headers").New()
    headers.Call("set", "Content-Type", "application/json")
    return js.Global().Get("Response").New(
        body,
        map[string]any{"status": 401, "headers": headers},
    )
}

func main() {
    js.Global().Set("authMiddleware", js.FuncOf(authMiddleware))
    select {}
}
```

### Distributed Rate Limiting with Durable Objects

Cloudflare Durable Objects provide consistent, single-threaded state at the edge. This enables accurate distributed rate limiting across global PoPs without a central Redis:

```javascript
// wrangler.toml
// [[durable_objects.bindings]]
// name = "RATE_LIMITER"
// class_name = "RateLimiter"

// RateLimiter.js (Durable Object - JS side - Go WASM calls into this)
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key  = url.searchParams.get("key") || "default";
    const limit = parseInt(url.searchParams.get("limit") || "100");
    const window = parseInt(url.searchParams.get("window") || "60"); // seconds

    const now = Math.floor(Date.now() / 1000);
    const windowKey = `${key}:${Math.floor(now / window)}`;

    let count = (await this.state.storage.get(windowKey)) || 0;
    count++;
    await this.state.storage.put(windowKey, count, {
      expirationTtl: window * 2,
    });

    const allowed = count <= limit;
    return new Response(JSON.stringify({ allowed, count, limit }), {
      status: allowed ? 200 : 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit":     String(limit),
        "X-RateLimit-Remaining": String(Math.max(0, limit - count)),
      },
    });
  }
}
```

The Go WASM worker calls the Durable Object binding before forwarding to origin:

```go
// rate_limit_check.go - Go WASM worker
//go:build js && wasm

package main

import "syscall/js"

func checkRateLimit(clientIP string, limit, windowSec int) bool {
    // Access Durable Object through Worker binding (injected as global)
    rateLimiter := js.Global().Get("RATE_LIMITER")
    id := rateLimiter.Call("idFromName", clientIP)
    stub := rateLimiter.Call("get", id)

    url := "https://rate-limiter/check?key=" + clientIP +
        "&limit=" + itoa(limit) +
        "&window=" + itoa(windowSec)

    respPromise := stub.Call("fetch", url)
    // Synchronous resolution not directly possible in WASM/JS -     // real implementation uses Promise chaining (see A/B example above)
    _ = respPromise
    return true
}

func itoa(n int) string {
    if n == 0 {
        return "0"
    }
    buf := make([]byte, 0, 10)
    for n > 0 {
        buf = append([]byte{byte('0' + n%10)}, buf...)
        n /= 10
    }
    return string(buf)
}

func main() {
    _ = checkRateLimit
    select {}
}
```

### Go TinyGo Program Deployed as Cloudflare Worker

End-to-end deployment workflow:

```bash
# 1. Install tools
npm install -g wrangler
brew install tinygo   # or: go install tinygo.org/x/tinygo@latest

# 2. Build WASM
tinygo build \
  -o worker.wasm \
  -target=wasm \
  -no-debug \
  -scheduler=none \
  ./cmd/worker/

# 3. Create wrangler.toml
cat > wrangler.toml <<'EOF'
name = "go-edge-worker"
main = "worker.js"
compatibility_date = "2025-01-01"

[build]
command = ""

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
EOF

# 4. worker.js glue
cat > worker.js <<'EOF'
import wasm from "./worker.wasm";

const go = new Go(); // from wasm_exec.js
const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
go.run(instance);

export default {
  async fetch(request, env) {
    return handleRequest(request);  // exported by Go
  }
};
EOF

# 5. Deploy
wrangler deploy

# 6. Test
curl -i https://go-edge-worker.<your-subdomain>.workers.dev/
```

Size targets for Cloudflare Workers:
- Free plan: 1 MB compressed WASM limit.
- Paid (Workers Unbound): 10 MB.
- TinyGo output with `-no-debug -scheduler=none`: typically 200-500 KB for simple handlers.

---

### Junior → FAANG: Platform Comparison as Interview Preparation

The platform comparison in this section (Cloudflare Workers vs. Fastly Compute vs. Deno Deploy) is the kind of structured comparative knowledge that interviewers at cloud-native companies test directly. Prepare to answer: what are the memory limits, CPU time limits, and binary size limits for each platform? What storage primitives does each offer? What are the primary use cases for each?

The binary size constraint for Cloudflare Workers (1MB compressed on free tier, 10MB on paid) is the most commonly underestimated constraint. A standard Go binary compiled for WASM with `GOOS=js GOARCH=wasm` is 2-10MB uncompressed. TinyGo with debug symbols stripped (`-no-debug`) and the scheduler disabled (`-scheduler=none`) produces 200-500KB. The implication: any non-trivial Go logic deployed to Workers free tier must use TinyGo, which constrains the available standard library. This constraint drives workload classification: Workers is appropriate for lightweight request transformation (A/B testing, auth token validation, geo-routing), not for compute-heavy business logic.

### Senior @ FAANG: Edge Platform Selection as an ADR-Worthy Architectural Decision

At staff level, the choice of edge platform is an architectural decision with 3-5 year implications. The platform's storage primitives, network access model, and pricing structure become organizational dependencies. Cloudflare Workers with KV and Durable Objects is a coherent platform for stateful edge workloads, but it creates a dependency on Cloudflare-specific storage APIs that are not portable to Fastly Compute or Lambda@Edge. The ADR for edge platform selection should explicitly document: what workload classes will use this platform, what organizational exit criteria would trigger re-evaluation (e.g., pricing change, SLA reduction, API deprecation), and what the migration cost would be if the platform is replaced.

The geo-routing and A/B testing patterns in this section are the most commonly cited business cases for edge computing adoption. Both are measurable: geo-routing adoption reduces origin latency by the difference between the edge PoP latency and the origin region latency (typically 50-200ms for global users). A/B testing at the edge eliminates the origin request for users in the control group that would otherwise be routed to the origin to determine the experiment assignment, reducing origin load by the control group fraction.

Measuring these improvements with before-and-after benchmarks using the real traffic patterns (not synthetic load from a single geographic region) is the staff engineer contribution that converts the edge platform adoption from a technology experiment into a business case with quantified ROI. The measurement must include the edge platform cost, the origin cost reduction, and the latency improvement weighted by the geographic distribution of real users, because a 200ms latency improvement for European users only matters if European users are a significant fraction of the organization's traffic.
