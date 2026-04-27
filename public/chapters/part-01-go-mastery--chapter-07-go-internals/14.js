export default `## Runtime Pitfalls and Production Debugging Wisdom

The runtime knowledge from earlier sections pays off most when debugging production issues that are invisible at the application level. This section covers specific pitfalls that catch experienced engineers and the diagnostic techniques to resolve them.

### GOMAXPROCS Misconfiguration

> **Go 1.25+ update (Aug 2025)**: \`GOMAXPROCS\` is now container-aware by default. The runtime reads the cgroup CPU quota and sizes \`GOMAXPROCS\` to match, so the historical mismatch described below is automatically fixed on 1.25 and later. The section still applies to services running on Go 1.24 or earlier and explains why the \`automaxprocs\` workaround exists.

In containerized environments running Go 1.24 or earlier, \`GOMAXPROCS\` defaulted to the host machine's CPU count rather than the container's CPU limit. A Go process in a container limited to 2 CPU cores on a 64-core host would create 64 Ps, causing excessive context switching and poor cache locality.

\`\`\`go
// PROBLEM: Container CPU limits not respected
// Go reads host CPU count, not container limits!

// In a Kubernetes pod with 2 CPU cores limit:
fmt.Println(runtime.NumCPU())        // Might print 64 (host CPUs)
fmt.Println(runtime.GOMAXPROCS(0))   // Might print 64

// This causes:
// 1. Too many threads competing for limited CPU
// 2. Excessive context switching
// 3. Poor cache locality
// 4. Scheduling delays

// SOLUTION 1: Use automaxprocs (Uber's solution)
import _ "go.uber.org/automaxprocs"

// Automatically reads cgroup limits and sets GOMAXPROCS correctly
// func init() {} in the package does the work

// SOLUTION 2: Manual setting from environment
func init() {
    if val := os.Getenv("GOMAXPROCS"); val == "" {
        // Default to reasonable value in containers
        // Read from cgroup if possible
        if limit := readCgroupCPULimit(); limit > 0 {
            runtime.GOMAXPROCS(int(limit))
        }
    }
}

// Reading cgroup v2 CPU limit
func readCgroupCPULimit() float64 {
    data, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
    if err != nil {
        return 0
    }

    parts := strings.Fields(string(data))
    if len(parts) != 2 || parts[0] == "max" {
        return 0
    }

    quota, _ := strconv.ParseFloat(parts[0], 64)
    period, _ := strconv.ParseFloat(parts[1], 64)

    if period == 0 {
        return 0
    }

    return quota / period
}

// BENCHMARK: Impact of GOMAXPROCS
// With correct setting (2 cores): 50,000 req/sec, P99 latency 5ms
// With incorrect setting (64 procs): 35,000 req/sec, P99 latency 50ms
\`\`\`

### Memory Limit Surprises (GOMEMLIMIT)

\`GOMEMLIMIT\` (Go 1.19+) sets a soft memory target for the GC, not a hard allocation limit. The runtime cannot prevent your program from exceeding this limit. It can only trigger GC earlier to try to stay under it. Several gotchas follow from this distinction.

\`\`\`go
// GOTCHA #1: GOMEMLIMIT doesn't prevent OOM
// It's a soft target for GC, not a hard limit

// If you allocate faster than GC can collect:
func allocateForeverBad() {
    var ptrs []*[1024 * 1024]byte  // Never released
    for {
        ptrs = append(ptrs, new([1024 * 1024]byte))  // OOM eventually
    }
}

// GOMEMLIMIT only affects GC triggering, not max allocation

// GOTCHA #2: GOMEMLIMIT includes all memory
// Not just heap - also stack, runtime metadata, etc.

// CORRECT: Set GOMEMLIMIT to ~80-90% of container limit
// Container has 1GB limit:
// GOMEMLIMIT=900MiB  (leave room for non-Go allocations)

// GOTCHA #3: Setting GOMEMLIMIT too low causes GC thrashing
func gcThrashingDemo() {
    // With GOMEMLIMIT=100MiB and 150MiB live data:
    // GC runs constantly, application makes no progress

    debug.SetMemoryLimit(100 * 1024 * 1024)  // Too low!

    // Monitor with:
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    fmt.Printf("GC cycles: %d, Pause total: %v\\n",
        stats.NumGC, time.Duration(stats.PauseTotalNs))
}

// PRODUCTION PATTERN: Dynamic memory limit based on container
func setupMemoryLimit() {
    // Read container memory limit
    data, err := os.ReadFile("/sys/fs/cgroup/memory.max")
    if err != nil {
        return
    }

    limit, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
    if err != nil || limit <= 0 {
        return
    }

    // Set GOMEMLIMIT to 85% of container limit
    goLimit := int64(float64(limit) * 0.85)
    debug.SetMemoryLimit(goLimit)

    log.Printf("Set GOMEMLIMIT to %d bytes (container limit: %d)",
        goLimit, limit)
}
\`\`\`

### GC Tuning Antipatterns

GC tuning requires understanding the tradeoff between collection frequency, pause time, and memory usage. Each of the following antipatterns comes from pushing one knob too far without considering the others.

\`\`\`go
// ANTIPATTERN #1: Setting GOGC=off in production
// This disables automatic GC, causing unbounded memory growth
// GOGC=off  // DON'T DO THIS unless you have a very good reason

// ANTIPATTERN #2: GOGC too low causes thrashing
// GOGC=10  // GC triggers at 10% heap growth
// Results in constant GC cycles, high CPU usage

// ANTIPATTERN #3: GOGC too high causes memory spikes
// GOGC=1000  // GC triggers at 1000% heap growth
// Results in infrequent but long GC pauses, memory spikes

// CORRECT: Use GOGC based on workload characteristics
// Latency-sensitive (web servers): GOGC=50-100 (default 100)
// Throughput-focused (batch jobs): GOGC=200-400
// Memory-constrained: GOGC=50 + GOMEMLIMIT

// PRODUCTION PATTERN: Dynamic GOGC adjustment
type GCTuner struct {
    targetUtilization float64  // Target CPU% for GC
    adjustmentWindow  time.Duration
}

func (t *GCTuner) Start(ctx context.Context) {
    ticker := time.NewTicker(t.adjustmentWindow)
    defer ticker.Stop()

    var lastStats runtime.MemStats
    runtime.ReadMemStats(&lastStats)
    lastTime := time.Now()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            var stats runtime.MemStats
            runtime.ReadMemStats(&stats)
            now := time.Now()

            // Calculate GC CPU utilization
            gcTime := time.Duration(stats.PauseTotalNs - lastStats.PauseTotalNs)
            wallTime := now.Sub(lastTime)
            gcUtil := float64(gcTime) / float64(wallTime)

            // Adjust GOGC
            currentGOGC := debug.SetGCPercent(-1)  // Read current
            debug.SetGCPercent(currentGOGC)        // Restore

            if gcUtil > t.targetUtilization {
                // GC using too much CPU, increase GOGC
                newGOGC := min(currentGOGC+10, 500)
                debug.SetGCPercent(newGOGC)
            } else if gcUtil < t.targetUtilization/2 {
                // GC underutilized, decrease GOGC
                newGOGC := max(currentGOGC-10, 20)
                debug.SetGCPercent(newGOGC)
            }

            lastStats = stats
            lastTime = now
        }
    }
}
\`\`\`

### Scheduler Starvation and Debugging

A goroutine running a tight computational loop with no function calls (and therefore no stack-check preemption points) can starve other goroutines on the same P. Go 1.14 added asynchronous preemption via signals, but it is not instantaneous. There can be a delay of 10-20ms before the signal is delivered. For time-critical fairness, explicit yields remain useful.

\`\`\`go
// PROBLEM: Long-running computation starves other goroutines
func cpuHogBad() {
    go func() {
        // This goroutine never yields, starves others
        for {
            computeIntensive()  // No function calls = no preemption points
        }
    }()
}

// Go 1.14+ has asynchronous preemption, but it's not instant
// Preemption happens at safe points or async signal

// PATTERN: Cooperative yielding for fairness
func cpuHogGood(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            computeChunk()  // Process a chunk
            runtime.Gosched()  // Explicitly yield
        }
    }()
}

// DEBUGGING: Find scheduler issues with execution trace
// GODEBUG=schedtrace=1000 ./myapp  # Print scheduler stats every 1000ms

// Output interpretation:
// SCHED 1004ms: gomaxprocs=8 idleprocs=2 threads=10 spinningthreads=1
//               idlethreads=3 runqueue=0 [0 0 0 3 0 0 0 0]
//
// idleprocs: High = underutilized, Low = might need more P's
// spinningthreads: Threads looking for work (expected: 0-1)
// runqueue: Global run queue length (should be low)
// [0 0 0 3 0 0 0 0]: Per-P local run queue lengths

// DEBUGGING: Detailed scheduler trace
// GODEBUG=scheddetail=1,schedtrace=100 ./myapp

// PATTERN: Detect goroutine count anomalies
func monitorGoroutines(ctx context.Context, threshold int) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    baseline := runtime.NumGoroutine()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            current := runtime.NumGoroutine()
            if current > baseline*threshold {
                // Potential goroutine leak
                log.Printf("WARNING: goroutine count %d (baseline %d)",
                    current, baseline)

                // Dump goroutine stacks
                buf := make([]byte, 1<<20)
                n := runtime.Stack(buf, true)
                log.Printf("Goroutine stacks:\\n%s", buf[:n])
            }
        }
    }
}
\`\`\`

### Memory Profiling Pitfalls

Go's memory profiler is powerful but can be misleading without context on what it does and does not measure. The following pitfalls trip up engineers who rely on profile output at face value.

\`\`\`go
// PITFALL #1: Heap profile shows allocation site, not cause
// If function A calls function B which allocates, profile shows B
// But A might be the real problem (calling B too often)

// Use -memprofilerate for more accuracy:
// go test -bench=. -memprofile=mem.prof -memprofilerate=1

// PITFALL #2: Heap profile doesn't show current allocations
// It shows allocations over time (inuse_objects vs alloc_objects)

// pprof: Focus on "inuse" for memory leaks
// go tool pprof -inuse_space mem.prof
// go tool pprof -alloc_space mem.prof  // Shows all allocations

// PITFALL #3: Stack memory isn't in heap profile
// Large local variables on stack won't show up

// PRODUCTION PATTERN: Full memory diagnostics
func debugMemory() {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    fmt.Printf("Alloc: %d MB\\n", m.Alloc/1024/1024)
    fmt.Printf("TotalAlloc: %d MB\\n", m.TotalAlloc/1024/1024)
    fmt.Printf("Sys: %d MB\\n", m.Sys/1024/1024)
    fmt.Printf("NumGC: %d\\n", m.NumGC)
    fmt.Printf("HeapObjects: %d\\n", m.HeapObjects)
    fmt.Printf("StackInuse: %d MB\\n", m.StackInuse/1024/1024)
    fmt.Printf("StackSys: %d MB\\n", m.StackSys/1024/1024)

    // Key insight: Sys - Alloc = memory held but not used
    // High value indicates memory fragmentation
    fmt.Printf("Held but unused: %d MB\\n",
        (m.Sys-m.Alloc)/1024/1024)
}

// PATTERN: Detect memory fragmentation
func checkFragmentation() {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    // HeapInuse is memory in use by application
    // HeapSys is memory obtained from OS
    // Ratio indicates fragmentation
    ratio := float64(m.HeapSys) / float64(m.HeapInuse)

    if ratio > 2.0 {
        log.Printf("High memory fragmentation: %.2fx", ratio)
        // Consider: restart, reduce allocation churn, use sync.Pool
    }
}
\`\`\`

### Channel Internals and Debugging

Channel-related bugs (deadlocks, goroutine leaks from unread channels, and unexpected blocking) are among the hardest to diagnose from application logs alone. The runtime and tooling provide several ways to inspect channel state at debug time.

\`\`\`go
// DEBUGGING: Why is my channel blocked?

// 1. Check if channel is closed
func isChannelClosed(ch any) bool {
    // Use reflect to check if channel is closed
    // WARNING: This is a hack, not recommended for production
    rv := reflect.ValueOf(ch)
    if rv.Kind() != reflect.Chan {
        return false
    }

    // Try to receive with select
    // This is the safest way
    return false  // No reliable way without receiving
}

// 2. Check channel buffer status at runtime (debug only)
// Use delve debugger:
// dlv attach <pid>
// (dlv) p *(*runtime.hchan)(unsafe.Pointer(&ch))

// 3. Use runtime/trace to visualize channel operations
// go tool trace trace.out
// Shows "Goroutine blocking profile" with channel waits

// PATTERN: Instrumented channel wrapper
type InstrumentedChan[T any] struct {
    ch       chan T
    name     string
    sends    atomic.Int64
    receives atomic.Int64
    blocks   atomic.Int64
}

func NewInstrumentedChan[T any](size int, name string) *InstrumentedChan[T] {
    return &InstrumentedChan[T]{
        ch:   make(chan T, size),
        name: name,
    }
}

func (c *InstrumentedChan[T]) Send(ctx context.Context, v T) error {
    c.sends.Add(1)

    select {
    case c.ch <- v:
        return nil
    default:
        // Would block
        c.blocks.Add(1)
        select {
        case c.ch <- v:
            return nil
        case <-ctx.Done():
            return ctx.Err()
        }
    }
}

func (c *InstrumentedChan[T]) Stats() map[string]int64 {
    return map[string]int64{
        "sends":    c.sends.Load(),
        "receives": c.receives.Load(),
        "blocks":   c.blocks.Load(),
        "len":      int64(len(c.ch)),
        "cap":      int64(cap(c.ch)),
    }
}
\`\`\`

### Quick Reference: Runtime Debugging Commands

| Issue | Debug Command | What to Look For |
|-------|--------------|------------------|
| High CPU | \`GODEBUG=schedtrace=1000\` | High runqueue, low idleprocs |
| Memory leak | \`go tool pprof -inuse_space\` | Growing heap, specific allocators |
| GC pressure | \`GODEBUG=gctrace=1\` | Frequent GC, high pause times |
| Goroutine leak | \`runtime.NumGoroutine()\` | Steadily increasing count |
| Deadlock | \`GOTRACEBACK=all\` then send SIGQUIT | All goroutine stacks |
| Scheduler issues | \`go tool trace\` | Long periods without scheduling |
| Memory fragmentation | \`runtime.MemStats\` | HeapSys >> HeapInuse |

### Senior-Track Debugging Wisdom

Five rules for runtime-related incident diagnosis:

1. **Read the trace before you guess.** The trace shows what happened. Reasoning without evidence is faster to produce and slower to converge on a fix.
2. **Measure twice, tune once.** \`GOGC\`, \`GOMEMLIMIT\`, and similar knobs are blunt instruments. Confirm the problem is runtime-related before reaching for them.
3. **Fix the structure, not the tuning.** A service with GC pressure usually needs an allocation reduction, not a different \`GOGC\`. A service with scheduler gaps usually needs a different blocking pattern, not more Ps.
4. **Capture before, capture after.** Every runtime change deserves before-and-after measurements. Without them, nobody knows whether the change helped or hurt.
5. **Build the team's institutional memory.** Every incident that required runtime knowledge is a teaching opportunity. Document the symptom, diagnosis path, and fix. The catalog is the artifact that compounds.

The team that internalises these does not have runtime-related incidents that become outages. The team that does not becomes the cautionary tale in the next team's postmortem review.

---
`;
