## 5. Profiling and Performance

### 5.1 CPU Profiling

CPU profiles record which functions consume the most processor time. Generate a profile during benchmarks or from a running server, then analyze it with `go tool pprof`.

```bash
# Generate CPU profile
go test -cpuprofile=cpu.prof -bench=.

# Analyze with pprof
go tool pprof cpu.prof

# pprof interactive commands
(pprof) top             # Show top functions by CPU time
(pprof) top20           # Show top 20
(pprof) list FuncName   # Show annotated source
(pprof) web             # Open in browser (requires graphviz)
(pprof) pdf > cpu.pdf   # Export to PDF
(pprof) png > cpu.png   # Export to PNG

# Direct analysis
go tool pprof -top cpu.prof
go tool pprof -list=main.processRequest cpu.prof
go tool pprof -web cpu.prof

# HTTP endpoint profiling
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
```

### 5.2 Memory Profiling

Memory profiles track allocation counts and bytes. Use `-alloc_space` to find total allocations over the profile period, or `-inuse_space` to find what is currently consuming heap memory.

```bash
# Generate memory profile
go test -memprofile=mem.prof -bench=.

# Analyze allocations
go tool pprof mem.prof

# Show allocations
go tool pprof -alloc_space mem.prof
go tool pprof -alloc_objects mem.prof

# Show in-use memory
go tool pprof -inuse_space mem.prof
go tool pprof -inuse_objects mem.prof

# Common pprof commands for memory
(pprof) top -cum        # Cumulative allocations
(pprof) list FuncName   # Source with allocations
(pprof) web             # Visualization
```

### 5.3 Runtime Profiling in Application

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof"
    "os"
    "runtime"
    "runtime/pprof"
    "runtime/trace"
)

func main() {
    // CPU profiling
    if cpuprofile := os.Getenv("CPUPROFILE"); cpuprofile != "" {
        f, err := os.Create(cpuprofile)
        if err != nil {
            log.Fatal(err)
        }
        defer f.Close()

        if err := pprof.StartCPUProfile(f); err != nil {
            log.Fatal(err)
        }
        defer pprof.StopCPUProfile()
    }

    // Memory profiling
    if memprofile := os.Getenv("MEMPROFILE"); memprofile != "" {
        defer func() {
            f, err := os.Create(memprofile)
            if err != nil {
                log.Fatal(err)
            }
            defer f.Close()

            runtime.GC() // Get up-to-date statistics
            if err := pprof.WriteHeapProfile(f); err != nil {
                log.Fatal(err)
            }
        }()
    }

    // Trace
    if tracefile := os.Getenv("TRACE"); tracefile != "" {
        f, err := os.Create(tracefile)
        if err != nil {
            log.Fatal(err)
        }
        defer f.Close()

        if err := trace.Start(f); err != nil {
            log.Fatal(err)
        }
        defer trace.Stop()
    }

    // HTTP pprof endpoint
    go func() {
        log.Println("pprof server on :6060")
        log.Println(http.ListenAndServe(":6060", nil))
    }()

    // Application code...
}
```

### 5.4 pprof HTTP Endpoints

```bash
# Available endpoints when importing _ "net/http/pprof"
http://localhost:6060/debug/pprof/           # Index
http://localhost:6060/debug/pprof/profile    # CPU profile (30s default)
http://localhost:6060/debug/pprof/heap       # Memory profile
http://localhost:6060/debug/pprof/goroutine  # Goroutine profile
http://localhost:6060/debug/pprof/block      # Block profile
http://localhost:6060/debug/pprof/mutex      # Mutex profile
http://localhost:6060/debug/pprof/threadcreate # Thread creation profile
http://localhost:6060/debug/pprof/trace?seconds=5 # Execution trace

# Analyze live server
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
go tool pprof http://localhost:6060/debug/pprof/heap
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Download and analyze later
curl -o cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
go tool pprof cpu.prof
```

### 5.5 Execution Tracing

```bash
# Generate trace
go test -trace=trace.out -bench=.

# Or in application
TRACE=trace.out ./myapp

# Analyze trace
go tool trace trace.out

# Trace viewer shows:
# - Goroutine execution
# - Network blocking
# - System calls
# - GC events
# - Synchronization blocking
```

### 5.6 Block and Mutex Profiling

```go
package main

import (
    "net/http"
    _ "net/http/pprof"
    "runtime"
)

func main() {
    // Enable block profiling
    runtime.SetBlockProfileRate(1)

    // Enable mutex profiling
    runtime.SetMutexProfileFraction(1)

    go func() {
        http.ListenAndServe(":6060", nil)
    }()

    // Application code...
}
```

```bash
# Analyze blocking operations
go tool pprof http://localhost:6060/debug/pprof/block

# Analyze mutex contention
go tool pprof http://localhost:6060/debug/pprof/mutex
```

### 5.7 Benchstat for Benchmark Comparison

```bash
# Install benchstat
go install golang.org/x/perf/cmd/benchstat@latest

# Run benchmarks multiple times
go test -bench=. -count=10 > old.txt

# Make changes...

go test -bench=. -count=10 > new.txt

# Compare results
benchstat old.txt new.txt

# Output shows:
# - Delta (improvement/regression)
# - Statistical significance
# - Performance metrics
```

---
