## 1. Profiling Workflow

Profiling is the foundation of performance optimization. Never optimize without measuring first.

### 1.1 The Performance Optimization Cycle

```
┌─────────────────┐
│  1. Measure     │ ──> Establish baseline metrics
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. Profile     │ ──> Identify bottlenecks
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. Optimize    │ ──> Make targeted changes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. Validate    │ ──> Verify improvement
└────────┬────────┘
         │
         └──────────> Repeat
```

### 1.2 Essential Profiling Commands

**Basic Profiling Setup**:

```bash
# CPU profiling with benchmarks
go test -bench=. -cpuprofile=cpu.prof

# Memory profiling
go test -bench=. -memprofile=mem.prof

# Both CPU and memory
go test -bench=. -cpuprofile=cpu.prof -memprofile=mem.prof

# Include memory allocation stats
go test -bench=. -benchmem

# Run specific benchmark
go test -bench=BenchmarkMyFunction -count=5
```

**Analyzing Profiles**:

```bash
# Interactive mode
go tool pprof cpu.prof

# Web interface (recommended)
go tool pprof -http=:8080 cpu.prof

# Generate call graph
go tool pprof -gif cpu.prof > cpu.gif

# Text output - top functions
go tool pprof -top cpu.prof

# List specific function
go tool pprof -list=myFunction cpu.prof
```

### 1.3 Live Profiling with net/http/pprof

For production services, use the pprof HTTP endpoint:

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof"  // Blank import for side effects
)

func main() {
    // Your application code

    // Expose pprof endpoints
    go func() {
        log.Println("Starting pprof server on :6060")
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // Your main server
    // ...
}
```

**Accessing pprof endpoints**:

```bash
# CPU profile (30 seconds by default)
curl http://localhost:6060/debug/pprof/profile?seconds=30 > cpu.prof

# Heap profile
curl http://localhost:6060/debug/pprof/heap > heap.prof

# Goroutine profile
curl http://localhost:6060/debug/pprof/goroutine > goroutine.prof

# Block profile (shows blocking calls)
curl http://localhost:6060/debug/pprof/block > block.prof

# Mutex profile (contention)
curl http://localhost:6060/debug/pprof/mutex > mutex.prof

# Analyze immediately with web UI
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30
```

### 1.4 Understanding pprof Output

**Reading the Interactive Mode**:

```bash
$ go tool pprof cpu.prof
Type: cpu
Time: Dec 7, 2025
Duration: 30.13s
(pprof) top10
Showing nodes accounting for 25.32s, 84.05% of 30.13s total
Showing top 10 nodes out of 127
      flat  flat%   sum%        cum   cum%
     8.23s 27.32% 27.32%     12.45s 41.33%  runtime.mallocgc
     4.12s 13.68% 41.00%      4.12s 13.68%  runtime.memmove
     2.87s  9.53% 50.53%      2.87s  9.53%  runtime.scanobject
     2.34s  7.77% 58.30%      3.21s 10.66%  encoding/json.(*encodeState).string
     1.98s  6.57% 64.87%      1.98s  6.57%  runtime.nextFreeFast
```

- **flat**: Time spent in the function itself
- **flat%**: Percentage of total time
- **sum%**: Cumulative percentage
- **cum**: Time spent in function + callees
- **cum%**: Cumulative percentage including callees

**Key pprof Commands**:

```
(pprof) top10              # Top 10 functions
(pprof) list myFunc        # Source code with annotations
(pprof) web                # Visual call graph (requires graphviz)
(pprof) peek myFunc        # Show callers and callees
(pprof) traces             # Show sample traces
(pprof) help               # Full command list
```

### 1.5 Continuous Profiling in Production

**Best Practices**:

```go
package profiler

import (
    "context"
    "fmt"
    "os"
    "runtime"
    "runtime/pprof"
    "time"
)

// ContinuousProfiler captures profiles periodically
type ContinuousProfiler struct {
    interval   time.Duration
    outputDir  string
    cpuEnabled bool
    memEnabled bool
}

func NewContinuousProfiler(dir string, interval time.Duration) *ContinuousProfiler {
    return &ContinuousProfiler{
        interval:   interval,
        outputDir:  dir,
        cpuEnabled: true,
        memEnabled: true,
    }
}

func (p *ContinuousProfiler) Start(ctx context.Context) error {
    ticker := time.NewTicker(p.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := p.captureProfiles(); err != nil {
                // Log error but continue
                fmt.Printf("Profile capture error: %v\n", err)
            }
        }
    }
}

func (p *ContinuousProfiler) captureProfiles() error {
    timestamp := time.Now().Format("20060102-150405")

    // CPU profile
    if p.cpuEnabled {
        cpuFile := fmt.Sprintf("%s/cpu-%s.prof", p.outputDir, timestamp)
        f, err := os.Create(cpuFile)
        if err != nil {
            return err
        }

        pprof.StartCPUProfile(f)
        time.Sleep(30 * time.Second) // Profile for 30 seconds
        pprof.StopCPUProfile()
        f.Close()
    }

    // Memory profile
    if p.memEnabled {
        memFile := fmt.Sprintf("%s/mem-%s.prof", p.outputDir, timestamp)
        f, err := os.Create(memFile)
        if err != nil {
            return err
        }
        defer f.Close()

        runtime.GC() // Force GC before profiling
        if err := pprof.WriteHeapProfile(f); err != nil {
            return err
        }
    }

    return nil
}
```

---
