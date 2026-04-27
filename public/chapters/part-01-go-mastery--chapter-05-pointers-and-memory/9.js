export default `## 5.8 Memory Profiling with pprof

When a Go service exhibits unexpected latency or memory growth, guessing at the cause wastes time. Go ships with \`pprof\`, a profiling tool that captures exactly which functions allocate the most memory and how often GC runs. This section covers both programmatic and HTTP-based profiling workflows.

### Basic Memory Profiling

The \`pprof\` tool collects allocation profiles that show which functions allocate the most memory. The workflow involves writing a profile during execution, then analyzing it with the \`go tool pprof\` command.

\`\`\`go
import (
    "os"
    "runtime"
    "runtime/pprof"
)

func main() {
    // Start memory profiling
    f, _ := os.Create("mem.prof")
    defer f.Close()

    // Run your program
    doWork()

    // Force GC to get accurate heap profile
    runtime.GC()
    pprof.WriteHeapProfile(f)
}
\`\`\`

Analyze with:
\`\`\`bash
go tool pprof mem.prof
# Interactive commands:
# top10        - Top 10 memory consumers
# list <func>  - Line-by-line breakdown
# web          - Visualization (requires graphviz)
\`\`\`

### HTTP pprof Endpoint

Importing \`net/http/pprof\` registers profiling endpoints that can be sampled at any time from a running process. This enables profiling production services without redeployment.

\`\`\`go
import (
    "net/http"
    _ "net/http/pprof"  // Register pprof handlers
)

func main() {
    // Access at /debug/pprof/heap
    go http.ListenAndServe(":6060", nil)

    // Your application
    startServer()
}
\`\`\`

### Production pprof Setup

A production pprof endpoint should be secured behind authentication and served on a separate internal port to prevent exposure to the public internet.

\`\`\`go
package profiling

import (
    "net/http"
    "net/http/pprof"
    "runtime"
)

// SetupProfiling configures profiling endpoints with authentication
func SetupProfiling(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler) {
    // Wrap with authentication for production
    profileMux := http.NewServeMux()
    profileMux.HandleFunc("/debug/pprof/", pprof.Index)
    profileMux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    profileMux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    profileMux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    profileMux.HandleFunc("/debug/pprof/trace", pprof.Trace)

    // Memory profile with GC
    profileMux.HandleFunc("/debug/pprof/heap", func(w http.ResponseWriter, r *http.Request) {
        runtime.GC()  // Force GC for accurate heap
        pprof.Handler("heap").ServeHTTP(w, r)
    })

    // Require auth in production
    mux.Handle("/debug/pprof/", authMiddleware(profileMux))
}

// MemStats returns current memory statistics
func MemStats() runtime.MemStats {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    return m
}
\`\`\`

### Uber's Memory Profiling in Production

Uber runs continuous memory monitoring in production Go services. The following monitor periodically reads runtime memory statistics, logs them as structured fields, and raises warnings when heap usage approaches a configured threshold. This pattern catches memory regressions between deployments before they cause outages.

\`\`\`go
package memory

import (
    "runtime"
    "time"

    "go.uber.org/zap"
)

// Monitor tracks memory usage and logs warnings
type Monitor struct {
    logger        *zap.Logger
    maxHeapBytes  uint64
    checkInterval time.Duration
    done          chan struct{}
}

func NewMonitor(logger *zap.Logger, maxHeapBytes uint64) *Monitor {
    return &Monitor{
        logger:        logger,
        maxHeapBytes:  maxHeapBytes,
        checkInterval: 30 * time.Second,
        done:          make(chan struct{}),
    }
}

func (m *Monitor) Start() {
    go m.run()
}

func (m *Monitor) Stop() {
    close(m.done)
}

func (m *Monitor) run() {
    ticker := time.NewTicker(m.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            var stats runtime.MemStats
            runtime.ReadMemStats(&stats)

            // Log memory stats
            m.logger.Info("memory stats",
                zap.Uint64("heap_alloc_mb", stats.HeapAlloc/1024/1024),
                zap.Uint64("heap_sys_mb", stats.HeapSys/1024/1024),
                zap.Uint64("heap_objects", stats.HeapObjects),
                zap.Uint32("gc_runs", stats.NumGC),
                zap.Float64("gc_pause_ms", float64(stats.PauseNs[(stats.NumGC+255)%256])/1e6),
            )

            // Warn if approaching limit
            if stats.HeapAlloc > m.maxHeapBytes*80/100 {
                m.logger.Warn("memory usage high",
                    zap.Uint64("heap_alloc", stats.HeapAlloc),
                    zap.Uint64("max_heap", m.maxHeapBytes),
                    zap.Float64("percent_used", float64(stats.HeapAlloc)/float64(m.maxHeapBytes)*100),
                )
            }

            // Critical if over limit
            if stats.HeapAlloc > m.maxHeapBytes {
                m.logger.Error("memory usage critical - consider restart",
                    zap.Uint64("heap_alloc", stats.HeapAlloc),
                    zap.Uint64("max_heap", m.maxHeapBytes),
                )
                // Trigger manual GC
                runtime.GC()
            }

        case <-m.done:
            return
        }
    }
}
\`\`\`

### Flight Recorder (Go 1.25+)

\`pprof\` captures a point-in-time snapshot. When a service misbehaves at 03:17 and you attach pprof at 03:18, the allocation pattern that caused the incident is already gone. The Flight Recorder, added to \`runtime/trace\` in Go 1.25, solves this by keeping a rolling in-memory ring buffer of execution trace events at near-zero overhead, which you can dump to disk the moment your alerting fires.

\`\`\`go
import (
    "os"
    "runtime/trace"
)

func main() {
    fr := trace.NewFlightRecorder()
    fr.SetPeriod(60 * time.Second)   // keep the last 60s of trace data
    fr.SetSize(64 * 1024 * 1024)     // ~64 MiB ring buffer
    if err := fr.Start(); err != nil {
        log.Fatal(err)
    }
    defer fr.Stop()

    http.HandleFunc("/debug/fr/dump", func(w http.ResponseWriter, r *http.Request) {
        f, _ := os.CreateTemp("", "flightrecorder-*.trace")
        defer f.Close()
        if _, err := fr.WriteTo(f); err != nil {
            http.Error(w, err.Error(), 500)
            return
        }
        fmt.Fprintf(w, "wrote %s\\n", f.Name())
    })

    startServer()
}
\`\`\`

Wire the dump endpoint into your alerting: on a high-latency or high-RSS alert, the on-call pipeline curls the endpoint and attaches the trace to the incident ticket. Analyze with \`go tool trace path/to/file.trace\`. Typical overhead is 1-2 percent CPU and a few tens of MiB of RAM, cheap insurance for services where postmortem-quality evidence is expensive to reproduce.

### Continuous Profiling in 2026

For always-on profiling across a fleet, the common tooling in 2026 is Grafana Pyroscope (CNCF incubating) and Parca, both of which ingest pprof over HTTP and keep weeks of history. Datadog, Elastic, and Google Cloud offer hosted equivalents. The standard pattern is to expose pprof on an internal port as shown above, let the collector scrape \`/debug/pprof/heap\`, \`/debug/pprof/profile\`, and \`/debug/pprof/allocs\` on a schedule, and correlate the profiles against request traces and error spikes. This turns "run pprof when someone pages" into "search the last 30 days of heap profiles for the function that started leaking after deploy 42."

### \`runtime.AddCleanup\` Over \`runtime.SetFinalizer\` (Go 1.24+)

\`runtime.SetFinalizer\` was the pre-1.24 way to attach a cleanup function to an object before the GC collects it. It is error-prone: finalizers can resurrect their target, only run once per object, and cause the target to live one extra GC cycle. Go 1.24 introduced \`runtime.AddCleanup\`, which addresses all three issues. Multiple cleanups can attach to the same object, they cannot resurrect it, and they do not extend the object's lifetime.

\`\`\`go
import "runtime"

type FileHandle struct {
    fd int
}

func Open(path string) *FileHandle {
    fh := &FileHandle{fd: openFD(path)}
    runtime.AddCleanup(fh, func(fd int) {
        closeFD(fd)  // runs after fh is collected
    }, fh.fd)
    return fh
}
\`\`\`

Use \`AddCleanup\` as a safety net for OS resources (file descriptors, mmap regions, CGO-allocated memory) when you cannot guarantee explicit \`Close()\` calls. Do not use it for correctness-critical cleanup, an explicit \`defer\` or \`Close\` is still the right answer for anything whose timing matters.

### Reading a Heap Profile in Five Minutes

The mid-level workflow for diagnosing memory growth in a service:

1. **Capture the baseline.** \`curl localhost:6060/debug/pprof/heap > heap.pre\`. Take this when the service is healthy.
2. **Wait for the regression.** Let the service run until memory is up.
3. **Capture the regressed profile.** \`curl localhost:6060/debug/pprof/heap > heap.post\`.
4. **Compare.** \`go tool pprof -base heap.pre heap.post\`. The output shows the delta, not the absolute. Functions that grew between the two captures are the leak candidates.
5. **Drill down.** \`top10 -cum\` shows cumulative allocations. \`list FuncName\` shows line-by-line. The leak is usually in the top three lines of the top function.

The same workflow applies to allocation profiling (\`/debug/pprof/allocs\` for total allocations) and CPU profiling (\`/debug/pprof/profile\` for CPU time). The discipline of "capture before, capture after, diff" is the core debugging skill for Go performance work.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in profiling-related PRs:

1. **A pprof endpoint without authentication on a public-facing service.** Always a finding. pprof exposes program internals including allocation patterns and goroutine state. Wrap with auth.
2. **\`runtime.GC()\` called from production code (outside profiling setup).** Almost always wrong. The GC is automatic. Manual triggering disrupts the pacer and produces worse latency, not better.
3. **\`runtime.SetFinalizer\` for new code.** Replace with \`runtime.AddCleanup\` (Go 1.24+) for the bug-fix benefits, or with explicit \`Close\` discipline for correctness-critical cleanup.

---
`;
