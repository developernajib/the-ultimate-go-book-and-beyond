## 19.8 Runtime Statistics

### Memory Stats

`runtime.ReadMemStats` populates a `MemStats` struct with a detailed breakdown of the heap: current live allocations (`Alloc`), the cumulative total ever allocated (`TotalAlloc`), memory obtained from the OS (`Sys`), and the number of completed GC cycles (`NumGC`). Its numbers are up to date as of the moment of the call, unlike a heap profile, which reflects the most recently completed GC cycle.

That freshness has a price that the function signature does not advertise: **`ReadMemStats` stops the world.** It halts every goroutine, reads the stats, and restarts them. The pause is short but it scales with the size of your heap, so calling it on a tight interval on a large-heap service means paying a latency tax over and over for a number nobody is reading between scrapes. Poll it on the order of seconds, never per request, and prefer `runtime/metrics` for anything you scrape continuously.

```go
var m runtime.MemStats
runtime.ReadMemStats(&m)

fmt.Printf("Alloc = %v MiB\n", m.Alloc/1024/1024)
fmt.Printf("TotalAlloc = %v MiB\n", m.TotalAlloc/1024/1024)
fmt.Printf("Sys = %v MiB\n", m.Sys/1024/1024)
fmt.Printf("NumGC = %v\n", m.NumGC)
fmt.Printf("HeapObjects = %v\n", m.HeapObjects)
```

### GC Stats

`debug.ReadGCStats` complements `MemStats` by focusing exclusively on garbage collection timing rather than allocation volumes. The `PauseTotal` field reveals the cumulative wall-clock time the application has spent paused for GC across its entire lifetime, making it easy to quantify the impact of GC on tail latency and to compare the effect of tuning `GOGC` or `GOMEMLIMIT`.

```go
var stats debug.GCStats
debug.ReadGCStats(&stats)

fmt.Printf("Last GC: %v\n", stats.LastGC)
fmt.Printf("Num GC: %d\n", stats.NumGC)
fmt.Printf("Pause Total: %v\n", stats.PauseTotal)
```

### GODEBUG Flags

`GODEBUG` environment variables inject diagnostic output directly into the runtime without recompiling the binary, making them invaluable in production incidents. `gctrace=1` prints a one-line summary after each GC cycle including pause duration and heap size, while `schedtrace` logs the scheduler's run-queue depths and goroutine counts at the specified millisecond interval to diagnose starvation or excessive context-switching.

```bash
# GC trace
GODEBUG=gctrace=1 ./myapp

# Scheduler trace
GODEBUG=schedtrace=1000,scheddetail=1 ./myapp
```

### Prefer runtime/metrics Over MemStats

`runtime/metrics` (Go 1.16+) is the modern API for runtime telemetry. It is richer, it evolves under a stability policy, and critically it does not stop the world the way `ReadMemStats` does, which is what makes it safe to scrape on an interval. It also exposes things `MemStats` simply cannot express, such as a real GC pause *histogram* rather than a single cumulative total, so you can see your P99 pause instead of an average that hides it. For production metrics, use it instead of `runtime.ReadMemStats`. Metrics worth exposing from every service (all verified present in Go 1.27.1):

- `/sched/goroutines:goroutines`
- `/memory/classes/heap/objects:bytes`
- `/gc/pauses:seconds` (histogram)
- `/gc/cycles/total:gc-cycles`

### Staff Lens: Runtime Metrics in Every Service

Every production Go service should expose these metrics. Without them, runtime problems are invisible until they cause incidents. With them, trend analysis catches issues before they become outages. This is infrastructure-level investment.

---
