export default `## 11.9 Runtime Control

### GOMAXPROCS

\`GOMAXPROCS\` sets the maximum number of OS threads that can execute user-level Go code at the same time. On Go 1.25 and later, the default is container-aware: in a Kubernetes pod or systemd cgroup with a CPU quota, the runtime derives \`GOMAXPROCS\` from the quota rather than from \`runtime.NumCPU()\`. Before 1.25 the default was always \`NumCPU()\`, which often gave a containerized service many more Ps than the scheduler could actually run, producing unnecessary lock contention and cache thrash. Passing 0 to \`runtime.GOMAXPROCS\` queries the current value without changing it. The \`GOMAXPROCS\` environment variable still overrides the default if set.

\`\`\`go
import "runtime"

func main() {
    // Query current value
    current := runtime.GOMAXPROCS(0)
    fmt.Printf("Current GOMAXPROCS: %d\\n", current)

    // Set to specific value
    old := runtime.GOMAXPROCS(4)
    fmt.Printf("Old value: %d, new value: 4\\n", old)

    // Set to number of CPUs (default behavior)
    runtime.GOMAXPROCS(runtime.NumCPU())
}

// Can also be set via environment variable:
// GOMAXPROCS=4 go run main.go
\`\`\`

**When to Adjust GOMAXPROCS:**

| Scenario | Recommendation |
|----------|----------------|
| CPU-bound work | Default (container-aware on Go 1.25+) |
| I/O-bound work | Default is almost always right |
| Memory-constrained | Lower than default if P-per-goroutine overhead dominates |
| Container with CPU limits | No action needed on Go 1.25+. On older Go, set explicitly or use \`uber-go/automaxprocs\` |
| Reproducing a race | Use \`go test -race\` or \`go build -race\`. GOMAXPROCS=1 can hide races, not expose them |

### Scheduler Interaction

Go's runtime scheduler is cooperative at safe points, goroutines yield automatically at function calls, channel operations, and system calls, but a tight compute loop with no such points can monopolize an OS thread and starve other goroutines on the same processor. \`runtime.Gosched()\` is an explicit yield that parks the calling goroutine and allows the scheduler to run other runnable goroutines before resuming. Inserting periodic yields in long-running CPU loops is a low-cost way to improve fairness without restructuring the loop into smaller goroutines.

\`\`\`go
// Yield to other goroutines
runtime.Gosched()

// Example: cooperative scheduling
func busyLoop() {
    for i := 0; i < 1000000; i++ {
        if i%1000 == 0 {
            runtime.Gosched()  // Let others run
        }
        doWork()
    }
}
\`\`\`

### Runtime Metrics

The \`runtime\` package exposes a snapshot of key health indicators that are invaluable for diagnosing concurrency problems and memory pressure in a live program. \`runtime.NumGoroutine()\` lets you detect goroutine leaks, a steadily climbing count is a strong signal that goroutines are not being cleaned up. \`runtime.ReadMemStats\` populates a \`MemStats\` struct with detailed allocator data including current heap usage, total bytes allocated since startup, and the number of garbage collection cycles, giving you the raw numbers needed to understand GC pressure and memory growth.

\`\`\`go
func printRuntimeStats() {
    fmt.Printf("NumCPU: %d\\n", runtime.NumCPU())
    fmt.Printf("NumGoroutine: %d\\n", runtime.NumGoroutine())
    fmt.Printf("GOMAXPROCS: %d\\n", runtime.GOMAXPROCS(0))

    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    fmt.Printf("Alloc: %d MB\\n", m.Alloc/1024/1024)
    fmt.Printf("TotalAlloc: %d MB\\n", m.TotalAlloc/1024/1024)
    fmt.Printf("Sys: %d MB\\n", m.Sys/1024/1024)
    fmt.Printf("NumGC: %d\\n", m.NumGC)
}
\`\`\`

### GOMEMLIMIT and the Soft Memory Limit (Go 1.19+)

Go 1.19 introduced \`GOMEMLIMIT\`, a soft memory limit that the GC tries to respect. In containerised environments with a memory quota, setting \`GOMEMLIMIT\` to 90% of the container limit gives the runtime a target to stay below, triggering more aggressive GC as memory pressure approaches the limit. Without it, a Go service can OOM-kill itself by exceeding its container's memory limit before the GC runs, even though enough garbage exists to collect.

\`\`\`bash
GOMEMLIMIT=900MiB GOMAXPROCS=2 ./server
\`\`\`

In 2026, most production Go deployments set both \`GOMAXPROCS\` (container-aware by default in Go 1.25+) and \`GOMEMLIMIT\` (not yet container-aware as of Go 1.26). Tooling like \`uber-go/automaxprocs\` automates \`GOMAXPROCS\`; similar tools exist for \`GOMEMLIMIT\`. This is a principal-level configuration decision, not an application-code decision.

### runtime/metrics vs runtime.MemStats

\`runtime/metrics\` (Go 1.16+) is the modern structured API for runtime telemetry. \`runtime.MemStats\` is a snapshot with a mutex-protected read. For production metrics, prefer \`runtime/metrics.Read\`. It provides more metrics, lower overhead, and a stable interface that evolves with the runtime. Example metrics worth emitting: \`/sched/goroutines:goroutines\`, \`/memory/classes/heap/objects:bytes\`, \`/gc/pauses:seconds\` (histogram). Wiring these into your metrics pipeline gives the on-call engineer the data they need to diagnose runtime issues in production.

### The GOGC Tradeoff

\`GOGC\` controls the GC trigger, expressed as a percentage of live heap after the last GC. Default is 100 (GC runs when heap doubles). Lowering \`GOGC\` triggers GC more aggressively, reducing peak memory at the cost of more CPU spent in GC. Raising it trades memory for CPU. For a memory-constrained service, \`GOGC=50\` can reduce peak memory by 20-30% at a measurable CPU cost. For a CPU-constrained service with plenty of memory, \`GOGC=200\` can reduce GC overhead. Most services are fine at the default. Tuning \`GOGC\` is a last-resort optimisation after the obvious wins (allocation reduction, pool usage) are exhausted.

### Staff Lens: Runtime Tuning Is Almost Always Wrong

Most Go performance problems are not GC or scheduler problems. They are allocation problems, lock contention, or blocking I/O. Teams that reach for \`GOGC\` and \`GOMAXPROCS\` tuning without profiling first usually tune in the wrong direction. The staff-level rule: profile first (\`go tool pprof\`, \`go tool trace\`), identify the bottleneck, then decide whether tuning is the right fix. Ninety percent of the time the fix is in the code, not in the runtime knobs.

### Principal Lens: Runtime Defaults Are Well-Tuned

The Go team invests significant effort in runtime defaults that work for most workloads. A principal engineer should view the need to override a runtime default with skepticism. The right question: why does this workload not fit the default? If the answer is "because I read a blog post", revert. If the answer is "because profile evidence shows X", tune with a specific target and a measurement plan. Most production Go services run on defaults, and most production Go services perform well. Aggressive runtime tuning is a sign either of a genuinely unusual workload or of a team that is guessing.

---
`;
