export default `## 7.5 Garbage Collector Deep Dive

### Tri-Color Mark and Sweep Algorithm

Go's GC uses a concurrent tri-color mark-and-sweep algorithm. The "tri-color" refers to a logical coloring of heap objects during collection: white objects have not been visited, grey objects have been visited but their references have not been fully traced, and black objects are fully traced and confirmed reachable. The algorithm processes grey objects until none remain, then reclaims all white objects as garbage.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Tri-Color Mark and Sweep Algorithm                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Colors:                                                                     │
│  • WHITE: Object not yet visited (potentially garbage)                       │
│  • GREY:  Object visited, but children not yet scanned                       │
│  • BLACK: Object visited, all children scanned (definitely reachable)        │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  Step 1: Initial State                                                       │
│  All objects are WHITE                                                       │
│                                                                              │
│       Root                                                                   │
│         │                                                                    │
│         ▼                                                                    │
│      ┌─────┐     ┌─────┐     ┌─────┐                                        │
│      │WHITE│────►│WHITE│────►│WHITE│                                        │
│      │  A  │     │  B  │     │  C  │                                        │
│      └─────┘     └─────┘     └─────┘                                        │
│                                                                              │
│         ┌─────┐     ┌─────┐                                                 │
│         │WHITE│     │WHITE│    (unreachable - will be collected)            │
│         │  D  │     │  E  │                                                 │
│         └─────┘     └─────┘                                                 │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  Step 2: Mark roots as GREY                                                  │
│                                                                              │
│       Root                                                                   │
│         │                                                                    │
│         ▼                                                                    │
│      ┌─────┐     ┌─────┐     ┌─────┐                                        │
│      │GREY │────►│WHITE│────►│WHITE│                                        │
│      │  A  │     │  B  │     │  C  │                                        │
│      └─────┘     └─────┘     └─────┘                                        │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  Step 3: Process GREY objects (mark children GREY, self BLACK)               │
│                                                                              │
│       Root                                                                   │
│         │                                                                    │
│         ▼                                                                    │
│      ┌─────┐     ┌─────┐     ┌─────┐                                        │
│      │BLACK│────►│GREY │────►│WHITE│                                        │
│      │  A  │     │  B  │     │  C  │                                        │
│      └─────┘     └─────┘     └─────┘                                        │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  Step 4: Continue until no GREY objects remain                               │
│                                                                              │
│       Root                                                                   │
│         │                                                                    │
│         ▼                                                                    │
│      ┌─────┐     ┌─────┐     ┌─────┐                                        │
│      │BLACK│────►│BLACK│────►│BLACK│                                        │
│      │  A  │     │  B  │     │  C  │                                        │
│      └─────┘     └─────┘     └─────┘                                        │
│                                                                              │
│         ┌─────┐     ┌─────┐                                                 │
│         │WHITE│     │WHITE│    ← Still WHITE = GARBAGE                      │
│         │  D  │     │  E  │                                                 │
│         └─────┘     └─────┘                                                 │
│                                                                              │
│  Step 5: Sweep - reclaim WHITE objects                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### GC Phases in Detail

The Go GC operates in three phases: mark setup (brief STW to enable write barriers), concurrent marking (runs alongside the application), and mark termination (brief STW to finalize). Understanding each phase helps interpret GC traces.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GC Phases Timeline                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐ ┌─────────────────────────────────┐ ┌───────────────────┐ │
│  │    STW #1    │ │        Concurrent Mark          │ │      STW #2       │ │
│  │  (very short)│ │    (runs with application)     │ │   (very short)    │ │
│  └──────────────┘ └─────────────────────────────────┘ └───────────────────┘ │
│        │                        │                              │             │
│        │                        │                              │             │
│        ▼                        ▼                              ▼             │
│  ┌──────────┐           ┌──────────────┐              ┌──────────────┐      │
│  │ Mark     │           │ Mark         │              │ Mark         │      │
│  │ Setup    │           │ (concurrent) │              │ Termination  │      │
│  │          │           │              │              │              │      │
│  │ - Enable │           │ - Scan stacks│              │ - Finish     │      │
│  │   write  │           │ - Scan heap  │              │   marking    │      │
│  │   barrier│           │ - Mark grey  │              │ - Disable    │      │
│  │ - Scan   │           │   objects    │              │   write      │      │
│  │   root   │           │              │              │   barrier    │      │
│  └──────────┘           └──────────────┘              └──────────────┘      │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        Concurrent Sweep                                  ││
│  │              (runs with application, spans multiple cycles)             ││
│  │                                                                         ││
│  │  - Reclaim WHITE objects                                                ││
│  │  - Return memory to allocator                                           ││
│  │  - Coalesce free spans                                                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Write Barriers

During concurrent marking, your application continues running and may modify pointers (for example, by reassigning a struct field from one object to another). Without protection, this could cause the GC to miss a live object (if a black object gains a reference to a white object). Write barriers prevent this by intercepting pointer writes during the mark phase and shading newly referenced objects grey.

\`\`\`go
// Pseudocode for write barrier
// When: obj.field = newValue

func writePointer(slot *unsafe.Pointer, ptr unsafe.Pointer) {
    // During GC, shade the pointer to maintain invariant
    if gcphase == gcMark {
        // If we're writing a pointer to a white object
        // from a black object, we must mark it grey
        shade(ptr)  // Ensure newValue is at least grey
    }
    *slot = ptr
}
\`\`\`

**Netflix's Experience**: Netflix found that high write rates during GC could cause longer mark phases. They optimized by batching updates and reducing pointer-heavy data structures in hot paths.

### GC Tuning Parameters

The primary GC tuning levers are \`GOGC\` (default 100, triggers GC when heap doubles) and \`GOMEMLIMIT\` (an absolute memory ceiling). Additional \`GODEBUG\` variables expose detailed GC behavior for analysis.

\`\`\`bash
# GOGC: Target heap growth ratio (default: 100 = double heap before GC)
GOGC=100   # Default: GC when heap doubles
GOGC=50    # More aggressive: GC when heap grows 50%
GOGC=200   # Less aggressive: GC when heap triples
GOGC=off   # Disable GC (dangerous!)

# GOMEMLIMIT (Go 1.19+): Soft memory limit
GOMEMLIMIT=1GiB    # Try to stay under 1GB
GOMEMLIMIT=512MiB  # For constrained environments

# Combined: Low GOGC + GOMEMLIMIT for stable memory
GOGC=50 GOMEMLIMIT=1GiB ./myapp
\`\`\`

### GC Tracing and Analysis

The \`GODEBUG=gctrace=1\` variable prints GC statistics after each collection, including pause time and heap size. This output provides a continuous signal of GC behavior in production without instrumentation code.

\`\`\`bash
# Enable GC tracing
GODEBUG=gctrace=1 ./myprogram
\`\`\`

Output format:

\`\`\`
gc 1 @0.012s 2%: 0.021+1.2+0.018 ms clock, 0.085+0.23/1.0/0+0.076 ms cpu, 4->5->1 MB, 5 MB goal, 4 P

gc 1          # GC cycle number
@0.012s       # Time since program start
2%            # Percentage of available CPU used by GC
0.021+1.2+0.018 ms clock   # Wall-clock time: STW1 + concurrent + STW2
0.085+0.23/1.0/0+0.076 ms cpu  # CPU time: STW1 + (assist/background/idle) + STW2
4->5->1 MB    # Heap: before mark → after mark → live
5 MB goal     # Target heap size for next cycle
4 P           # Number of processors used
\`\`\`

### Complete GC Monitoring Application

The following application reads GC statistics from the \`runtime\` package at regular intervals and exposes them as Prometheus metrics, enabling GC behavior monitoring in production dashboards.

\`\`\`go
// gc_monitor.go - Production GC monitoring with alerting
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "runtime"
    "runtime/debug"
    "sync"
    "time"
)

// GCStats holds detailed GC statistics
type GCStats struct {
    Timestamp     time.Time     \`json:"timestamp"\`
    NumGC         uint32        \`json:"num_gc"\`
    PauseTotal    time.Duration \`json:"pause_total_ns"\`
    PauseLast     time.Duration \`json:"pause_last_ns"\`
    PauseAvg      time.Duration \`json:"pause_avg_ns"\`
    PauseMax      time.Duration \`json:"pause_max_ns"\`
    GCCPUFraction float64       \`json:"gc_cpu_fraction"\`
    HeapAlloc     uint64        \`json:"heap_alloc_bytes"\`
    HeapSys       uint64        \`json:"heap_sys_bytes"\`
    HeapInuse     uint64        \`json:"heap_inuse_bytes"\`
    HeapReleased  uint64        \`json:"heap_released_bytes"\`
    HeapObjects   uint64        \`json:"heap_objects"\`
    StackInuse    uint64        \`json:"stack_inuse_bytes"\`
    NumGoroutine  int           \`json:"num_goroutine"\`
    GOGC          int           \`json:"gogc"\`
    GOMEMLIMIT    int64         \`json:"gomemlimit"\`
}

// GCMonitor tracks GC behavior and triggers alerts
type GCMonitor struct {
    mu          sync.RWMutex
    history     []GCStats
    maxHistory  int
    alertChan   chan GCStats
    thresholds  GCThresholds
}

// GCThresholds defines alerting thresholds
type GCThresholds struct {
    MaxPauseMs      float64 // Alert if pause exceeds this
    MaxGCCPUPercent float64 // Alert if GC CPU exceeds this
    MaxHeapBytes    uint64  // Alert if heap exceeds this
}

// NewGCMonitor creates a new GC monitor
func NewGCMonitor(thresholds GCThresholds) *GCMonitor {
    return &GCMonitor{
        history:    make([]GCStats, 0, 1000),
        maxHistory: 1000,
        alertChan:  make(chan GCStats, 100),
        thresholds: thresholds,
    }
}

// Collect gathers current GC statistics
func (m *GCMonitor) Collect() GCStats {
    var memStats runtime.MemStats
    runtime.ReadMemStats(&memStats)

    // Calculate average pause
    var pauseSum time.Duration
    var pauseMax time.Duration
    numPauses := int(memStats.NumGC)
    if numPauses > 256 {
        numPauses = 256 // Only last 256 pauses stored
    }
    for i := 0; i < numPauses; i++ {
        p := time.Duration(memStats.PauseNs[i])
        pauseSum += p
        if p > pauseMax {
            pauseMax = p
        }
    }

    var pauseAvg time.Duration
    if numPauses > 0 {
        pauseAvg = pauseSum / time.Duration(numPauses)
    }

    // Get GOGC setting
    gogc := debug.SetGCPercent(-1)
    debug.SetGCPercent(gogc)

    // Get GOMEMLIMIT (Go 1.19+)
    memlimit := debug.SetMemoryLimit(-1)
    debug.SetMemoryLimit(memlimit)

    stats := GCStats{
        Timestamp:     time.Now(),
        NumGC:         memStats.NumGC,
        PauseTotal:    time.Duration(memStats.PauseTotalNs),
        PauseLast:     time.Duration(memStats.PauseNs[(memStats.NumGC+255)%256]),
        PauseAvg:      pauseAvg,
        PauseMax:      pauseMax,
        GCCPUFraction: memStats.GCCPUFraction,
        HeapAlloc:     memStats.HeapAlloc,
        HeapSys:       memStats.HeapSys,
        HeapInuse:     memStats.HeapInuse,
        HeapReleased:  memStats.HeapReleased,
        HeapObjects:   memStats.HeapObjects,
        StackInuse:    memStats.StackInuse,
        NumGoroutine:  runtime.NumGoroutine(),
        GOGC:          gogc,
        GOMEMLIMIT:    memlimit,
    }

    // Store in history
    m.mu.Lock()
    m.history = append(m.history, stats)
    if len(m.history) > m.maxHistory {
        m.history = m.history[1:]
    }
    m.mu.Unlock()

    // Check thresholds
    m.checkThresholds(stats)

    return stats
}

// checkThresholds alerts if thresholds are exceeded
func (m *GCMonitor) checkThresholds(stats GCStats) {
    pauseMs := float64(stats.PauseLast) / float64(time.Millisecond)
    gcCPUPercent := stats.GCCPUFraction * 100

    shouldAlert := false

    if pauseMs > m.thresholds.MaxPauseMs {
        log.Printf("ALERT: GC pause %.2fms exceeds threshold %.2fms",
            pauseMs, m.thresholds.MaxPauseMs)
        shouldAlert = true
    }

    if gcCPUPercent > m.thresholds.MaxGCCPUPercent {
        log.Printf("ALERT: GC CPU %.2f%% exceeds threshold %.2f%%",
            gcCPUPercent, m.thresholds.MaxGCCPUPercent)
        shouldAlert = true
    }

    if stats.HeapAlloc > m.thresholds.MaxHeapBytes {
        log.Printf("ALERT: Heap %d bytes exceeds threshold %d bytes",
            stats.HeapAlloc, m.thresholds.MaxHeapBytes)
        shouldAlert = true
    }

    if shouldAlert {
        select {
        case m.alertChan <- stats:
        default:
            // Alert channel full, drop
        }
    }
}

// GetHistory returns recent GC history
func (m *GCMonitor) GetHistory() []GCStats {
    m.mu.RLock()
    defer m.mu.RUnlock()
    result := make([]GCStats, len(m.history))
    copy(result, m.history)
    return result
}

// Alerts returns the alert channel
func (m *GCMonitor) Alerts() <-chan GCStats {
    return m.alertChan
}

// Run starts continuous monitoring
func (m *GCMonitor) Run(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.Collect()
        }
    }
}

// HTTPHandler returns an HTTP handler for GC stats
func (m *GCMonitor) HTTPHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")

        stats := m.Collect()

        if err := json.NewEncoder(w).Encode(stats); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
        }
    }
}

// HistoryHandler returns an HTTP handler for GC history
func (m *GCMonitor) HistoryHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")

        history := m.GetHistory()

        if err := json.NewEncoder(w).Encode(history); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
        }
    }
}

// ForceGCHandler triggers a manual GC
func ForceGCHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
            return
        }

        before := time.Now()
        runtime.GC()
        duration := time.Since(before)

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "status":   "ok",
            "duration": duration.String(),
        })
    }
}

// SetGOGCHandler dynamically adjusts GOGC
func SetGOGCHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var req struct {
            GOGC int \`json:"gogc"\`
        }

        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }

        old := debug.SetGCPercent(req.GOGC)

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "old_gogc": old,
            "new_gogc": req.GOGC,
        })
    }
}

func main() {
    // Configure GOGC from environment
    if gogc := os.Getenv("GOGC"); gogc != "" {
        fmt.Printf("GOGC: %s\\n", gogc)
    }

    // Create monitor with thresholds
    monitor := NewGCMonitor(GCThresholds{
        MaxPauseMs:      10.0,           // Alert if pause > 10ms
        MaxGCCPUPercent: 25.0,           // Alert if GC CPU > 25%
        MaxHeapBytes:    1024 * 1024 * 1024, // Alert if heap > 1GB
    })

    // Start background monitoring
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    go monitor.Run(ctx, time.Second)

    // Handle alerts
    go func() {
        for stats := range monitor.Alerts() {
            // In production, send to alerting system (PagerDuty, etc.)
            log.Printf("GC Alert: pause=%v heap=%dMB",
                stats.PauseLast, stats.HeapAlloc/1024/1024)
        }
    }()

    // HTTP endpoints
    http.HandleFunc("/gc/stats", monitor.HTTPHandler())
    http.HandleFunc("/gc/history", monitor.HistoryHandler())
    http.HandleFunc("/gc/force", ForceGCHandler())
    http.HandleFunc("/gc/gogc", SetGOGCHandler())

    // Simulate workload
    go func() {
        for {
            // Allocate and discard memory to trigger GC
            data := make([]byte, 10*1024*1024) // 10MB
            _ = data
            time.Sleep(100 * time.Millisecond)
        }
    }()

    fmt.Println("GC Monitor running on :8080")
    fmt.Println("Endpoints:")
    fmt.Println("  GET  /gc/stats   - Current GC statistics")
    fmt.Println("  GET  /gc/history - GC history")
    fmt.Println("  POST /gc/force   - Force GC")
    fmt.Println("  POST /gc/gogc    - Set GOGC value")

    log.Fatal(http.ListenAndServe(":8080", nil))
}
\`\`\`

**GC Tuning Guidelines** (from the Go team's published recommendations):
1. Start with the default \`GOGC=100\`
2. If memory is constrained, set \`GOMEMLIMIT\` to 80-90% of the container limit
3. For latency-sensitive services, consider lowering \`GOGC\` to trade memory for shorter pauses
4. Always profile before tuning. Measure actual GC overhead with \`GODEBUG=gctrace=1\` first

### The Green Tea Collector (Go 1.25 experimental, 1.26 default)

The tri-color algorithm above is unchanged in Green Tea. What changed is the organization of the mark phase. The legacy mark worker loaded one pointer, chased it, marked the target, loaded the next pointer, and so on. On heap-heavy services this was memory-stall bound, cache behavior dominated CPU cost.

Green Tea groups small heap objects (up to 8 per group) and scans them with a single pass that pulls one group into cache, then examines all live slots before moving on. On amd64 and arm64 the scan uses SIMD instructions so multiple slots are processed in parallel. Large objects continue to use the traditional per-object mark. The write barrier, the tri-color invariant, and the concurrent-mark contract are unchanged, so existing reasoning and existing code keep working.

Observable effects in production:
- Steady-state GC CPU typically drops 10 to 40 percent on allocation-heavy workloads.
- Mark-assist p99 drops because the mark phase finishes sooner.
- Nothing changes for user code. Escape analysis, pool usage, and heap-sizing advice in this chapter still apply unchanged.

Green Tea was opt-in under \`GOEXPERIMENT=greenteagc\` in Go 1.25 and is the default from Go 1.26 onward. There is no runtime toggle, the choice is baked in at build time.

Datadog publicly reported saving hundreds of gigabytes of RSS across their Go fleet after upgrading to 1.26 with no code changes (verified 2026-04). If your service has a large steady-state heap of short-lived small objects, expect comparable wins from the upgrade alone.

### Incident Playbook: GC Pressure

For a senior engineer on call, GC-related incidents follow a predictable shape:

1. **Symptom.** Latency spikes at regular intervals. CPU usage climbs with no throughput increase. \`gctrace\` shows frequent cycles with high mark-assist CPU.
2. **Diagnosis.** Enable \`GODEBUG=gctrace=1\`. Read the output: look at pause time (should be sub-millisecond), mark time (should be bounded), and heap growth between cycles.
3. **First fix.** If \`GOMEMLIMIT\` is set and the service is near the limit, the GC is running more aggressively to stay under. Either raise the limit or reduce the heap.
4. **Second fix.** If the heap is bounded but allocation rate is high, reduce allocations. pprof allocation profile identifies the hot sites.
5. **Third fix.** If all else fails, increase \`GOGC\` (less-frequent collections, larger steady-state heap). Validates with another \`gctrace\` run.

The discipline: "measure, fix the identified site, measure again". Do not reach for \`GOGC\` or \`GOMEMLIMIT\` tuning without evidence that the current setting is wrong.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **Manual \`runtime.GC()\` calls in production code.** Always wrong. Disrupts the pacer.
2. **\`GOGC=off\` in any service.** Always wrong. Use \`GOMEMLIMIT\` for soft bounds.
3. **Allocation in a million-operations-per-second loop.** Flag for profiling review. The fix is usually structural, not tuning.

---
`;
