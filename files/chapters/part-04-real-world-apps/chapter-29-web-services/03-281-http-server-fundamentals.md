## 29.1 HTTP Server Fundamentals

### Basic Server

The simplest Go HTTP server requires only a few lines. Call `http.HandleFunc` to register handler functions, then `http.ListenAndServe` to start accepting connections. This uses the default `ServeMux`, which is fine for quick prototypes but lacks timeout controls and graceful shutdown, both critical for production use.

```go
package main

import (
    "fmt"
    "log"
    "net/http"
)

func main() {
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Hello, %s!", r.URL.Path[1:])
    })

    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    })

    log.Println("Starting server on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Custom Server Configuration

Configuration is expressed as a struct to provide compile-time type safety and enable validation at startup. Grouping all parameters in one place makes it easy to inject them from environment variables, config files, or command-line flags through a single construction path.

**Production timeouts are mandatory.** The zero-value `http.Server` has no timeouts at all, which means a single slow client holding a connection open can pin a goroutine forever (classic Slowloris attack). At minimum, always set `ReadHeaderTimeout` (defends against slow header attacks even when the body is streamed), `ReadTimeout`, `WriteTimeout`, and `IdleTimeout`. Even in Go 1.27, `net/http` keeps these timeouts opt-in, so forgetting them silently ships a DoS-vulnerable server.

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", handleRoot)
    mux.HandleFunc("/api/users", handleUsers)

    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
        ReadHeaderTimeout: 5 * time.Second, // Slowloris defense
        MaxHeaderBytes: 1 << 20, // 1MB
    }

    // Start server in goroutine
    go func() {
        log.Println("Starting server on :8080")
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("Server shutdown error: %v", err)
    }

    log.Println("Server stopped")
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("OK"))
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("users"))
}
```

### Handler Interface

Any type that implements `ServeHTTP(http.ResponseWriter, *http.Request)` satisfies the `http.Handler` interface and can be registered with a router. Struct-based handlers hold dependencies like database connections as fields, keeping handlers testable through dependency injection rather than global state.

```go
package main

import (
    "encoding/json"
    "net/http"
)

// Implement http.Handler interface
type UserHandler struct {
    store UserStore
}

func (h *UserHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodGet:
        h.list(w, r)
    case http.MethodPost:
        h.create(w, r)
    default:
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
    }
}

func (h *UserHandler) list(w http.ResponseWriter, r *http.Request) {
    users, err := h.store.List()
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(users)
}

func (h *UserHandler) create(w http.ResponseWriter, r *http.Request) {
    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    if err := h.store.Create(&user); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}
```

### Junior to FAANG: Moving From "It Runs" to "It Will Not Page You at 3 AM"

Every timeout in the snippet above has a story. `ReadHeaderTimeout` defends against Slowloris where a client sends one byte of a header every 10 seconds. `ReadTimeout` covers the whole request including body, so for an upload endpoint you must raise it or switch to `http.ResponseController.SetReadDeadline` per request. `WriteTimeout` covers response writing, which matters for SSE and long polling where you intentionally want no timeout (use `ResponseController.SetWriteDeadline(time.Time{})`). `IdleTimeout` matters for keep-alive connections and should be slightly less than the LB's idle timeout. Memorize this mapping for interviews.

Worked example, sending a slow client into the void. Test your server with `curl --limit-rate 1 http://localhost:8080/` and confirm you get a clean timeout, not a hung goroutine. Run `go tool pprof http://localhost:8080/debug/pprof/goroutine` during the test to see if goroutine count stays bounded. If it grows, you are leaking. This single exercise teaches more than any tutorial.

Common new-engineer mistake. Writing `w.Write(...)` then `w.WriteHeader(200)`. The first write locks in a 200 status. Always call `WriteHeader` first (or not at all for 200). Another. Calling `json.NewEncoder(w).Encode(user)` then trying to set `Content-Type` after. Set headers first, body last. Always.

### Senior at FAANG: Server Configuration as Platform Contract

Publish `platform/httpserver` with a single `New(Config) *http.Server` constructor that returns a hardened server. Reject zero values for timeouts. Enforce `MaxHeaderBytes` at 1 MB unless a caller explicitly overrides with justification. Provide `ResponseController` helpers for streaming, SSE, and WebSocket upgrade paths. Every service across the org constructs its server through this one call. When a CVE drops that requires `DisableGeneralOptionsHandler`, you flip one library default and release, rather than chasing 400 repos.

Timeout governance. Publish the timeout matrix in the platform handbook.

| Endpoint class | ReadHeader | Read | Write | Idle | Notes |
|----------------|------------|------|-------|------|-------|
| Synchronous JSON API | 5s | 15s | 30s | 120s | Default. |
| File upload | 5s | 5m | 30s | 120s | Override Read via `ResponseController`. |
| SSE or long poll | 5s | 15s | 0 | 120s | WriteDeadline zero, heartbeat every 15s. |
| WebSocket after upgrade | 5s | 0 | 0 | 120s | Deadlines reset per frame in handler. |
| Health or readiness | 2s | 2s | 2s | 10s | Dedicated listener, bypass middleware. |

Separate listener pattern. Run `/metrics`, `/debug/pprof`, `/healthz`, `/readyz` on a second `http.Server` bound to an admin port. Never expose them on the public port even "behind" middleware. An auth bug that exposes pprof leaks goroutine dumps with customer data. Enforce this via a CI check that scans routers for pprof on the public mux.

Graceful shutdown at mesh scale. `Server.Shutdown` does not terminate in-flight WebSocket or gRPC-over-h2 streams. Implement a `Drainer` that tracks long-lived connections and broadcasts a `shutdown` frame before calling `Shutdown`. Align the drain deadline with `terminationGracePeriodSeconds - 5s`. Bake a pre-stop hook that flips `/readyz` to 503, waits for endpoints to propagate (2 to 5 seconds depending on cluster), then begins drain. This one pattern eliminates the bulk of deploy-induced 502s in the fleet.

HTTP/2 and HTTP/3 considerations. Go's `net/http` serves h2 automatically over TLS via `http2.ConfigureServer`. For h3 in 2026 you typically front with Envoy or Cloudflare and keep Go on h1+h2. If you insist on h3 in Go, `quic-go/http3` works but operational cost is high because of kernel UDP buffer tuning (`net.core.rmem_max` at 26 MB is the common pitfall). The staff recommendation, defer h3 to the edge unless you have a concrete latency win from the last-mile.

Handler interface governance. `http.Handler` is the one abstraction every team shares. Do not wrap it behind framework-specific types (Gin `Context`, Fiber `Ctx`). The day you need to swap frameworks (for a CVE, for perf, for licensing), the framework-specific types become the blocker. Enforce "handlers take `(http.ResponseWriter, *http.Request)`" as a lint rule. Allow adapters at the router layer only.

Request-scoped dependencies. Inject dependencies via handler struct fields (as shown) for long-lived deps, via `context.Context` for per-request deps (tenant, user, trace). Never via globals. Audit for `http.DefaultClient`, `http.DefaultServeMux`, `log.Default()` and ban them. They are the source of mystery cross-test pollution and prod config drift.

Incident pattern to memorize. "Service CPU spikes to 100 percent after deploy, latency climbs, no obvious cause." Root cause almost always. A new handler writes response body before calling `WriteHeader`, so `net/http` has to buffer and infer `Content-Length`, which under h2 serializes on the connection. Fix, always call `WriteHeader` before `Write`, or stream with chunked encoding explicitly. Add this to the Go review checklist.

Multi-year roadmap for server fundamentals. Quarter 1, publish `platform/httpserver`, migrate 20 percent of services. Quarter 2, enforce via CI, reach 80 percent. Quarter 3, add drain manager and WS shutdown protocol, reach 100 percent. Year 2, evaluate h3 at edge, run quarterly DoS game days against the timeout matrix. Year 3, migrate to whatever `net/http` ships next (for example, if `http.Server.ErrorLog` is ever deprecated in favor of `slog`).

---
