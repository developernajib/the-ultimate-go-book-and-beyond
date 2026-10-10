## 24.13 Common Mistakes and Fixes

### Mistake 1: Profiling with Optimizations Disabled

A frequent trap is building a binary with compiler optimizations disabled (using `-gcflags="all=-N -l"`) specifically to aid debugging, then profiling that binary. The resulting profiles reflect a program that behaves nothing like production, inlining is suppressed and bounds-check eliminations are absent, so any hotspot you identify may not exist in the real binary. The correct approach is to profile an optimized build and use environment-controlled debug flags for the extra instrumentation you need.

The counterpart flags below deserve one clarification, since this is a chapter about debugging. `-ldflags="-s -w"` strips the symbol table and DWARF, and people assume that ruins profiling. It does not: Go's `pclntab` carries the function names the profiler needs and is never stripped, so a `-s -w` binary produces profiles that symbolize exactly like an unstripped one. What `-s -w` does cost you is Delve. No DWARF means no local variables, no type information, and a core dump you cannot meaningfully inspect (24.3). So the two goals pull apart: strip for size and profile happily, or keep DWARF if you want post-mortem core analysis. The usual resolution is to ship the stripped binary and archive the unstripped one, matched by build ID, on a symbol server.

```go
// WRONG: Building for production debugging without optimizations
// go build -gcflags="all=-N -l" -o myapp main.go
// This disables optimizations, making profiles unrealistic

// CORRECT: Build with optimizations, use -trimpath for cleaner output
// go build -trimpath -ldflags="-s -w" -o myapp main.go
//
// For debugging specific issues, use conditional debug builds:
package main

import (
    "os"
    "runtime"
)

var debugMode = os.Getenv("DEBUG_MODE") == "true"

func init() {
    if debugMode {
        // Enable block and mutex profiling only in debug mode.
        //
        // Both are 0 by default, meaning /debug/pprof/block and
        // /debug/pprof/mutex return an empty profile until something calls
        // these. That is the trap in one direction.
        //
        // The trap in the other direction is passing 1. SetBlockProfileRate(1)
        // records EVERY blocking event, and SetMutexProfileFraction(1) records
        // every contention event. On a contended service that is a large,
        // continuous tax, not a debug convenience. The argument to
        // SetBlockProfileRate is a sampling rate in nanoseconds of blocking
        // (sample one event per N ns blocked), and SetMutexProfileFraction
        // takes 1-in-N. These values find real contention at a cost you can
        // leave running on a canary.
        runtime.SetBlockProfileRate(10_000) // ~1 sample per 10µs blocked
        runtime.SetMutexProfileFraction(5)  // 1 in 5 contention events
    }
}

// For accurate production profiles:
// 1. Keep optimizations enabled
// 2. Enable profiling only when needed
// 3. Sample at appropriate rates for your traffic
```

### Mistake 2: Exposing Debug Endpoints Without Authentication

Registering `net/http/pprof` handlers and binding the debug server to `0.0.0.0` makes CPU profiles, heap dumps, and goroutine stacks accessible to anyone who can reach that port, including attackers. This data reveals memory layout, internal data structures, and timing information that can assist exploitation. Every debug endpoint must be gated behind authentication and, wherever possible, bound only to loopback or an internal network interface.

```go
// WRONG: Exposing pprof on public interface
func main() {
    // This is publicly accessible!
    go http.ListenAndServe(":6060", nil)

    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}

// CORRECT: Isolate debug endpoints with authentication
package debug

import (
    "crypto/subtle"
    "net/http"
    "net/http/pprof"
)

func SecureDebugServer(addr, authToken string) *http.Server {
    mux := http.NewServeMux()

    // Wrap all handlers with auth
    authMiddleware := func(next http.HandlerFunc) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
            token := r.Header.Get("X-Debug-Token")
            if subtle.ConstantTimeCompare([]byte(token), []byte(authToken)) != 1 {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }
            next(w, r)
        }
    }

    mux.HandleFunc("/debug/pprof/", authMiddleware(pprof.Index))
    mux.HandleFunc("/debug/pprof/cmdline", authMiddleware(pprof.Cmdline))
    mux.HandleFunc("/debug/pprof/profile", authMiddleware(pprof.Profile))
    mux.HandleFunc("/debug/pprof/symbol", authMiddleware(pprof.Symbol))
    mux.HandleFunc("/debug/pprof/trace", authMiddleware(pprof.Trace))

    return &http.Server{
        Addr:    addr,
        Handler: mux,
    }
}

// Better: Listen only on localhost or internal network
// addr: "127.0.0.1:6060" or use Kubernetes NetworkPolicies
```

### Mistake 3: Not Rate Limiting Goroutine Dumps

`runtime.Stack` captures the stack trace of every goroutine at the moment it is called, which can easily consume hundreds of megabytes when a service is under load with thousands of concurrent goroutines. Without a buffer cap and a minimum interval between dumps, a single burst of requests to a goroutine-dump endpoint can exhaust heap memory and trigger an out-of-memory kill. The fix is to enforce both a maximum output size and a cooldown period using a mutex-protected timestamp.

```go
// WRONG: Unlimited goroutine dumps can cause OOM
func goroutineDumpHandler(w http.ResponseWriter, r *http.Request) {
    buf := make([]byte, 1024*1024*100) // 100MB - dangerous!
    n := runtime.Stack(buf, true)
    w.Write(buf[:n])
}

// CORRECT: Limit goroutine dump size and rate
type GoroutineDumper struct {
    maxSize    int
    lastDump   time.Time
    minInterval time.Duration
    mu         sync.Mutex
}

func NewGoroutineDumper() *GoroutineDumper {
    return &GoroutineDumper{
        maxSize:     10 * 1024 * 1024, // 10MB max
        minInterval: 10 * time.Second,
    }
}

func (d *GoroutineDumper) Handler(w http.ResponseWriter, r *http.Request) {
    d.mu.Lock()
    if time.Since(d.lastDump) < d.minInterval {
        d.mu.Unlock()
        http.Error(w, "Rate limited. Try again later.", http.StatusTooManyRequests)
        return
    }
    d.lastDump = time.Now()
    d.mu.Unlock()

    // Start with small buffer, grow if needed
    buf := make([]byte, 64*1024)
    for {
        n := runtime.Stack(buf, true)
        if n < len(buf) || len(buf) >= d.maxSize {
            w.Header().Set("Content-Type", "text/plain")
            w.Write(buf[:n])
            return
        }
        // Double buffer size but don't exceed max
        newSize := len(buf) * 2
        if newSize > d.maxSize {
            newSize = d.maxSize
        }
        buf = make([]byte, newSize)
    }
}
```

### Mistake 4: Ignoring Context in Debug Operations

Accepting an arbitrary `seconds` query parameter and sleeping for that exact duration means a caller can pin a goroutine, and hold a CPU profile open, for hours, starving the profiler and blocking other diagnostics. Debug handlers must always cap the allowed duration and propagate cancellation through `context.WithTimeout` so that a dropped client connection or a server shutdown terminates the operation promptly.

```go
// WRONG: Debug operations without timeout
func captureProfile(w http.ResponseWriter, r *http.Request) {
    duration, _ := strconv.Atoi(r.URL.Query().Get("seconds"))

    // This can run forever if duration is large!
    pprof.StartCPUProfile(w)
    time.Sleep(time.Duration(duration) * time.Second)
    pprof.StopCPUProfile()
}

// CORRECT: Respect context and limit duration
func captureProfileWithContext(w http.ResponseWriter, r *http.Request) {
    const maxDuration = 120 * time.Second

    duration := 30 * time.Second // default
    if d, err := strconv.Atoi(r.URL.Query().Get("seconds")); err == nil {
        // Reject non-positive values explicitly. Without this check,
        // ?seconds=0 or ?seconds=-1 sails past the maxDuration test below,
        // time.After fires immediately, and the caller gets a valid-looking
        // profile containing no samples at all. An empty profile during an
        // incident reads as "nothing is running", which is worse than an error.
        if d <= 0 {
            http.Error(w, "seconds must be positive", http.StatusBadRequest)
            return
        }
        duration = time.Duration(d) * time.Second
    }

    if duration > maxDuration {
        http.Error(w, fmt.Sprintf("Max duration is %v", maxDuration), http.StatusBadRequest)
        return
    }

    // Create cancellable context
    ctx, cancel := context.WithTimeout(r.Context(), duration+5*time.Second)
    defer cancel()

    // Start profiling
    if err := pprof.StartCPUProfile(w); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    select {
    case <-time.After(duration):
        pprof.StopCPUProfile()
    case <-ctx.Done():
        pprof.StopCPUProfile()
        // Log that profile was interrupted
    }
}
```

### Mistake 5: Using Printf Debugging in Production

`fmt.Printf` writes unstructured text to stdout with no level gating, no correlation ID, and no way to suppress it at runtime without a rebuild. In production, noisy debug prints flood log aggregators, obscure genuine errors, and can inadvertently leak sensitive fields. Replacing ad-hoc prints with `slog` calls at the appropriate level (Debug or Info) keeps logs searchable, machine-parseable, and silenceable without touching production binaries.

```go
// WRONG: Printf debugging left in production code
func processOrder(ctx context.Context, order *Order) error {
    fmt.Printf("DEBUG: processing order %s\n", order.ID) // Don't do this!
    fmt.Printf("DEBUG: order items: %+v\n", order.Items)

    // ... business logic

    fmt.Printf("DEBUG: order processed successfully\n")
    return nil
}

// CORRECT: Use structured logging with proper levels
func processOrder(ctx context.Context, order *Order) error {
    logger := slog.Default()
    start := time.Now() // needed by the duration below

    logger.DebugContext(ctx, "processing order",
        "order_id", order.ID,
        "item_count", len(order.Items),
    )

    // ... business logic

    logger.InfoContext(ctx, "order processed",
        "order_id", order.ID,
        "duration_ms", time.Since(start).Milliseconds(),
    )
    return nil
}
```

For temporary debugging you can select an implementation at build time with build tags. This needs two separate files, one per variant, since a build constraint applies to a whole file. Two rules matter. The `//go:build` line must appear before the package clause, preceded only by blank lines and other comments, and a file may carry at most one `//go:build` line. Convention, enforced by `gofmt`, is to leave a blank line after it so it reads as a constraint rather than as package documentation. The blank line is style rather than semantics: the toolchain honours the constraint either way, and `gofmt` will insert it for you.

```go
// debug_on.go
//go:build debug

package main

import "log"

func debugLog(format string, args ...any) {
    log.Printf("[DEBUG] "+format, args...)
}
```

```go
// debug_off.go
//go:build !debug

package main

// Compiled into normal builds. The call sites remain, but the body is
// empty and the compiler inlines it away to nothing.
func debugLog(format string, args ...any) {}
```

Build the instrumented variant with `go build -tags debug`. Note the tags are complementary (`debug` and `!debug`), so exactly one file is always compiled. If you write two constraints that can both be false, the identifier disappears and the build breaks only in that configuration, which is the sort of thing CI catches and a laptop does not.

### Staff Lens: Mistakes Learned From Incidents

Every production debugging mistake becomes a team story. Document them. Reference in onboarding. Prevents recurrence.

---
