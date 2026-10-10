## 105B.7 Diagnosing Production Go Services

### The Debugging Flow

During an incident, the diagnostic flow follows a structured path:

```
SYMPTOMS (user-visible)
    |
    v
INDICATORS (metrics, alerts firing)
    |
    v
SCOPE (which service, region, version, user segment?)
    |
    v
RECENT CHANGES (deployments in last 24h? config changes? upstream changes?)
    |
    v
CAUSES (specific code path, resource, dependency)
    |
    v
MITIGATION (rollback, fix, workaround)
```

### Key Metrics to Check First

When a Go service is behaving badly, check in this order:

1. **Error rate by endpoint**: which paths are failing?
2. **Latency percentiles (p50, p99)**: is everything slow or just some endpoints?
3. **Goroutine count**: growing? Leaked?
4. **GC pause duration**: high GC pressure affecting latency?
5. **Memory (heap in use)**: growing? Near limit?
6. **Open file descriptors**: near system limit?
7. **Database connection pool utilization**: exhausted?
8. **Dependency health**: downstream services timing out?

### Goroutine Analysis Under Load

During an incident, a goroutine dump reveals exactly what every goroutine in the process is doing, which ones are blocked on I/O, which are waiting on a channel, and which are stuck in a mutex contention. The `GoroutineAnalyzer` below captures a runtime goroutine profile via pprof and groups goroutines by their stack trace to identify accumulation patterns that indicate a leak.

```go
package diagnostic

import (
	"cmp"
	"fmt"
	"net/http"
	"runtime"
	"slices"
	"strings"
)

// GoroutineReportHandler analyzes the current goroutine state and returns a
// structured report useful for incident diagnosis.
// Expose this as an HTTP handler at /debug/goroutine-report
func GoroutineReportHandler(w http.ResponseWriter, r *http.Request) {
	buf := make([]byte, 1<<20) // 1MB buffer
	n := runtime.Stack(buf, true)
	stacks := string(buf[:n])

	// Parse goroutine stacks to find patterns
	goroutines := parseGoroutineStacks(stacks)

	// Group by top-of-stack function
	groups := make(map[string]int)
	for _, g := range goroutines {
		if len(g.frames) > 0 {
			groups[g.frames[0]]++
		}
	}

	// Sort by count descending
	type entry struct {
		fn    string
		count int
	}
	entries := make([]entry, 0, len(groups))
	for fn, count := range groups {
		entries = append(entries, entry{fn, count})
	}
	slices.SortFunc(entries, func(a, b entry) int {
		return cmp.Compare(b.count, a.count)
	})

	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "Total goroutines: %d\n\n", len(goroutines))
	fmt.Fprintf(w, "Top goroutine groups:\n")
	for i, e := range entries {
		if i >= 20 {
			break
		}
		fmt.Fprintf(w, "  %4d  %s\n", e.count, e.fn)
	}
	fmt.Fprintf(w, "\nFull dump:\n%s", stacks)
}

type goroutineStack struct {
	id     string
	state  string
	frames []string
}

func parseGoroutineStacks(dump string) []goroutineStack {
	var result []goroutineStack
	var current *goroutineStack

	for _, line := range strings.Split(dump, "\n") {
		if strings.HasPrefix(line, "goroutine ") {
			if current != nil {
				result = append(result, *current)
			}
			current = &goroutineStack{}
			parts := strings.SplitN(line, " ", 3)
			if len(parts) >= 2 {
				current.id = parts[1]
			}
			if len(parts) >= 3 {
				current.state = strings.Trim(parts[2], "[]:\n")
			}
		} else if current != nil && line != "" && !strings.HasPrefix(line, "\t") {
			// Function name lines are not tab-indented. Tab-indented lines
			// hold file:line locations and are skipped for grouping.
			current.frames = append(current.frames, strings.TrimSpace(line))
		}
	}
	if current != nil {
		result = append(result, *current)
	}
	return result
}
```

### Memory Analysis During Incident

When memory is climbing during an incident, you need numbers faster than a full pprof heap analysis can provide. The snapshot handler below reads `runtime.MemStats` and prints the fields that matter for triage: heap in use versus idle, GC frequency, and the live object count that reveals whether allocations are outpacing frees.

```go
package diagnostic

import (
	"fmt"
	"net/http"
	"runtime"
	"time"
)

// MemorySnapshotHandler provides a quick memory snapshot without requiring
// pprof tooling. Useful when you need fast answers during an incident.
func MemorySnapshotHandler(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "=== Memory Snapshot ===\n")
	fmt.Fprintf(w, "HeapAlloc:    %s (currently allocated on heap)\n", formatBytes(ms.HeapAlloc))
	fmt.Fprintf(w, "HeapSys:      %s (heap memory from OS)\n", formatBytes(ms.HeapSys))
	fmt.Fprintf(w, "HeapInuse:    %s (heap spans actively used)\n", formatBytes(ms.HeapInuse))
	fmt.Fprintf(w, "HeapIdle:     %s (heap spans waiting to be returned)\n", formatBytes(ms.HeapIdle))
	fmt.Fprintf(w, "HeapReleased: %s (returned to OS)\n", formatBytes(ms.HeapReleased))
	fmt.Fprintf(w, "\nStack:\n")
	fmt.Fprintf(w, "StackInuse:   %s\n", formatBytes(ms.StackInuse))
	fmt.Fprintf(w, "StackSys:     %s\n", formatBytes(ms.StackSys))
	fmt.Fprintf(w, "\nGC:\n")
	fmt.Fprintf(w, "NumGC:        %d\n", ms.NumGC)
	fmt.Fprintf(w, "LastGC:       %v ago\n", lastGCDuration(ms))
	fmt.Fprintf(w, "PauseTotalNs: %s\n", formatNanos(ms.PauseTotalNs))
	fmt.Fprintf(w, "NextGC:       %s (heap target to trigger next GC)\n", formatBytes(ms.NextGC))
	fmt.Fprintf(w, "\nObjects:\n")
	fmt.Fprintf(w, "HeapObjects:  %d\n", ms.HeapObjects)
	fmt.Fprintf(w, "Mallocs:      %d (total allocations)\n", ms.Mallocs)
	fmt.Fprintf(w, "Frees:        %d\n", ms.Frees)
	fmt.Fprintf(w, "Live objects: %d\n", ms.Mallocs-ms.Frees)
}

func formatBytes(b uint64) string {
	const (
		KB = 1024
		MB = 1024 * KB
		GB = 1024 * MB
	)
	switch {
	case b >= GB:
		return fmt.Sprintf("%.2f GB", float64(b)/GB)
	case b >= MB:
		return fmt.Sprintf("%.2f MB", float64(b)/MB)
	case b >= KB:
		return fmt.Sprintf("%.2f KB", float64(b)/KB)
	default:
		return fmt.Sprintf("%d B", b)
	}
}

func formatNanos(ns uint64) string {
	return fmt.Sprintf("%.2f ms", float64(ns)/1e6)
}

func lastGCDuration(ms runtime.MemStats) string {
	if ms.LastGC == 0 {
		return "never"
	}
	// LastGC is nanoseconds since the Unix epoch
	last := time.Unix(0, int64(ms.LastGC))
	return time.Since(last).Round(time.Millisecond).String()
}
```

### Essential Debug Endpoints for Every Go Service

Every production Go service must expose these endpoints. Non-negotiable.

```go
package server

import (
	"expvar"
	"net/http"
	"net/http/pprof"
	"runtime"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"yourmodule/internal/diagnostic"
)

// RegisterDebugHandlers registers all diagnostic endpoints on the given mux.
// This should be on a SEPARATE port (e.g., 6060) NOT exposed to the public internet.
// Expose only internally (Kubernetes internal service, VPN-only access).
func RegisterDebugHandlers(mux *http.ServeMux) {
	// Standard pprof endpoints
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	// expvar: exported variables (useful for quick reads during incident)
	mux.Handle("/debug/vars", expvar.Handler())

	// Prometheus metrics
	mux.Handle("/metrics", promhttp.Handler())

	// Custom: goroutine report
	mux.HandleFunc("/debug/goroutines", diagnostic.GoroutineReportHandler)

	// Custom: memory snapshot
	mux.HandleFunc("/debug/memory", diagnostic.MemorySnapshotHandler)

	// Health (liveness + readiness)
	mux.HandleFunc("/healthz", healthzHandler)
	mux.HandleFunc("/readyz", readyzHandler)
}

// expvar setup: publish key runtime metrics as exported variables
func init() {
	expvar.Publish("goroutines", expvar.Func(func() any {
		return runtime.NumGoroutine()
	}))
	expvar.Publish("timestamp", expvar.Func(func() any {
		return time.Now().UTC().Format(time.RFC3339)
	}))
	expvar.Publish("goversion", expvar.Func(func() any {
		return runtime.Version()
	}))
	expvar.Publish("numcpu", expvar.Func(func() any {
		return runtime.NumCPU()
	}))
}

func healthzHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func readyzHandler(w http.ResponseWriter, r *http.Request) {
	// Check all dependencies
	// Return 503 if any critical dependency is unhealthy
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ready"}`))
}
```

### Junior → FAANG: Go Diagnostic Tools You Must Know Before On-Call

The `net/http/pprof` endpoint is the most important diagnostic tool for Go services in production. Before your first on-call shift, know how to use these four pprof endpoints:

`/debug/pprof/goroutine?debug=2` dumps all goroutine stacks. Use this when the service is unresponsive: the goroutine dump shows what all goroutines are blocked on (usually a lock, a channel, or a network call). A goroutine dump that shows thousands of goroutines all blocked on the same mutex points immediately to a deadlock or a slow critical section.

`/debug/pprof/heap` captures the current heap allocation. Use this during a memory leak investigation: compare two heap dumps taken 5 minutes apart to see which allocation sites are growing.

`/debug/pprof/profile?seconds=30` captures 30 seconds of CPU profile. Use this during a CPU spike: the top functions in the profile reveal where CPU time is being spent.

`/debug/pprof/trace?seconds=5` captures a Go execution trace. Use this for latency investigations: the trace shows goroutine scheduling, GC pauses, and syscall timing, revealing which part of the request lifecycle is slow.

### Senior @ FAANG: Diagnostic Tooling as Platform Infrastructure

At L6, diagnostic tooling is not left to individual engineers to configure. The platform team provides a standard diagnostic package that every service includes by default: pprof endpoints on an internal-only port (not exposed to the public internet), standardized health check endpoints that return structured JSON with component-level status, continuous profiling integration (using Pyroscope or Google's continuous profiler), and goroutine leak detection middleware that alerts when the goroutine count exceeds a configurable threshold.

Continuous profiling is the diagnostic capability gap most FAANG engineers identify after their first major incident. A one-time pprof capture shows the current state. Continuous profiling shows the trend over hours or days, enabling you to identify when a goroutine leak started, what the CPU profile looked like before and after a deploy, and whether a memory trend is linear or exponential. An L6 engineer makes the case for continuous profiling investment based on the MTTR reduction it enables.

---
