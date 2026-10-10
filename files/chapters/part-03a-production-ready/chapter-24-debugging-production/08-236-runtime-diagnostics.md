## 24.6 Runtime Diagnostics

### Memory Statistics

`runtime.ReadMemStats` populates a `MemStats` struct with granular allocator metrics: current live heap bytes, cumulative bytes allocated since program start, bytes obtained from the OS, and GC cycle counts. Exposing these as a JSON endpoint gives operators a live view of heap growth trends and lets alerting systems detect memory leaks before the process OOM-kills.

```go
package debug

import (
    "encoding/json"
    "net/http"
    "runtime"
)

type MemoryStats struct {
    Alloc        uint64 `json:"alloc_bytes"`
    TotalAlloc   uint64 `json:"total_alloc_bytes"`
    Sys          uint64 `json:"sys_bytes"`
    HeapAlloc    uint64 `json:"heap_alloc_bytes"`
    HeapInuse    uint64 `json:"heap_inuse_bytes"`
    HeapObjects  uint64 `json:"heap_objects"`
    StackInuse   uint64 `json:"stack_inuse_bytes"`
    NumGC        uint32 `json:"num_gc"`
    NumGoroutine int    `json:"num_goroutine"`
}

func memoryStatsHandler(w http.ResponseWriter, r *http.Request) {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    stats := MemoryStats{
        Alloc:        m.Alloc,
        TotalAlloc:   m.TotalAlloc,
        Sys:          m.Sys,
        HeapAlloc:    m.HeapAlloc,
        HeapInuse:    m.HeapInuse,
        HeapObjects:  m.HeapObjects,
        StackInuse:   m.StackInuse,
        NumGC:        m.NumGC,
        NumGoroutine: runtime.NumGoroutine(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}
```

### GC Statistics

GC pause duration is the runtime metric most directly correlated with P99 latency spikes. `debug.ReadGCStats` provides the per-cycle pause history as a slice, ordered most recent first. Taking the maximum across a recent window and computing the rolling average gives operations teams the information needed to tune `GOGC` or evaluate whether a smaller heap target would reduce tail latency.

Two details of the API catch people out. `stats.Pause` is reused if it is large enough and reallocated otherwise, and the runtime may use its full capacity, so do not assume the length you passed in is the length you get back. And if you want the distribution rather than a hand-rolled scan, set `stats.PauseQuantiles` to a non-empty slice before the call and `ReadGCStats` fills it for you: a length of 5 yields minimum, 25th, 50th, 75th, and maximum.

```go
package debug

import (
    "encoding/json"
    "net/http"
    "runtime/debug"
    "time"
)

type GCStats struct {
    LastGC          time.Time       `json:"last_gc"`
    NumGC           int64           `json:"num_gc"`
    PauseTotal      time.Duration   `json:"pause_total"`
    PauseAvg        time.Duration   `json:"pause_avg"`
    PauseRecentMax  time.Duration   `json:"pause_recent_max"`
    PauseQuantiles  []time.Duration `json:"pause_quantiles"` // min, p25, p50, p75, max
    RecentPauses    []time.Duration `json:"recent_pauses"`
}

func gcStatsHandler(w http.ResponseWriter, r *http.Request) {
    // A non-empty PauseQuantiles tells ReadGCStats to fill it: with five
    // entries that is min, p25, p50, p75, max across the whole history.
    stats := debug.GCStats{PauseQuantiles: make([]time.Duration, 5)}
    debug.ReadGCStats(&stats)

    // stats.Pause is ordered most-recent-first, so this window is the
    // last 10 cycles, not the worst 10. Named accordingly: it is a recent
    // max, not the all-time max, which is what PauseQuantiles reports.
    var pauseRecentMax time.Duration
    recentPauses := make([]time.Duration, 0, 10)
    for i, p := range stats.Pause {
        if i >= 10 {
            break
        }
        recentPauses = append(recentPauses, p)
        if p > pauseRecentMax {
            pauseRecentMax = p
        }
    }

    var pauseAvg time.Duration
    if stats.NumGC > 0 {
        pauseAvg = stats.PauseTotal / time.Duration(stats.NumGC)
    }

    response := GCStats{
        LastGC:         stats.LastGC,
        NumGC:          stats.NumGC,
        PauseTotal:     stats.PauseTotal,
        PauseAvg:       pauseAvg,
        PauseRecentMax: pauseRecentMax,
        PauseQuantiles: stats.PauseQuantiles,
        RecentPauses:   recentPauses,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

### GODEBUG Environment Variables

`GODEBUG` enables verbose runtime tracing without recompiling the binary. The `gctrace=1` output line encodes GC timing, heap sizes before and after collection, and the number of processors involved, essential for diagnosing GC pressure in production. `schedtrace` logs the scheduler's view of goroutine and processor state at the specified millisecond interval, helping diagnose stalls caused by OS thread saturation.

```bash
# GC tracing: one line per collection, on stderr
GODEBUG=gctrace=1 ./myapp

# Output: gc 1 @0.012s 2%: 0.026+0.42+0.004 ms clock, 0.10+0.32/0.28/0+0.016 ms cpu, 4->4->0 MB, 5 MB goal, 4 P

# Scheduler tracing every 1000ms
GODEBUG=schedtrace=1000 ./myapp

# Add per-P detail to schedtrace (very noisy)
GODEBUG=schedtrace=1000,scheddetail=1 ./myapp
```

Reading the `gctrace` line is worth doing slowly, because every field earns its place. `@0.012s` is the time since start, `2%` is the cumulative fraction of CPU spent in GC since start (the number to watch, and the number to quote when someone claims GC is the problem), the three clock figures are the sweep-termination, concurrent-mark, and mark-termination phases, and `4->4->0 MB` is heap size at GC start, at GC end, and live heap after. `5 MB goal` is the target that triggers the next cycle. If the goal is climbing steadily across cycles while the live figure stays flat, you are looking at allocation churn rather than a leak.

A caution on GODEBUG advice you will find in older posts and older editions of books: these keys come and go. `allocfreetrace=1`, widely recommended for allocation tracing, was removed from the runtime and does nothing now. A GODEBUG key the runtime does not recognise is silently ignored rather than rejected, so a stale option looks exactly like a working one that found nothing. Check the runtime package documentation for the list that your toolchain actually honours instead of trusting a snippet. For allocation-level detail, the heap profile and the execution tracer replaced `allocfreetrace` and are better tools regardless.

Two more that are commonly misquoted. `invalidptr=1` is already the default, so setting it changes nothing: the only meaningful use is `invalidptr=0` to *disable* the check, which you should not do outside of debugging a cgo pointer-passing bug. And `madvdontneed=1` stopped mattering on Linux once Go made it the default behaviour.

### GOMEMLIMIT and Soft Memory Pressure

`GOMEMLIMIT` (stable since Go 1.19, refined through 1.26) sets a soft cap on total runtime-managed memory. When the heap approaches the limit, the GC becomes more aggressive to avoid OOM. It is the single most important tuning knob for containerized Go services and should be set to roughly 80-90% of the container's memory limit (leaving headroom for stack, goroutine metadata, and off-heap allocations).

```bash
# Set to 90% of a 2 GiB container
GOMEMLIMIT=1843MiB ./myapp
```

Expose `runtime/metrics` counters alongside `MemStats` for finer-grained signals. The modern `runtime/metrics` package is preferred over `ReadMemStats` for new code because it is incremental, typed, and extensible:

```go
import "runtime/metrics"

func readHeapLive() uint64 {
    samples := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
    metrics.Read(samples)
    if samples[0].Value.Kind() == metrics.KindUint64 {
        return samples[0].Value.Uint64()
    }
    return 0
}
```

> **Senior track**: Pair `GOMEMLIMIT` with `GOGC=off` only if you have measured it. The official guidance is to leave `GOGC` at its default and let `GOMEMLIMIT` act as the backstop. Setting `GOGC=off` disables the heap-target-based trigger entirely, which can starve the GC and cause latency cliffs right before OOM. The pattern to reach for is "keep GOGC default, set GOMEMLIMIT" not "disable GOGC and hope".

### Staff Lens: Runtime Metrics on Every Dashboard

Goroutine count, GC pause duration, heap size, open file descriptors. These belong on every production service's dashboard. Trends reveal problems before they become incidents.

---
