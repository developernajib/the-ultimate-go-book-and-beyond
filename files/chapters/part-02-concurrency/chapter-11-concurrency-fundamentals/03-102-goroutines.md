## 11.2 Goroutines

Goroutines are lightweight threads managed by the Go runtime. They're the foundation of Go's concurrency model.

### Creating Goroutines

The `go` keyword prefixed before any function call is all it takes to launch a goroutine. The runtime handles scheduling, stack allocation, and cleanup automatically. You can use it with named functions, anonymous closures, method calls, or loop-driven fan-outs, and in every case the calling goroutine continues immediately without waiting for the spawned one to finish. The examples below cover the most common forms you will encounter in real codebases.

```go
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
```

### Goroutine vs OS Thread: A Detailed Comparison

Goroutines differ from OS threads in every dimension that matters for scale:

| Aspect | Goroutine | OS Thread |
|--------|-----------|-----------|
| Initial stack size | 2 KB (grows dynamically) | 1-8 MB (fixed) |
| Creation time | ~300 ns | ~10-100 μs |
| Context switch | ~200 ns (user space) | ~1-2 μs (kernel) |
| Max practical count | Millions | Thousands |
| Scheduling | Go runtime (M:N) | OS kernel (1:1) |
| Memory per unit | ~2-8 KB typical | ~1-8 MB |

### Memory Footprint Demonstration

The best way to appreciate goroutine efficiency is to measure it directly. One subtlety governs how you measure: goroutine stacks do not live on the heap, so `MemStats.Alloc` (which is `HeapAlloc`) will not see them. The runtime accounts stack spans separately in `StackInuse`. A measurement that reads only `Alloc` therefore misses the dominant cost and reports a wildly low number. The program below sums both fields: `Alloc` captures the per-goroutine `g` structures, and `StackInuse` captures the 2 KB stacks themselves.

```go
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
    // Stacks are accounted in StackInuse, not Alloc. Count both.
    beforeAlloc := m.Alloc + m.StackInuse
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
    afterAlloc := m.Alloc + m.StackInuse
    afterGoroutines := runtime.NumGoroutine()

    memPerGoroutine := float64(afterAlloc-beforeAlloc) / float64(numGoroutines)

    fmt.Printf("Goroutines created: %d\n", afterGoroutines-beforeGoroutines)
    fmt.Printf("Memory per goroutine: %.2f KB\n", memPerGoroutine/1024)
    fmt.Printf("Total memory used: %.2f MB\n", float64(afterAlloc-beforeAlloc)/1024/1024)

    // Cleanup
    close(done)
}
```

Output (typical):
```
Goroutines created: 100000
Memory per goroutine: 2.35 KB
Total memory used: 229.49 MB
```

Compare this to OS threads: 100,000 threads × 2MB = 200 GB (impossible on most systems).

### Why Go Does Not Need async/await: The G-M-P Scheduling Engine

Engineers transitioning from JavaScript, Python, or Rust frequently ask why Go lacks `async` and `await` keywords. The answer lies in Go's M:N runtime scheduler, which eliminates the infamous **"function coloring problem"** (where async functions can only be called from other async functions, fracturing APIs across codebases).

In Go, every function has an identical synchronous signature. Asynchronous execution is handled transparently by the runtime using the **G-M-P Architecture**:

- **G (Goroutine)**: Represents the lightweight execution thread, including its initial 2 KB dynamically growable stack, instruction pointer, and scheduling status (`_Grunnable`, `_Grunning`, `_Gwaiting`).
- **M (Machine)**: Represents an OS kernel thread created and managed by the operating system.
- **P (Processor)**: Represents a logical context and resource required to execute Go code. The number of $P$s is strictly bounded by `GOMAXPROCS` (defaults to available logical CPU cores).

```
   ┌─────────┐       ┌─────────┐
   │ P1 (LRQ)│       │ P2 (LRQ)│
   │ [G3][G4]│       │ [G5][G6]│
   └────┬────┘       └────┬────┘
        │                 │
   ┌────┴────┐       ┌────┴────┐
   │ M1 (OS) │       │ M2 (OS) │
   │ Exec G1 │       │ Exec G2 │
   └─────────┘       └─────────┘
        ▲                 ▲
        │                 │
  ──────┴─────────────────┴────── CPU Cores
```

#### How Go Eliminates CPU Idle Time

The runtime scheduler keeps CPU cores saturated through four cooperative mechanisms:

1. **Non-blocking Network I/O via the Netpoller**:
   When a goroutine reads from a network socket (`net.Conn.Read`), the runtime registers the file descriptor with the OS event notification system (`epoll` on Linux, `kqueue` on macOS, `IOCP` on Windows). Instead of blocking the OS thread ($M$), the goroutine ($G$) is detached and placed into a waiting state. The $M$ immediately picks up the next runnable $G$ from its $P$'s local run queue (LRQ). When the network socket receives data, the background netpoller transitions $G$ back to a runnable state.

2. **System Call Handoff (`handoffp`)**:
   When a goroutine executes a blocking OS system call (such as disk I/O or cgo), the executing OS thread ($M$) must block in the kernel. The runtime immediately dissociates the logical processor ($P$) from the blocked $M$ and reassigns $P$ to an idle or newly spawned thread ($M'$). The remaining runnable goroutines in $P$'s local queue continue executing on other CPU cores without delay.

3. **Work-Stealing Algorithm**:
   Each $P$ maintains a 256-element local run queue (LRQ). When a $P$ exhausts its local queue, it attempts to acquire work in a strict order:
   - Check the Global Run Queue (GRQ) with a 1/61 frequency to prevent global starvation.
   - Poll the network poller for newly unblocked network goroutines.
   - Steal half the runnable goroutines from another randomly chosen $P$'s local run queue.

4. **Preemption and `sysmon`**:
   To prevent a compute-bound goroutine from starving other tasks on the same $P$, the runtime includes a background thread called `sysmon` (system monitor) that runs without a $P$. If `sysmon` observes a goroutine running uninterrupted for $>10	ext{ms}$, it emits an asynchronous preemption signal (`SIGURG` on Unix, introduced in Go 1.14), forcing the goroutine to yield its thread and return to the run queue.

> [!NOTE]
> For a comparative architectural walkthrough of OS threads, async event loops, and Go's G-M-P scheduler, see Rajendra Bisoi's deep dive [*Why Go Doesn't Need async/await: Understanding Goroutines and the G-M-P Scheduler*](https://medium.com/search?q=why+go+doesn't+need+async+await).

### Goroutine Lifecycle

A goroutine moves through four observable states during its lifetime: it starts runnable after the `go` statement, transitions to running when the scheduler assigns it to an OS thread, may block while waiting on a channel or system call, and eventually terminates when its function returns. The diagram below maps these transitions, showing how a blocked goroutine re-enters the runnable queue once the data it was waiting for becomes available.

```
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
```

### Stack Growth

OS threads allocate a fixed stack (typically 1-8 MB) at creation. If a function's call chain exceeds that, the program crashes with a stack overflow. Goroutines start with a tiny 2 KB stack that the runtime grows and shrinks on demand by copying it to a larger allocation when a function prologue detects insufficient space. This means a goroutine can safely recurse to depths that would destroy a fixed-stack thread.

```go
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
        fmt.Printf("Recursion depth: %d\n", result)
    }()

    time.Sleep(time.Second)
}
```

### Capturing Variables in Goroutines

When a goroutine closure references a variable from an outer scope, it captures the variable itself, not a snapshot of its value. If that variable is mutated before the goroutine runs, the goroutine observes the mutated value. What matters is therefore how many variables the loop actually creates.

Before Go 1.22, a `for` loop created **one** loop variable shared by every iteration, so every closure captured the same variable and read whatever value it held at the moment the goroutine happened to run. Since Go 1.22 each iteration gets its **own** variable, and the closure captures that per-iteration copy. This was the single most common goroutine bug in Go, and the language fixed it outright.

```go
// Go 1.21 and earlier: one shared i. Likely prints "5" five times.
// Go 1.22 and later: per-iteration i. Prints 0..4 in some order.
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i)
    }()
}
```

The two pre-1.22 workarounds are still worth recognising, because they are everywhere in existing code.

```go
// Workaround 1: pass the value as a parameter
for i := 0; i < 5; i++ {
    go func(n int) {
        fmt.Println(n)  // Prints 0, 1, 2, 3, 4 (in some order)
    }(i)
}

// Workaround 2: shadow the variable inside the loop body
for i := 0; i < 5; i++ {
    i := i  // Redundant on Go 1.22+
    go func() {
        fmt.Println(i)
    }()
}
```

**Note**: the per-iteration semantics apply only when the file's module declares `go 1.22` or later in `go.mod`. The change is gated on the language version, so an old module compiled with a new toolchain keeps the old behaviour.

### Goroutine-Per-Request Pattern

Production servers typically spawn one goroutine per incoming connection, tracked by a `WaitGroup` and gated by a quit channel for graceful shutdown. The `Serve` method accepts connections in a loop, launches a handler goroutine for each one, and checks the quit channel on accept errors to distinguish a clean shutdown from a real failure. `Shutdown` closes the quit channel, closes the listener (unblocking `Accept`), and waits for all in-flight handlers to drain.

```go
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
```

### The "Every Goroutine Must Know How It Exits" Rule

The single most important discipline in concurrent Go: before writing `go`, know how the goroutine terminates. Every goroutine must have a clear exit path. The exit conditions fall into four categories:

1. **Work-complete exit.** The function body returns. This is the default and the simplest. Use for short, bounded work.
2. **Context-driven exit.** The goroutine loop selects on `ctx.Done()`. When the parent cancels the context, the goroutine exits. This is the dominant pattern for long-running goroutines.
3. **Channel-close exit.** The goroutine ranges over a channel. When the sender closes the channel, the loop terminates. Used in pipelines.
4. **Signal-driven exit.** A dedicated `quit` or `done` channel that the goroutine selects on. This is the precursor to the modern context pattern. New code should prefer `context.Context`.

If you cannot place the goroutine in one of these four categories at the time of writing, the goroutine leaks. This is a code-review finding at every level.

### Go 1.22+ Loop Variable Semantics

The loop-variable bug described above was fixed in Go 1.22. For code targeting Go 1.22 or later, the `i := i` shadow is unnecessary. For code that must compile with older Go, keep the shadow. When auditing a codebase that straddles the 1.22 boundary, check the `go` directive in `go.mod`. Code with `go 1.22` or later does not need the shadow. Code with `go 1.21` or earlier does.

### Goroutine Counts in Production

A healthy production service has a goroutine count that correlates with request volume and stays bounded. A service with a leak has a goroutine count that trends upward monotonically. Expose `runtime.NumGoroutine()` as a Prometheus metric. Alert on sustained upward trends. When the count exceeds a threshold, capture a goroutine dump (`pprof.Lookup("goroutine").WriteTo(w, 2)`) for post-hoc diagnosis. This single metric catches most leak-class bugs before they become outages.

### Staff Lens: The Goroutine Budget

At scale, "goroutines are cheap" is a lie. Two thousand goroutines is fine. Two hundred thousand is suspect. Two million is the service melting. Each goroutine costs stack memory (growable to MB if the call tree is deep), scheduler overhead, and GC scan time. A service with 500K idle goroutines spends measurable CPU just scanning their stacks at GC time. The staff-track discipline: define a goroutine budget for the service, enforce it via bounded pools, and alert when the count exceeds it. The default of "just spawn a goroutine whenever" does not scale. Every fan-out point needs a bounded concurrency limit (`golang.org/x/sync/semaphore` or a worker pool), and that limit should be tuned based on downstream capacity, not hope.

### Principal Lens: Goroutines vs Threads, Two Decades Later

The goroutine-vs-thread comparison feels settled, but the landscape changed. Virtual threads in Java 21 (Project Loom), async/await in Rust, and fiber-based concurrency in other runtimes all approximate Go's goroutines. Go's lead on cheap concurrency has narrowed. The things that still distinguish Go: the channel primitive, the select statement, the integrated race detector, and the scheduler's maturity. When evaluating whether to build a new concurrent system in Go versus an alternative, do not rely on "goroutines are cheaper than threads". That advantage exists but it is smaller than it was. The durable advantages are the ecosystem, the tooling, and the predictable performance characteristics. A principal engineer making a technology-selection call should articulate the real advantages, not the dated ones.

---
