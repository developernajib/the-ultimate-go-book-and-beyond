## 80.4 Memory and Performance Questions

### Memory Model and GC

**Q: Explain Go's memory model. When are variables visible between goroutines?**

```go
package main

import (
    "sync"
    "sync/atomic"
)

// WRONG: No synchronization, behavior undefined
var a, b int

func wrongExample() {
    go func() { a = 1; b = 2 }()
    go func() { print(b); print(a) }()
    // Could print: 00, 01, 10, 02, 12, 20, 21
    // Memory reordering is allowed!
}

// Happens-Before Guarantees:

// 1. Channel send happens-before receive completes
func channelSync() {
    var data int
    done := make(chan bool)

    go func() {
        data = 42          // 1. Write data
        done <- true       // 2. Send (synchronizes)
    }()

    <-done                 // 3. Receive completes (happens after 2)
    print(data)            // 4. Safe to read (guaranteed 42)
}

// 2. Mutex unlock happens-before next lock
func mutexSync() {
    var mu sync.Mutex
    var data int

    go func() {
        mu.Lock()
        data = 42
        mu.Unlock()  // Happens-before next Lock
    }()

    mu.Lock()        // Happens-after previous Unlock
    print(data)      // Safe read
    mu.Unlock()
}

// 3. sync.Once function happens-before Do returns
var once sync.Once
var config string

func onceSync() {
    once.Do(func() {
        config = "initialized"
    })
    print(config)  // Guaranteed to see "initialized"
}

// 4. Atomic operations provide ordering
var ready atomic.Bool
var data int

func atomicSync() {
    go func() {
        data = 42
        ready.Store(true)  // Release semantics
    }()

    for !ready.Load() {}   // Acquire semantics
    print(data)            // Safe - guaranteed 42
}
```

**Key Points:**
1. Without synchronization, no ordering guarantees between goroutines
2. Channel operations, mutex lock/unlock, atomic operations provide happens-before
3. The "Go Memory Model" document is the authoritative source
4. Compiler and CPU can reorder operations unless synchronized

---

**Q: How does Go's garbage collector work? How do you optimize for it?**

```go
package main

import (
    "runtime"
    "runtime/debug"
    "sync"
)

func main() {
    // GC Stats
    var stats debug.GCStats
    debug.ReadGCStats(&stats)

    // Force GC (rarely needed)
    runtime.GC()

    // Set GC target percentage (default 100)
    // Higher = less frequent GC, more memory
    // Lower = more frequent GC, less memory
    debug.SetGCPercent(50)

    // Set memory limit (Go 1.19+)
    debug.SetMemoryLimit(1 << 30)  // 1GB
}

// GC Optimization Patterns

// 1. Reduce allocations with sync.Pool
var bufferPool = sync.Pool{
    New: func() any {
        return make([]byte, 4096)
    },
}

func processWithPool(data []byte) []byte {
    buf := bufferPool.Get().([]byte)
    defer bufferPool.Put(buf)

    // Use buf...
    copy(buf, data)
    return buf[:len(data)]
}

// 2. Pre-allocate slices
func goodAllocation(n int) []int {
    result := make([]int, 0, n)  // Allocate once
    for i := 0; i < n; i++ {
        result = append(result, i)
    }
    return result
}

func badAllocation(n int) []int {
    var result []int  // Multiple reallocations
    for i := 0; i < n; i++ {
        result = append(result, i)  // Grows and copies
    }
    return result
}

// 3. Avoid pointer-heavy structures (more GC scanning)
type BadStruct struct {
    data [100]*int  // GC must scan all 100 pointers
}

type GoodStruct struct {
    data [100]int   // No pointers, GC skips
}

// 4. Reduce escape to heap
func noEscape() int {
    x := 42    // Stays on stack
    return x
}

func escapes() *int {
    x := 42    // Escapes to heap
    return &x  // Pointer to local
}

// 5. Use value receivers when possible
type Value struct{ x int }

func (v Value) Method() int { return v.x }   // No allocation
func (v *Value) PtrMethod() int { return v.x }  // May need allocation
```

**GC Characteristics:**
```
┌───────────────────────────────────────────────────────────────┐
│                    Go GC (Concurrent, Tri-color)              │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  Phase 1: Mark Start (STW ~10-30μs)                           │
│  ├── Enable write barrier                                     │
│  └── Start concurrent marking                                 │
│                                                               │
│  Phase 2: Concurrent Mark                                     │
│  ├── Mark goroutines assist (25% CPU)                         │
│  └── Application runs concurrently                            │
│                                                               │
│  Phase 3: Mark Termination (STW ~10-30μs)                     │
│  ├── Drain remaining work                                     │
│  └── Disable write barrier                                    │
│                                                               │
│  Phase 4: Concurrent Sweep                                    │
│  └── Reclaim memory concurrently                              │
│                                                               │
│  Target: < 500μs STW per cycle                                │
│  Trigger: 100% heap growth (GOGC=100)                         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

### Escape Analysis

**Q: What is escape analysis and how does it affect performance?**

```go
package main

// View escape analysis: go build -gcflags="-m"

// Does NOT escape - stays on stack
func noEscape() int {
    x := 42
    return x  // Value copied, original stays on stack
}

// ESCAPES - must allocate on heap
func escapes() *int {
    x := 42
    return &x  // Pointer to local returned
}

// ESCAPES - interface parameter often causes escape
func interfaceEscape(v any) {
    _ = v  // v might be boxed on heap
}

// Does NOT escape with concrete type
func concreteNoEscape(v int) {
    _ = v  // Known size, stack allocated
}

// ESCAPES - slice grows beyond known bounds
func sliceEscapes() []int {
    s := make([]int, 0)
    for i := 0; i < 100; i++ {
        s = append(s, i)  // May grow unpredictably
    }
    return s
}

// Does NOT escape - known size
func sliceNoEscape() []int {
    s := make([]int, 100)  // Known size
    return s  // Still escapes due to return, but...
}

// ESCAPES - captured by closure
func closureEscape() func() int {
    x := 42
    return func() int {
        return x  // x captured, must live beyond function
    }
}

// ESCAPES - sent to channel
func channelEscape(ch chan *int) {
    x := 42
    ch <- &x  // Must live beyond function
}

// Benchmark to show the difference
func BenchmarkStack(b *testing.B) {
    for b.Loop() {
        x := 42
        _ = x
    }
}

func BenchmarkHeap(b *testing.B) {
    for b.Loop() {
        x := new(int)
        *x = 42
        _ = x
    }
}
// Stack is 10-100x faster than heap allocation
```

**Interview Tips:**
1. Use `go build -gcflags="-m"` to see escape decisions
2. Stack allocation is cheaper (just move stack pointer)
3. Heap allocation needs GC
4. Common escapes: returning pointers, interfaces, closures, channels
5. Optimization: minimize escapes in hot paths

---

### Junior → FAANG: Memory Questions Are Closer to Algorithms Than You Think

Many junior Go candidates underestimate memory and performance questions, treating them as advanced or optional. In reality, FAANG interviews at the SDE II equivalent (L4/L5 entry) regularly surface questions about escape analysis, stack versus heap allocation, and GC pressure, especially in backend or infrastructure roles.

The most important concept to understand concretely: escape analysis. Run `go build -gcflags='-m'` on a small program and trace which allocations escape to the heap. Do this ten times with different patterns (returning a pointer, storing in an interface, closing over a variable) until the rules are internalized rather than memorized.

First-job framing: at a junior level in production Go, memory performance work is almost never premature optimization. It is standard practice for services handling more than a few thousand requests per second. Demonstrating awareness of allocation patterns signals that you are not going to write code that works in testing but degrades under load.

### Senior @ FAANG: Memory Performance as Platform Infrastructure Thinking

For L5 and above, memory and performance questions probe whether you can make system-wide performance decisions, not just optimize a function in isolation. The question "how would you reduce GC pressure in this service" has a tactical answer (use `sync.Pool`, avoid interface boxing in hot paths, preallocate slices) but also a strategic answer (profile first with pprof, measure p99 latency and GC pause times, set goals before optimizing, and document the before/after in a design doc).

ADR-level thinking on memory: a staff engineer at FAANG should be able to articulate "we evaluated three allocation strategies for this hot path: fresh allocation per request, object pooling via `sync.Pool`, and arena-style bump allocation. We chose `sync.Pool` because it is safe across GC cycles, has acceptable throughput, and requires no manual memory management." This is the level of reasoning that L6 bar-raisers listen for.

Maturity model for performance at FAANG: L4 candidates know that GC pauses exist. L5 candidates know how to measure them with `GODEBUG=gctrace=1` and `pprof`. L6 candidates have used those measurements to drive architectural decisions (switching to a streaming response model to avoid buffering large responses, redesigning a cache to use `sync.Pool` to eliminate allocation spikes). L7/Staff candidates own the performance observability infrastructure for their platform, define SLOs for allocation budgets per RPC, and review system designs for memory implications before they reach production.
