## 24.4 Goroutine Dumps

### HTTP Handler for Goroutine Dump

Exposing a goroutine dump as an HTTP endpoint lets operators capture a full stack trace snapshot of every running goroutine without restarting the service. `pprof.Lookup("goroutine").WriteTo` with verbosity level 2 writes complete stack traces, while the manual `runtime.Stack` approach doubles the buffer until all goroutines fit, necessary because you cannot know the required size in advance. Note that the standard library's own version of this loop gives up and truncates at 64MB, which is a sensible ceiling to copy rather than doubling forever on a service with a million goroutines.

There is also a zero-code path to the same data: with the process running under `GOTRACEBACK=all` or higher, `kill -QUIT <pid>` dumps every goroutine's stack to stderr. It costs nothing until you use it, needs no endpoint, and cannot be reached by an attacker over the network. The trade is that `SIGQUIT` also kills the process, so it is a last-resort capture rather than an inspection tool.

```go
import (
    "net/http"
    "runtime"
    "runtime/pprof"
)

func goroutineDumpHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/plain")

    // Get all goroutines
    profile := pprof.Lookup("goroutine")
    profile.WriteTo(w, 2) // 2 = full stack trace
}

// Or manual approach
func dumpGoroutines() string {
    buf := make([]byte, 1024*1024)
    for {
        n := runtime.Stack(buf, true) // true = all goroutines
        if n < len(buf) {
            return string(buf[:n])
        }
        buf = make([]byte, len(buf)*2)
    }
}
```

### Analyzing Goroutine State

Raw goroutine dumps are large text blobs that are difficult to scan manually. A parser that extracts goroutine ID, state, and top-of-stack location into structured records enables programmatic analysis: you can count goroutines in each state, identify the most common blocking locations, or compare snapshots from different points in time to detect accumulation patterns.

```go
package debug

import (
    "bufio"
    "fmt"
    "regexp"
    "strings"
)

type GoroutineInfo struct {
    ID       int
    State    string
    Location string
    Stack    []string
}

func ParseGoroutineDump(dump string) []GoroutineInfo {
    var goroutines []GoroutineInfo
    var current *GoroutineInfo

    scanner := bufio.NewScanner(strings.NewReader(dump))
    goroutineHeader := regexp.MustCompile(`goroutine (\d+) \[([^\]]+)\]:`)

    for scanner.Scan() {
        line := scanner.Text()

        if matches := goroutineHeader.FindStringSubmatch(line); matches != nil {
            if current != nil {
                goroutines = append(goroutines, *current)
            }
            id := 0
            fmt.Sscanf(matches[1], "%d", &id)
            current = &GoroutineInfo{
                ID:    id,
                State: matches[2],
                Stack: make([]string, 0),
            }
        } else if current != nil && line != "" {
            current.Stack = append(current.Stack, line)
            if current.Location == "" && strings.Contains(line, ".go:") {
                current.Location = line
            }
        }
    }

    if current != nil {
        goroutines = append(goroutines, *current)
    }

    return goroutines
}

func SummarizeGoroutines(goroutines []GoroutineInfo) map[string]int {
    summary := make(map[string]int)
    for _, g := range goroutines {
        summary[g.State]++
    }
    return summary
}
```

### Detecting Goroutine Leaks

A goroutine leak occurs when goroutines are launched but never terminate, typically because they are blocked on a channel or network call with no cancellation path. A `GoroutineMonitor` polls `runtime.NumGoroutine()` at a regular interval and compares the current count against a baseline taken at startup. A steadily growing count or a count that spikes above a configured threshold triggers a warning and captures a full dump for post-incident analysis.

```go
package debug

import (
    "log/slog"
    "runtime"
    "time"
)

type GoroutineMonitor struct {
    logger    *slog.Logger
    baseline  int
    threshold int
    interval  time.Duration
}

func NewGoroutineMonitor(logger *slog.Logger, threshold int) *GoroutineMonitor {
    return &GoroutineMonitor{
        logger:    logger,
        baseline:  runtime.NumGoroutine(),
        threshold: threshold,
        interval:  30 * time.Second,
    }
}

func (m *GoroutineMonitor) Start(stopCh <-chan struct{}) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()

    var lastCount int

    for {
        select {
        case <-stopCh:
            return
        case <-ticker.C:
            count := runtime.NumGoroutine()

            // Log if growing
            if count > lastCount+10 {
                m.logger.Warn("goroutine count increasing",
                    "current", count,
                    "previous", lastCount,
                    "baseline", m.baseline,
                )
            }

            // Alert if threshold exceeded
            if count > m.baseline+m.threshold {
                m.logger.Error("possible goroutine leak",
                    "current", count,
                    "baseline", m.baseline,
                    "threshold", m.threshold,
                )
                // Dump goroutines for analysis
                m.dumpGoroutines()
            }

            lastCount = count
        }
    }
}

func (m *GoroutineMonitor) dumpGoroutines() {
    buf := make([]byte, 1024*1024)
    n := runtime.Stack(buf, true)
    m.logger.Info("goroutine dump", "stack", string(buf[:n]))
}
```

> **Senior track**: A steadily rising goroutine count is not the only leak signature. You can also leak goroutines in pairs that cancel each other's delta (producer blocks, consumer blocks, both accumulate at the same rate). Sample the goroutine profile at verbosity 1 and group by top-of-stack: if any single stack frame's count grows monotonically across hours, that is your leak regardless of what `runtime.NumGoroutine()` says. The `/debug/pprof/goroutineleak` profile (see 24.5), which was gated behind a `GOEXPERIMENT` in 1.26 and is on by default as of 1.27, short-circuits this analysis when it applies: it reports goroutines the runtime has proven unreachable rather than making you infer a leak from a trend line.

### Runtime Pause Cost

The two verbosity levels have very different costs, and the difference is structural rather than a matter of degree. Verbosity 2 routes to `runtime.Stack(buf, true)`, which stops the world for the entire duration of the walk, so the pause scales with your goroutine count and is plainly visible in P99 latency on a service with tens of thousands of them. Verbosity 1 takes a brief stop-the-world to snapshot the goroutine set and then walks the stacks concurrently, so the pause is far shorter and roughly fixed.

Prefer verbosity 1 (single counters per unique stack) for anything periodic, and reserve verbosity 2 for on-demand captures during an incident, when a latency blip is a price worth paying for the exact stacks. Measure before wiring either into a hot alerting path.

### Staff Lens: Goroutine Dumps Are Gold

Most production concurrency bugs can be diagnosed from a goroutine dump. Make capture trivial: one command for on-call, auto-capture on leak alerts, stored in incident ticket. Teams with this infrastructure resolve concurrency incidents in hours. Without it, days.

---
