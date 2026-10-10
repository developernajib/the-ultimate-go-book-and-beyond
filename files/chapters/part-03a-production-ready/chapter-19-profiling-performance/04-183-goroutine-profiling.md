## 19.3 Goroutine Profiling

### Goroutine Profile

The goroutine profile endpoint exposes a snapshot of every goroutine currently alive in the process along with its full stack trace. Fetching it through `pprof` lets you interactively inspect which call sites are responsible for the most goroutines and identify stacks that have been blocked for an unexpectedly long time.

```bash
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

Unlike the heap profile, the goroutine profile is a complete snapshot rather than a sample. Every live goroutine is counted, so "4,182 goroutines are parked in `readLoop`" is an exact figure, not an estimate. The cost of that exactness is that the runtime must briefly stop the world to collect it, and a process with hundreds of thousands of goroutines will feel that pause. This is also why the count is a snapshot rather than a history: it tells you the state right now, and says nothing about how you got there.

### Finding Goroutine Leaks

A goroutine leak occurs when goroutines are started but never given a path to exit, causing the count to climb monotonically until memory is exhausted. Periodically sampling `runtime.NumGoroutine()` and logging the result provides a simple early-warning signal, a steadily growing count after load stabilises is a reliable indicator of a leak that warrants further investigation with a full stack dump.

```go
import (
    "context"
    "log"
    "runtime"
    "time"
)

func monitorGoroutines(ctx context.Context) {
    tick := time.NewTicker(10 * time.Second)
    defer tick.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-tick.C:
            log.Printf("Goroutines: %d", runtime.NumGoroutine())
        }
    }
}
```

```bash
# Full goroutine stack dump
curl http://localhost:6060/debug/pprof/goroutine?debug=2
```

### Goroutine Count as a Metric

Every production Go service should expose `runtime.NumGoroutine()` as a Prometheus gauge. Alert on monotonic growth. This single metric catches most goroutine leaks before they become outages.

### The Leak-Specific Profile

The full goroutine profile tells you what every goroutine is doing. It does not tell you which ones are *stuck forever*, and on a busy service the leaked goroutines are buried among thousands of perfectly healthy ones.

The `goroutineleak` profile solves exactly this. It shipped as a `GOEXPERIMENT` in Go 1.26 and is generally available in Go 1.27. It surfaces only genuinely leaked goroutines, using a reachability analysis: a goroutine is reported as leaked when it is blocked on a synchronization primitive that no running goroutine can still reach, which means nothing can ever unblock it. That is a much stronger signal than "this goroutine has been blocked a long time", because a long block is often legitimate (a worker waiting on an idle queue is blocked but perfectly healthy). Unreachable is not ambiguous. Nobody is coming.

This is far cleaner than filtering a full dump by hand. Enable it on canary instances to catch leaks before a full rollout.

---
