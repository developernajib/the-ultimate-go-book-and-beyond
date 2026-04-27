export default `## 7.2 Go Runtime Architecture

The Go runtime is statically linked into every compiled binary. Unlike languages that depend on an external virtual machine or interpreter, Go's runtime ships as compiled code inside the executable itself. It provides:

- Goroutine scheduling
- Memory allocation
- Garbage collection
- Stack management
- Channel operations
- Timer management
- Network polling

### Runtime Initialization

Before \`main()\` executes, the runtime runs an initialization sequence that sets up the scheduler, allocator, and GC. The diagram below shows the exact order of operations from process creation to your first line of code.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Go Program Startup Sequence                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. OS creates process, loads binary                                         │
│  2. _rt0_amd64_linux (entry point, architecture-specific)                   │
│  3. runtime.rt0_go                                                           │
│     ├── Initialize TLS (Thread Local Storage)                               │
│     ├── Initialize g0 (bootstrap goroutine)                                 │
│     ├── Initialize m0 (bootstrap OS thread)                                 │
│     └── Call runtime.schedinit                                              │
│  4. runtime.schedinit                                                        │
│     ├── Initialize stack allocator                                          │
│     ├── Initialize heap allocator                                           │
│     ├── Initialize GC                                                       │
│     ├── Read GOMAXPROCS                                                     │
│     ├── Initialize P's (Processors)                                         │
│     └── Initialize timers                                                   │
│  5. runtime.newproc(&main.main)                                             │
│     └── Create goroutine for main.main                                      │
│  6. runtime.mstart                                                           │
│     └── Start scheduling, runs main goroutine                               │
│  7. runtime.main                                                             │
│     ├── Start background goroutines (sysmon, etc.)                         │
│     ├── Initialize all packages (init functions)                            │
│     └── Call main.main                                                      │
│  8. Your main() function runs                                               │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Inspect Runtime Initialization

The runtime initialization sequence sets up the allocator, scheduler, and GC before \`main\` runs. The following instrumentation reveals the order and timing of each initialization step.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "time"
)

func init() {
    fmt.Println("init() called")
    fmt.Printf("GOMAXPROCS: %d\\n", runtime.GOMAXPROCS(0))
    fmt.Printf("NumCPU: %d\\n", runtime.NumCPU())
    fmt.Printf("NumGoroutine: %d\\n", runtime.NumGoroutine())
}

func main() {
    fmt.Println("\\nmain() called")
    fmt.Printf("NumGoroutine: %d\\n", runtime.NumGoroutine())

    // Show runtime version and compiler
    fmt.Printf("Go version: %s\\n", runtime.Version())
    fmt.Printf("Compiler: %s\\n", runtime.Compiler)
    fmt.Printf("GOOS: %s\\n", runtime.GOOS)
    fmt.Printf("GOARCH: %s\\n", runtime.GOARCH)

    // Memory stats
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    fmt.Printf("\\nHeap: %d KB\\n", m.HeapAlloc/1024)
    fmt.Printf("Stack: %d KB\\n", m.StackInuse/1024)

    // Wait to observe background goroutines
    time.Sleep(100 * time.Millisecond)
}
\`\`\`

### Runtime Size and Composition

The runtime adds approximately 1-2MB to every Go binary. You can measure the exact size and see which runtime components contribute the most with the \`nm\` tool.

\`\`\`bash
# See binary size breakdown
go build -o myapp main.go
go tool nm -size myapp | sort -k2 -n | tail -20

# Compare with stripped binary
go build -ldflags="-s -w" -o myapp-stripped main.go
ls -la myapp myapp-stripped
\`\`\`

Runtime components by approximate size:
- **Garbage collector**: ~400KB
- **Scheduler**: ~200KB
- **Memory allocator**: ~300KB
- **Stack management**: ~100KB
- **Reflection data**: ~200KB
- **Network poller**: ~100KB
- **Runtime types**: ~200KB

### The sysmon Thread

Go runs a special system monitor thread (\`sysmon\`) outside the normal P/M scheduling model. It runs independently and does not require a P, so it continues operating even when all Ps are busy or blocked. It handles:

- Preemption of long-running goroutines (signaling via async preemption on Go 1.14+)
- Network polling when all P's are busy
- GC triggering based on heap growth
- Timer firing for \`time.Sleep\`, \`time.After\`, and deadlines
- Deadlock detection (detecting when all goroutines are asleep)

\`\`\`go
// Demonstrate sysmon's preemption (Go 1.14+)
package main

import (
    "fmt"
    "runtime"
    "time"
)

func main() {
    runtime.GOMAXPROCS(1) // Single P to make effect visible

    done := make(chan bool)

    // Goroutine with tight loop (no function calls)
    go func() {
        count := 0
        start := time.Now()
        for time.Since(start) < 100*time.Millisecond {
            count++
            // Before Go 1.14, this would never yield
            // With Go 1.14+ async preemption, it yields
        }
        fmt.Printf("Loop iterations: %d\\n", count)
        done <- true
    }()

    // This goroutine should also get time to run
    go func() {
        time.Sleep(10 * time.Millisecond)
        fmt.Println("Second goroutine ran!")
        done <- true
    }()

    <-done
    <-done
}
\`\`\`

### Reading the Runtime for Incident Diagnosis

For a senior engineer on call, the runtime is an instrument panel. Three patterns that only make sense once you understand the architecture:

1. **Sudden jump in CPU usage with no change in throughput.** Often the scheduler is thrashing between goroutines that block on each other. Trace shows alternating long spans on a single P. Fix: reduce goroutine count or reduce cross-goroutine communication.
2. **Flat throughput under rising traffic.** Often a single long-running syscall is pinning an M and preventing the P from scheduling new work. Trace shows a handoff gap. Fix: use non-blocking alternatives or bound the blocking operations.
3. **Periodic latency spikes every N seconds.** Often GC cycles. \`GODEBUG=gctrace=1\` confirms and gives you a pause-time distribution. Fix: reduce allocation rate or raise \`GOGC\`.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **\`runtime.GOMAXPROCS(1)\` in production code.** Almost always wrong. Removes parallelism for no benefit.
2. **Manual thread management via cgo.** If the team reaches for cgo to manage OS threads, something is broken in the architecture. The Go runtime already does this job well.

---
`;
