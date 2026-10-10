## 24.5 pprof in Production

### Low-Overhead Profiling

Start with the threat, because this is the one part of production debugging that has caused real breaches. A reachable `/debug/pprof/` is not a minor information leak. `/debug/pprof/heap` hands an attacker a sample of your live heap, which routinely contains auth tokens, request bodies, and keys. `/debug/pprof/cmdline` prints your full argv, which is where people put credentials. `/debug/pprof/profile` will happily burn 30 seconds of CPU per request, and `/debug/pprof/trace` will do worse, so both are free denial-of-service primitives for anyone who can reach the port. Internet-facing Go services with an open pprof port have been found and exploited repeatedly.

The single most dangerous line in the standard library is the one that looks harmless:

```go
import _ "net/http/pprof" // registers on http.DefaultServeMux as a side effect
```

If anything in your process later calls `http.ListenAndServe(addr, nil)`, that `nil` means `http.DefaultServeMux`, and you have just published every pprof endpoint on your public listener. The import may well be three dependencies deep and invisible in your own code.

So: run pprof on a dedicated port, bound to loopback, on a private `ServeMux` you construct yourself. Registering handlers explicitly rather than relying on the blank import gives you control over what is exposed and keeps it off `DefaultServeMux` entirely. Reach it from a laptop with `kubectl port-forward` or an SSH tunnel, which gives you your cluster's existing authentication for free rather than inventing a new one.

```go
package debug

import (
    "fmt"
    "net/http"
    "net/http/pprof"
    "time"
)

// SetupPprof creates a separate loopback-only HTTP server for pprof.
// Reach it with `kubectl port-forward` or an SSH tunnel, never by binding
// this to 0.0.0.0.
func SetupPprof(port int) *http.Server {
    mux := http.NewServeMux()

    // pprof.Index dispatches every named profile under this prefix
    // (heap, goroutine, allocs, block, mutex, threadcreate), so this
    // one registration covers them all.
    mux.HandleFunc("/debug/pprof/", pprof.Index)
    mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

    return &http.Server{
        // Loopback only. This is the control that matters.
        Addr:        fmt.Sprintf("127.0.0.1:%d", port),
        Handler:     mux,
        ReadTimeout: 60 * time.Second,
        // No WriteTimeout: a 30-second CPU profile or a long trace
        // capture writes for longer than any sane write deadline, and a
        // WriteTimeout here truncates the profile into a corrupt file.
        // This is safe precisely because the listener is loopback-only.
        WriteTimeout: 0,
    }
}
```

### Continuous Profiling

On-demand profiling captures a snapshot in time, but continuous profiling stores periodic profiles so you can correlate CPU and memory usage with specific deployments or traffic spikes after the fact. A `ContinuousProfiler` launches a brief CPU capture in a separate goroutine to avoid blocking the main loop, while heap and goroutine profiles are cheap enough to capture synchronously on each tick.

```go
package debug

import (
    "bytes"
    "context"
    "io"
    "log/slog"
    "runtime/pprof"
    "time"
)

type ContinuousProfiler struct {
    logger   *slog.Logger
    storage  ProfileStorage
    interval time.Duration
    duration time.Duration
}

type ProfileStorage interface {
    Store(ctx context.Context, profileType string, data []byte, timestamp time.Time) error
}

func NewContinuousProfiler(logger *slog.Logger, storage ProfileStorage) *ContinuousProfiler {
    return &ContinuousProfiler{
        logger:   logger,
        storage:  storage,
        interval: 60 * time.Second,
        duration: 10 * time.Second,
    }
}

func (p *ContinuousProfiler) Start(ctx context.Context) {
    ticker := time.NewTicker(p.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.captureProfiles(ctx)
        }
    }
}

func (p *ContinuousProfiler) captureProfiles(ctx context.Context) {
    timestamp := time.Now()

    // Capture CPU profile
    go func() {
        var buf bytes.Buffer
        if err := pprof.StartCPUProfile(&buf); err != nil {
            p.logger.Error("failed to start CPU profile", "error", err)
            return
        }
        time.Sleep(p.duration)
        pprof.StopCPUProfile()

        if err := p.storage.Store(ctx, "cpu", buf.Bytes(), timestamp); err != nil {
            p.logger.Error("failed to store CPU profile", "error", err)
        }
    }()

    // Capture heap profile
    var heapBuf bytes.Buffer
    if err := pprof.WriteHeapProfile(&heapBuf); err != nil {
        p.logger.Error("failed to capture heap profile", "error", err)
    } else {
        if err := p.storage.Store(ctx, "heap", heapBuf.Bytes(), timestamp); err != nil {
            p.logger.Error("failed to store heap profile", "error", err)
        }
    }

    // Capture goroutine profile
    var goroutineBuf bytes.Buffer
    profile := pprof.Lookup("goroutine")
    if err := profile.WriteTo(&goroutineBuf, 0); err != nil {
        p.logger.Error("failed to capture goroutine profile", "error", err)
    } else {
        if err := p.storage.Store(ctx, "goroutine", goroutineBuf.Bytes(), timestamp); err != nil {
            p.logger.Error("failed to store goroutine profile", "error", err)
        }
    }
}
```

### Profile Comparison

Comparing a baseline profile captured before a regression against a current profile pinpoints exactly which allocation sites or call paths changed. The `-base` flag to `go tool pprof` subtracts the baseline from the current profile, so `top10` shows only the growth, the lines responsible for the increase in heap usage or CPU time, not the entire program.

```bash
# Capture baseline profile
curl -o baseline.prof http://localhost:6060/debug/pprof/heap

# Wait for issue to manifest...

# Capture current profile
curl -o current.prof http://localhost:6060/debug/pprof/heap

# Compare profiles
go tool pprof -base=baseline.prof current.prof
(pprof) top10
(pprof) web          # opens a dot callgraph as SVG, not a flame graph

# The browser UI is the better tool for a diff, and its landing page is the flame graph
go tool pprof -http=:8081 -base=baseline.prof current.prof
```

Two flags are worth knowing here. `-base` subtracts the baseline and shows you the net change, which is what you want for a heap regression. `-diff_base` does the same subtraction but keeps the scale of the original profile, which is what you want when you need to see the growth in proportion to total usage rather than in isolation.

### Production Safety Envelope

Before wiring pprof into a production path, know where the cost actually falls so you can answer the inevitable SRE pushback:

- CPU profile (`/debug/pprof/profile`): a few percent of CPU while the capture is active, and nothing at all otherwise. The handlers cost nothing when idle. Default capture is 30 seconds, adjustable with `?seconds=`.
- Heap profile: a sampled snapshot, not a census. The runtime records roughly one allocation per 512KB by default (`runtime.MemProfileRate`), which is what makes it cheap enough to leave on permanently. Dropping `MemProfileRate` to 1 profiles every allocation and makes the service unusable in prod. Leave the default alone.
- Goroutine profile: the two verbosity levels differ in kind, not degree. Verbosity 1 takes a short stop-the-world to snapshot the goroutine set, then walks stacks concurrently. Verbosity 2 calls `runtime.Stack(buf, true)`, which holds the world stopped for the whole walk, so the pause grows with your goroutine count. Use 1 for anything periodic.
- Block and mutex profiling: these record nothing at all until you turn them on. `runtime.SetBlockProfileRate` and `runtime.SetMutexProfileFraction` both default to 0, and an untouched service serves an empty profile from `/debug/pprof/block` and `/debug/pprof/mutex`. This surprises people mid-incident. Once enabled they carry continuous overhead proportional to contention events, so enable them on one canary pod during an active investigation rather than fleet-wide.

### Goroutine Leak Profile

The GC-backed goroutine leak profile was gated behind `GOEXPERIMENT=goroutineleakprofile` in Go 1.26 and is on by default as of Go 1.27. The runtime exposes `/debug/pprof/goroutineleak`, which reports only goroutines the GC has proven unreachable from any runnable goroutine, cutting out the noise of the regular goroutine profile.

Reachability is the whole idea. The regular goroutine profile shows you every goroutine and leaves you to judge which ones are stuck. This one applies a proof: a goroutine blocked on a channel that no runnable goroutine can still reach is never going to wake up, and the runtime can establish that during a GC cycle.

```bash
# On 1.27 and later, nothing special at build time
go build -o myapp ./cmd/myapp

# On 1.26, the experiment had to be enabled at build time
GOEXPERIMENT=goroutineleakprofile go build -o myapp ./cmd/myapp

# From a running instance
curl -o leaks.prof http://localhost:6060/debug/pprof/goroutineleak
go tool pprof -http=:8081 leaks.prof
```

Note that collecting this profile runs a GC with leak detection enabled before it can answer, so it is meaningfully more expensive than reading the plain goroutine profile. It is an investigation tool, not something to scrape every 15 seconds.

> **Senior track**: The leak profile's proof condition (blocked on a primitive unreachable from any runnable goroutine) catches the overwhelmingly common case of a goroutine waiting forever on a channel nobody holds. It does NOT catch leaks where a leaked goroutine is still transitively reachable (for example, stored in a package-level registry). Combine with heap dominator analysis for those.

### Flight Recorder (runtime/trace)

Go 1.25 added `runtime/trace.FlightRecorder` to the standard library. It maintains a ring buffer of the most recent execution trace and lets you dump the last N seconds on demand when an SLO violation fires, without paying for full-time tracing. This is the Go analog of JVM Flight Recorder and pairs naturally with tail-latency alerting.

```go
import (
    "io"
    "runtime/trace"
    "time"
)

func setupFlightRecorder() (*trace.FlightRecorder, error) {
    fr := trace.NewFlightRecorder(trace.FlightRecorderConfig{
        MinAge:   5 * time.Second,
        MaxBytes: 64 << 20, // 64 MiB ring buffer
    })
    if err := fr.Start(); err != nil {
        return nil, err
    }
    return fr, nil
}

// Dump on SLO violation
func dumpTraceOnSpike(fr *trace.FlightRecorder, w io.Writer) error {
    _, err := fr.WriteTo(w)
    return err
}
```

### Staff Lens: pprof Exposure Policy

Every production service exposes `/debug/pprof/` behind auth (not public, not without auth). Standard port, standard path. On-call engineers know how to use it. Without this, incidents drag on while engineers try to capture a profile from a burning service.

---
