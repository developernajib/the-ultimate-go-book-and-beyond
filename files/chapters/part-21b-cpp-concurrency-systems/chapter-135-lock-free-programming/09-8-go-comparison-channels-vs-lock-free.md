## 8. Go Comparison: Channels vs. Lock-Free

Go's concurrency model is built on CSP (Communicating Sequential Processes). Instead of shared memory with atomic operations, Go encourages message passing through channels.

### Go's Philosophy: "Don't communicate by sharing memory. Share memory by communicating."

Go's channel-based stack serializes all mutations through a single goroutine that owns the slice, eliminating shared-state races by design. Operations are sent as closures over the `ops` channel, which the owner goroutine executes sequentially. This trades some throughput for simplicity and safety, contrasting with C++'s lock-free approach which exposes the developer directly to CAS loops, memory ordering, and ABA hazards.
```go
package main

import (
    "fmt"
    "sync"
)

// Go: channel-based concurrent stack
type ChanStack struct {
    ops chan func([]int) []int
}

func NewChanStack() *ChanStack {
    s := &ChanStack{ops: make(chan func([]int) []int)}
    go func() {
        var stack []int
        for op := range s.ops {
            stack = op(stack)
        }
    }()
    return s
}

func (s *ChanStack) Push(val int) {
    done := make(chan struct{})
    s.ops <- func(stack []int) []int {
        defer close(done)
        return append(stack, val)
    }
    <-done
}

func (s *ChanStack) Pop() (int, bool) {
    result := make(chan int, 1)
    ok := make(chan bool, 1)
    s.ops <- func(stack []int) []int {
        if len(stack) == 0 {
            ok <- false
            return stack
        }
        result <- stack[len(stack)-1]
        ok <- true
        return stack[:len(stack)-1]
    }
    if <-ok {
        return <-result, true
    }
    return 0, false
}

func main() {
    s := NewChanStack()
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(v int) {
            defer wg.Done()
            s.Push(v)
        }(i)
    }
    wg.Wait()

    for {
        val, ok := s.Pop()
        if !ok {
            break
        }
        fmt.Println(val)
    }
}
```

### Go Does Have Atomics

When performance demands it, Go provides `sync/atomic`:

```go
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
)

func main() {
    var counter atomic.Int64
    var wg sync.WaitGroup

    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Add(1)
        }()
    }
    wg.Wait()
    fmt.Println("Counter:", counter.Load())  // 1000
}
```

Go 1.19+ added typed atomics (`atomic.Int64`, `atomic.Pointer[T]`), and `atomic.CompareAndSwap` is available. However, building full lock-free data structures in Go is rare and discouraged, the runtime's goroutine scheduler, garbage collector, and channel implementation already handle most concurrency needs.

### Side-by-Side Comparison

| Aspect | C++ Lock-Free | Go Channels |
|-----------------------|----------------------------|-----------------------------|
| Memory model | Explicit orderings | Happens-before via channels |
| GC / Reclamation | Manual (HP, EBR, etc.) | Automatic GC |
| ABA problem | Must solve manually | GC prevents address reuse |
| Typical throughput | Higher (no scheduling) | Lower (goroutine overhead) |
| Typical latency | Lower, more predictable | Higher, GC pauses possible |
| Correctness effort | Very high | Moderate |
| Best for | Infrastructure, kernels | Application-level services |

**Key insight:** Go's garbage collector eliminates the entire class of memory reclamation problems (ABA, use-after-free, hazard pointers) that make C++ lock-free programming so difficult. This is a deliberate design trade-off: Go sacrifices raw performance for safety and simplicity.

### When Go Developers Reach for Atomics

Despite the "share memory by communicating" philosophy, real-world Go code does use atomics in specific scenarios:

- **Hot-path counters** in metrics libraries (Prometheus client, expvar) use `atomic.Int64` to avoid channel overhead on every increment.
- **sync.Pool** and **sync.Map** in the standard library are built on atomics internally.
- **Feature flags and configuration** use `atomic.Pointer[T]` for lock-free reads with rare writes, essentially the RCU pattern with GC handling reclamation.
- **Once-initialization** (`sync.Once`) uses an atomic fast path to avoid mutex acquisition after the first call.

The pattern is consistent: Go uses atomics as an optimization *within* well-tested library code, not as a general application-level programming model. Application developers are expected to use channels and mutexes.

### Porting Lock-Free Structures from C++ to Go

If you genuinely need a lock-free data structure in Go (perhaps for a database engine or a high-frequency trading system), consider these differences:

1. **No manual memory reclamation needed.** Go's GC handles it. This eliminates hazard pointers, EBR, and tagged-pointer schemes entirely.
2. **No double-width CAS.** Go's `atomic.CompareAndSwapPointer` operates on single pointers only. Tagged pointer tricks require `unsafe.Pointer` and careful alignment.
3. **Goroutine preemption.** Go's scheduler can preempt goroutines at almost any point (since Go 1.14). This interacts with lock-free algorithms in ways that pthread-based code does not experience.
4. **Escape analysis matters.** If a node in your lock-free structure escapes to the heap (which it almost certainly will), every allocation hits the GC. Profile with `go tool pprof` to ensure GC pressure is acceptable.

### Junior → FAANG: When to Use Go Channels vs. Lock-Free Structures

Go channels are the idiomatic Go concurrency primitive. They are implemented with a mutex internally, so they are not lock-free, but they are safe, composable, and well-understood. For most Go concurrency needs, a channel is the right answer.

Use `sync/atomic` directly in Go when: you have a single integer counter that is updated from many goroutines (a metrics counter), or you have a flag set by one goroutine and read by another (a "done" signal). For these simple cases, `sync/atomic` avoids channel overhead.

Avoid re-implementing lock-free data structures in Go from scratch. The combination of GC pressure (every heap allocation is a GC candidate), goroutine preemption at arbitrary points, and the lack of double-width CAS makes Go lock-free code harder to write correctly than C++ lock-free code.

### Senior @ FAANG: Go vs. C++ Lock-Free in a Polyglot System

At L5+, the comparison between Go channels and C++ lock-free structures is an architectural question about where the critical path lives. The standard FAANG pattern: Go for the control plane and service logic (safe, fast enough), C++ for the data plane where microseconds matter (maximum control, no GC).

The performance crossover: a Go buffered channel handles approximately 10-20M operations per second at low thread counts before mutex contention becomes visible. A C++ lock-free SPSC queue handles 100-500M operations per second. If your service has a queue that handles less than 10M operations per second, a Go channel is sufficient and the simpler choice.

The decision to move a queue from Go to C++ is justified when: (1) the queue is on the critical path, (2) measurements show the channel is a bottleneck at production concurrency, and (3) the C++ lock-free implementation will be maintained by engineers who understand the correctness requirements. Condition 3 is the hardest to satisfy and is most often the deciding factor against the migration.

ADR framing: if the team does not have C++ engineers with lock-free expertise on-call, migrating to a C++ lock-free queue creates a critical path dependency on rare expertise. The risk of an undetected correctness bug or a maintenance engineer making a subtle ordering mistake outweighs the performance gain in most service contexts.

---
