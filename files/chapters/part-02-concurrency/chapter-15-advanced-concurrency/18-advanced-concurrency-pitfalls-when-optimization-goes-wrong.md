## Advanced Concurrency Pitfalls: When Optimization Goes Wrong

Advanced techniques are powerful but dangerous. These are real failures from production systems that tried to be too clever.

### The False Sharing Performance Trap

When two goroutines on different CPU cores write to variables that share the same 64-byte cache line, every write invalidates the entire line on all other cores. The result is counterintuitive: adding more cores makes the program slower, not faster. This is false sharing, and it is one of the most common silent performance killers in concurrent Go code.

```go
// DISASTROUS PERFORMANCE: False sharing
type BadCounters struct {
    reads   atomic.Int64  // These are on the same cache line!
    writes  atomic.Int64  // Every increment invalidates other CPU's cache
    errors  atomic.Int64
}

// Goroutines increment different counters and never touch each
// other's data, yet each write drags the shared line away from the
// other core. Adding cores can make this slower, not faster.

// WHY: CPU cache lines are typically 64 bytes
// When one CPU writes, it invalidates the cache line for all CPUs
// All CPUs must reload, even for "unrelated" variables

// CORRECT: Pad to separate cache lines
type GoodCounters struct {
    reads  atomic.Int64
    _pad1  [56]byte  // Pad to 64 bytes (cache line size)

    writes atomic.Int64
    _pad2  [56]byte

    errors atomic.Int64
    _pad3  [56]byte
}

// MEASURED (two goroutines, each incrementing its own counter):
// unpadded:  39.0 ns/op  <- false sharing
// padded:     6.0 ns/op  <- isolated
//
// About 6x for identical instructions. Real, but scale your
// expectations: the penalty depends on core count, on which cores
// the goroutines land, and on cache topology, and it vanishes the
// moment the counters stop being hot. Measure your own case.

// PRODUCTION PATTERN: use the portable padding helper
import "golang.org/x/sys/cpu"

type Counters struct {
    _      cpu.CacheLinePad
    reads  atomic.Int64
    _      cpu.CacheLinePad
    writes atomic.Int64
    _      cpu.CacheLinePad
    errors atomic.Int64
    _      cpu.CacheLinePad
}
```

### The Lock-Free Algorithm Bug

Lock-free algorithms must handle every possible interleaving, including a goroutine being descheduled between two dependent atomic writes. The Michael-Scott queue is the canonical answer, and the instructive part is what it does *not* try to prevent.

An enqueue in this family is two steps: link the new node onto `tail.next`, then advance `q.tail`. Those two steps cannot be made atomic together, so a goroutine can be paused between them, leaving `q.tail` lagging one node behind reality. The naive reading is that this "corrupts" the queue and the algorithm needs to prevent the gap.

It does not, and cannot. Michael-Scott's insight is to make the intermediate state *legal* and repairable rather than impossible. Any goroutine that finds `tail.next != nil` knows an enqueue is half-finished and **helps** by advancing `q.tail` itself before retrying. That is why the final `q.tail.CompareAndSwap(tail, node)` is best-effort and its result is ignored: if it fails, someone already helped. This is also exactly what makes the algorithm lock-free rather than merely lockless. A stalled enqueuer never blocks anyone, because progress does not depend on it waking up.

So do not read the tail lag as the bug. The genuine mistake is *omitting* the helping branch, which makes a paused goroutine block every subsequent enqueue.

The other detail worth naming is the `tail == q.tail.Load()` re-read. Without it, `tail` and `next` may be sampled from different logical states of the queue, and the decision that follows is made on an inconsistent snapshot.

```go
// Michael-Scott queue. In Go, the GC removes the node reclamation
// problem that makes this algorithm genuinely hard in C.
type MSQueue[T any] struct {
    head atomic.Pointer[msNode[T]]
    tail atomic.Pointer[msNode[T]]
}

type msNode[T any] struct {
    value T
    next  atomic.Pointer[msNode[T]]
}

func NewMSQueue[T any]() *MSQueue[T] {
    sentinel := &msNode[T]{}
    q := &MSQueue[T]{}
    q.head.Store(sentinel)
    q.tail.Store(sentinel)
    return q
}

func (q *MSQueue[T]) Enqueue(value T) {
    node := &msNode[T]{value: value}

    for {
        tail := q.tail.Load()
        next := tail.next.Load()

        // Re-read: without this, tail and next may come from different
        // states of the queue and the branch below decides on an
        // inconsistent snapshot.
        if tail == q.tail.Load() {
            if next == nil {
                if tail.next.CompareAndSwap(nil, node) {
                    // Best effort, and the failure is fine: if this CAS
                    // loses, another goroutine already helped us by
                    // advancing tail. Never retry it.
                    q.tail.CompareAndSwap(tail, node)
                    return
                }
            } else {
                // tail is lagging, so an enqueue is half-finished.
                // HELP it rather than waiting. Omitting this branch is
                // the real bug: it lets one descheduled goroutine block
                // every other enqueuer, which is the difference between
                // lock-free and merely lockless.
                q.tail.CompareAndSwap(tail, next)
            }
        }
    }
}
```

Better still, do not write this. A buffered channel is an MPMC queue the runtime team already wrote, tested, and optimized, and it blocks and selects properly. Reach for the Michael-Scott queue only when a profile proves the channel is your bottleneck, which for most services never happens.

### The Premature Optimization Disaster

The most damaging concurrency optimization is one applied to the wrong bottleneck. The case study below shows a developer replacing a mutex-based cache with an `atomic.Value` copy-on-write design, assuming lock contention was the problem. Profiling showed the cache was never the bottleneck at all: parsing dominated CPU time, the mutex was held for a couple of hundred nanoseconds, and the "optimization" added a full map copy to every write.

There is a second lesson buried in it. The rewrite does not just perform badly, **it panics on the first write**, and the reason is worth knowing:

```
panic: runtime error: comparing uncomparable type map[string]main.Item
```

`atomic.Value.CompareAndSwap` has to compare the old value with `==`, and maps are not comparable in Go, so the CAS panics the moment it is reached. The `Set` path below cannot execute even once. This is the compounding failure mode of speculative optimization: the developer rewrote working code to fix a bottleneck that did not exist, using a primitive whose constraints they had not read, and the result was a cache that could not store anything. Had they profiled first, none of it would have been written.

For a genuinely read-mostly cache the right tool is `atomic.Pointer[map[string]Item]`, which compares pointers rather than maps and cannot hit this. The copy-per-write cost remains, so it only pays when writes are rare.

```go
// WRONG: Assumed bottleneck, made it worse
// Developer thought: "Mutex is slow, I'll use atomics!"

// Original (works correctly, 50µs latency)
type SimpleCache struct {
    mu    sync.RWMutex
    items map[string]Item
}

func (c *SimpleCache) Get(key string) (Item, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    item, ok := c.items[key]
    return item, ok
}

// "Optimized" version: does not merely perform badly, it PANICS.
type BrokenOptimizedCache struct {
    items atomic.Value  // Stores map[string]Item
}

func (c *BrokenOptimizedCache) Get(key string) (Item, bool) {
    items := c.items.Load().(map[string]Item)
    item, ok := items[key]
    return item, ok
}

func (c *BrokenOptimizedCache) Set(key string, item Item) {
    for {
        old := c.items.Load().(map[string]Item)
        // BUG: Copy entire map for every write!
        newMap := make(map[string]Item, len(old)+1)
        for k, v := range old {
            newMap[k] = v
        }
        newMap[key] = item

        // PANIC: atomic.Value.CompareAndSwap compares with ==, and
        // maps are not comparable. This never even runs once:
        //   panic: comparing uncomparable type map[string]main.Item
        if c.items.CompareAndSwap(old, newMap) {
            return
        }
        // Retry on contention, which gets worse under load
    }
}

// ACTUAL PROFILING SHOWED:
// - Parsing, not the cache, dominated CPU time
// - Cache mutex was held for a couple hundred nanoseconds
// - The cache was never the bottleneck at all

// CORRECT: Profile first, then optimize the actual bottleneck
func optimizeCorrectly() {
    // 1. Profile
    // go test -cpuprofile=cpu.prof -bench=.
    // go tool pprof cpu.prof

    // 2. Find actual bottleneck
    // Turns out JSON unmarshaling is 95% of CPU

    // 3. Optimize the bottleneck
    // Use json-iterator or easyjson instead of encoding/json

    // Result: 10x improvement with zero concurrency changes
}
```

### The Work-Stealing Thrashing Problem

Work stealing pays for itself only when the per-task cost of executing work significantly exceeds the overhead of the stealing mechanism (atomic deque operations, random victim selection, cross-CPU cache misses). For very short tasks, a simple channel-based fan-out pool outperforms work stealing because channel sends are cheaper than the combined cost of maintaining per-worker deques.

```go
// PROBLEM: Work stealing overhead exceeds benefit
type OverEngineeredPool struct {
    workers []*stealingWorker
    // Complex work-stealing queues per worker
}

// For very short tasks the coordination cost dominates the work,
// and a plain channel fan-out wins. The crossover depends on your
// task duration and variance, so measure it rather than quoting a
// number: the point is that the curve exists and short tasks sit on
// the wrong side of it.

// WHY: Work stealing has overhead:
// 1. Atomic operations for deque manipulation
// 2. Random victim selection
// 3. Cache misses from cross-CPU access
// 4. Coordination overhead

// This overhead is only worthwhile for:
// - Tasks > 10µs
// - Unbalanced workloads
// - High CPU utilization needed

// CORRECT: Choose based on task characteristics
func selectPoolStrategy(avgTaskDuration time.Duration, taskCount int) WorkerPool {
    switch {
    case avgTaskDuration < 1*time.Microsecond:
        // Batch tasks, don't use pool
        return nil

    case avgTaskDuration < 100*time.Microsecond:
        // Simple channel pool - low overhead
        return NewChannelPool(runtime.GOMAXPROCS(0))

    case avgTaskDuration > 1*time.Millisecond:
        // Work stealing benefits long tasks
        return NewWorkStealingPool(runtime.GOMAXPROCS(0))

    default:
        // Default to simple pool
        return NewChannelPool(runtime.GOMAXPROCS(0))
    }
}
```

### The Unbounded Parallelism Cliff

Spawning a goroutine per work item is a real hazard, but almost every explanation of *why* is wrong, and the wrong explanation leads to the wrong fix. Get this one right, because it is the most common piece of Go folklore in circulation.

The folklore says goroutines thrash the scheduler and context-switch you to death, by analogy with thread-per-request in Java. Measure it and the analogy collapses. Running 2000 CPU-bound tasks of roughly 1ms each on 8 cores, once as a goroutine per task and once through a bounded pool:

```
unbounded (2000 goroutines): 257ms
bounded   (8 goroutines):    260ms
ratio: 0.99x
```

Identical. The unbounded version was marginally *faster*. Goroutines are not OS threads, a goroutine switch is a few register moves inside a thread rather than a kernel transition, and the runtime multiplexes 2000 of them onto 8 threads without breaking a sweat. Sizing goroutines to `GOMAXPROCS` for CPU-bound work buys nothing measurable, and "context switching overhead" is not the reason to bound anything in Go.

The real cost is **memory**, and it is not subtle. Two hundred thousand parked goroutines:

```
200001 live goroutines
stack in use: 391.2 MB (2051 bytes/goroutine)
```

Roughly 2KB of stack each, which is exactly the runtime's minimum (`stackMin = 2048`), and 391MB of live stacks for goroutines doing nothing at all. That is the cliff: not slow, but OOM-killed. And it gets worse when the work is I/O-bound, because each goroutine typically holds a connection, a buffer, and a request object, so the true footprint is many times the stack.

So bound fan-out for the reasons that are real. Memory, because every in-flight item costs at least a stack and usually far more. Downstream protection, because ten thousand goroutines mean ten thousand concurrent calls into a database that has a hundred connections. And backpressure, because an unbounded fan-out silently converts a queue you could observe into goroutines you cannot. Notice that all three are about *resources*, not scheduling, which is why the fix is a semaphore sized to the constrained resource, not to your core count.

```go
// WRONG: Assuming more goroutines = faster
func processAllBad(items []Item) {
    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(it Item) {
            defer wg.Done()
            process(it)  // CPU-bound work
        }(item)
    }
    wg.Wait()
}

// With 10,000 items on 8-core machine:
// - Creates 10,000 goroutines competing for 8 CPUs
// - Memory for goroutine stacks: ~20MB minimum, and that is the
//   actual problem. The scheduler handles the count fine, but the
//   resident memory is what kills the process.
// - Every item is in flight at once, so any downstream resource
//   (DB pool, API quota) sees 10,000 concurrent callers

// CORRECT: Bound parallelism to available resources
func processAllGood(items []Item) {
    numWorkers := runtime.GOMAXPROCS(0)
    itemsCh := make(chan Item, numWorkers*2)

    var wg sync.WaitGroup
    wg.Add(numWorkers)

    // Fixed number of workers
    for i := 0; i < numWorkers; i++ {
        go func() {
            defer wg.Done()
            for item := range itemsCh {
                process(item)
            }
        }()
    }

    // Feed items to workers
    for _, item := range items {
        itemsCh <- item
    }
    close(itemsCh)
    wg.Wait()
}

// MEASURED (2000 CPU-bound items @ ~1ms, 8 cores):
// Unbounded: 257ms
// Bounded:   260ms
//
// The runtimes are the same, because the Go scheduler is good at this.
// Bound the fan-out for memory and for downstream protection, and do
// not expect a speedup on CPU-bound work: you will not get one.
//
// Where bounding DOES buy throughput is I/O-bound work against a
// limited resource, because 10,000 goroutines queueing on a 100-
// connection pool add latency and memory without adding parallelism.
```

### Quick Reference: When to Use Advanced Techniques

| Technique | Use When | Avoid When |
|-----------|----------|------------|
| Lock-free | Profiling shows lock contention >50% | Default choice |
| Work stealing | Tasks vary widely in duration | Uniform short tasks |
| Sharding | Single lock is measured bottleneck | Few concurrent accesses |
| Custom scheduler | Standard pool inadequate (profiled) | Premature optimization |
| SIMD/vectorization | Same operation on large arrays | Complex branching logic |

### Staff Lens: Every Optimization Has a Cost

The pitfalls in this section share a theme: advanced concurrency techniques introduce complexity that is easy to underestimate. Reviewing code containing them takes longer, debugging them takes longer, onboarding engineers onto them takes longer. These are real ongoing costs that compound over the life of the codebase.

Before approving any advanced-concurrency PR, weigh the one-time performance gain against years of added complexity. The PR that makes the service 20% faster but takes twice as long to debug for the next three years is a net negative.

### Principal Lens: Optimization as Technical Debt

Every advanced concurrency technique is a form of technical debt: a speedup now paid for by ongoing complexity. Principal engineers should think about this as a ledger:

- **Credits:** throughput, latency, cost savings from the optimization.
- **Debits:** review time, debug time, onboarding cost, correctness risk.

The PR pays for itself only when credits exceed debits over the code's lifetime. Most advanced-concurrency optimizations do not pass this test for most services. Approve the ones that do. Reject the rest. This is unglamorous engineering discipline that keeps codebases maintainable over years.

---
