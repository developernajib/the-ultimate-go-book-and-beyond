export default `## 11.2 Goroutines

Goroutines are lightweight threads managed by the Go runtime. They're the foundation of Go's concurrency model.

### Creating Goroutines

The \`go\` keyword prefixed before any function call is all it takes to launch a goroutine, the runtime handles scheduling, stack allocation, and cleanup automatically. You can use it with named functions, anonymous closures, method calls, or loop-driven fan-outs, and in every case the calling goroutine continues immediately without waiting for the spawned one to finish. The examples below cover the most common forms you will encounter in real codebases.

\`\`\`go
// Start a goroutine with the go keyword
go doSomething()

// With anonymous function
go func() {
    fmt.Println("running in goroutine")
}()

// With function that takes parameters
go processData(data)

// With method
go user.SendNotification()

// Multiple goroutines in a loop
for i := 0; i < 10; i++ {
    go worker(i)
}
\`\`\`

### Goroutine vs OS Thread: A Detailed Comparison

Goroutines differ from OS threads in every dimension that matters for scale:

| Aspect | Goroutine | OS Thread |
|--------|-----------|-----------|
| Initial stack size | 2 KB (grows dynamically) | 1-8 MB (fixed) |
| Creation time | ~300 ns | ~1 ms |
| Context switch | ~200 ns (user space) | ~1-2 μs (kernel) |
| Max practical count | Millions | Thousands |
| Scheduling | Go runtime (M:N) | OS kernel (1:1) |
| Memory per unit | ~2-8 KB typical | ~1-8 MB |

### Memory Footprint Demonstration

The best way to appreciate goroutine efficiency is to measure it directly. The program below uses \`runtime.ReadMemStats\` to capture heap allocation before and after launching 100,000 goroutines, then divides the difference to compute average memory per goroutine. Running it on typical hardware reveals that each goroutine costs only a few kilobytes, orders of magnitude less than the megabytes an OS thread would require.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "time"
)

func main() {
    // Measure baseline memory
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    beforeAlloc := m.Alloc
    beforeGoroutines := runtime.NumGoroutine()

    // Create 100,000 goroutines
    const numGoroutines = 100_000
    done := make(chan struct{})

    for i := 0; i < numGoroutines; i++ {
        go func() {
            <-done  // Wait for signal
        }()
    }

    // Allow goroutines to start
    time.Sleep(time.Second)

    // Measure after creation
    runtime.ReadMemStats(&m)
    afterAlloc := m.Alloc
    afterGoroutines := runtime.NumGoroutine()

    memPerGoroutine := float64(afterAlloc-beforeAlloc) / float64(numGoroutines)

    fmt.Printf("Goroutines created: %d\\n", afterGoroutines-beforeGoroutines)
    fmt.Printf("Memory per goroutine: %.2f KB\\n", memPerGoroutine/1024)
    fmt.Printf("Total memory used: %.2f MB\\n", float64(afterAlloc-beforeAlloc)/1024/1024)

    // Cleanup
    close(done)
}
\`\`\`

Output (typical):
\`\`\`
Goroutines created: 100000
Memory per goroutine: 2.35 KB
Total memory used: 229.49 MB
\`\`\`

Compare this to OS threads: 100,000 threads × 2MB = 200 GB (impossible on most systems).

### Goroutine Lifecycle

A goroutine moves through four observable states during its lifetime: it starts runnable after the \`go\` statement, transitions to running when the scheduler assigns it to an OS thread, may block while waiting on a channel or system call, and eventually terminates when its function returns. The diagram below maps these transitions, showing how a blocked goroutine re-enters the runnable queue once the data it was waiting for becomes available.

\`\`\`
Creation        Running         Blocked         Runnable        Terminated
    │              │               │                │               │
    │   go func()  │               │                │               │
    ├──────────────►               │                │               │
    │              │               │                │               │
    │              │  channel op   │                │               │
    │              ├───────────────►                │               │
    │              │               │                │               │
    │              │               │   data ready   │               │
    │              │               ├────────────────►               │
    │              │               │                │               │
    │              │◄──────────────┴────────────────┤               │
    │              │      scheduled                 │               │
    │              │                                │               │
    │              │           return               │               │
    │              ├───────────────────────────────────────────────►
    │              │                                │               │
\`\`\`

### Stack Growth

OS threads allocate a fixed stack (typically 1-8 MB) at creation. If a function's call chain exceeds that, the program crashes with a stack overflow. Goroutines start with a tiny 2 KB stack that the runtime grows and shrinks on demand by copying it to a larger allocation when a function prologue detects insufficient space. This means a goroutine can safely recurse to depths that would destroy a fixed-stack thread.

\`\`\`go
// Goroutine stacks grow as needed
func deepRecursion(depth int) int {
    if depth == 0 {
        return 0
    }
    // Each call uses stack space
    // Goroutine stack grows automatically
    return 1 + deepRecursion(depth-1)
}

func main() {
    // This would overflow a fixed 1MB stack
    // but goroutines can grow their stack
    go func() {
        result := deepRecursion(100000)
        fmt.Printf("Recursion depth: %d\\n", result)
    }()

    time.Sleep(time.Second)
}
\`\`\`

### Capturing Variables in Goroutines

When a goroutine closure references a variable from an outer scope, it captures a reference to that variable, not a snapshot of its value. If the variable changes before the goroutine runs, as it does on every loop iteration, all goroutines end up reading the same final value. This is the single most common goroutine bug in Go code written before 1.22.

\`\`\`go
// Bug: All goroutines see the same value of i
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i)  // Likely prints "5" five times
    }()
}

// Fix 1: Pass as parameter
for i := 0; i < 5; i++ {
    go func(n int) {
        fmt.Println(n)  // Prints 0, 1, 2, 3, 4 (in some order)
    }(i)
}

// Fix 2: Shadow the variable (Go 1.22+ fixes this automatically)
for i := 0; i < 5; i++ {
    i := i  // Shadow i with new variable
    go func() {
        fmt.Println(i)  // Each goroutine has its own copy
    }()
}
\`\`\`

**Note**: Go 1.22 changed loop variable semantics so each iteration gets its own variable, fixing this issue for \`for\` loops.

### Goroutine-Per-Request Pattern

Production servers typically spawn one goroutine per incoming connection, tracked by a \`WaitGroup\` and gated by a quit channel for graceful shutdown. The \`Serve\` method accepts connections in a loop, launches a handler goroutine for each one, and checks the quit channel on accept errors to distinguish a clean shutdown from a real failure. \`Shutdown\` closes the quit channel, closes the listener (unblocking \`Accept\`), and waits for all in-flight handlers to drain.

\`\`\`go
type Server struct {
    listener net.Listener
    wg       sync.WaitGroup
    quit     chan struct{}
}

func (s *Server) Serve() error {
    for {
        conn, err := s.listener.Accept()
        if err != nil {
            select {
            case <-s.quit:
                return nil  // Clean shutdown
            default:
                log.Printf("accept error: %v", err)
                continue
            }
        }

        s.wg.Add(1)
        go func() {
            defer s.wg.Done()
            s.handleConnection(conn)
        }()
    }
}

func (s *Server) Shutdown() {
    close(s.quit)
    s.listener.Close()
    s.wg.Wait()  // Wait for all connections to finish
}

func (s *Server) handleConnection(conn net.Conn) {
    defer conn.Close()

    // Set deadline for the connection
    conn.SetDeadline(time.Now().Add(30 * time.Second))

    // Handle the connection...
    buffer := make([]byte, 4096)
    for {
        n, err := conn.Read(buffer)
        if err != nil {
            return
        }
        _, err = conn.Write(buffer[:n])
        if err != nil {
            return
        }
    }
}
\`\`\`

### The "Every Goroutine Must Know How It Exits" Rule

The single most important discipline in concurrent Go: before writing \`go\`, know how the goroutine terminates. Every goroutine must have a clear exit path. The exit conditions fall into four categories:

1. **Work-complete exit.** The function body returns. This is the default and the simplest. Use for short, bounded work.
2. **Context-driven exit.** The goroutine loop selects on \`ctx.Done()\`. When the parent cancels the context, the goroutine exits. This is the dominant pattern for long-running goroutines.
3. **Channel-close exit.** The goroutine ranges over a channel. When the sender closes the channel, the loop terminates. Used in pipelines.
4. **Signal-driven exit.** A dedicated \`quit\` or \`done\` channel that the goroutine selects on. This is the precursor to the modern context pattern. New code should prefer \`context.Context\`.

If you cannot place the goroutine in one of these four categories at the time of writing, the goroutine leaks. This is a code-review finding at every level.

### Go 1.22+ Loop Variable Semantics

The loop-variable bug described above was fixed in Go 1.22. For code targeting Go 1.22 or later, the \`i := i\` shadow is unnecessary. For code that must compile with older Go, keep the shadow. When auditing a codebase that straddles the 1.22 boundary, check the \`go\` directive in \`go.mod\`. Code with \`go 1.22\` or later does not need the shadow. Code with \`go 1.21\` or earlier does.

### Goroutine Counts in Production

A healthy production service has a goroutine count that correlates with request volume and stays bounded. A service with a leak has a goroutine count that trends upward monotonically. Expose \`runtime.NumGoroutine()\` as a Prometheus metric. Alert on sustained upward trends. When the count exceeds a threshold, capture a goroutine dump (\`pprof.Lookup("goroutine").WriteTo(w, 2)\`) for post-hoc diagnosis. This single metric catches most leak-class bugs before they become outages.

### Staff Lens: The Goroutine Budget

At scale, "goroutines are cheap" is a lie. Two thousand goroutines is fine. Two hundred thousand is suspect. Two million is the service melting. Each goroutine costs stack memory (growable to MB if the call tree is deep), scheduler overhead, and GC scan time. A service with 500K idle goroutines spends measurable CPU just scanning their stacks at GC time. The staff-track discipline: define a goroutine budget for the service, enforce it via bounded pools, and alert when the count exceeds it. The default of "just spawn a goroutine whenever" does not scale. Every fan-out point needs a bounded concurrency limit (\`golang.org/x/sync/semaphore\` or a worker pool), and that limit should be tuned based on downstream capacity, not hope.

### Principal Lens: Goroutines vs Threads, Two Decades Later

The goroutine-vs-thread comparison feels settled, but the landscape changed. Virtual threads in Java 21 (Project Loom), async/await in Rust, and fiber-based concurrency in other runtimes all approximate Go's goroutines. Go's lead on cheap concurrency has narrowed. The things that still distinguish Go: the channel primitive, the select statement, the integrated race detector, and the scheduler's maturity. When evaluating whether to build a new concurrent system in Go versus an alternative, do not rely on "goroutines are cheaper than threads". That advantage exists but it is smaller than it was. The durable advantages are the ecosystem, the tooling, and the predictable performance characteristics. A principal engineer making a technology-selection call should articulate the real advantages, not the dated ones.

---
`;
