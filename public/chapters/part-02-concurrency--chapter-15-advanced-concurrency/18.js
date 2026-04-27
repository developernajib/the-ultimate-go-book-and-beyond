export default `## Advanced Concurrency Pitfalls: When Optimization Goes Wrong

Advanced techniques are powerful but dangerous. These are real failures from production systems that tried to be too clever.

### The False Sharing Performance Trap

When two goroutines on different CPU cores write to variables that share the same 64-byte cache line, every write invalidates the entire line on all other cores. The result is counterintuitive: adding more cores makes the program slower, not faster. This is false sharing, and it is one of the most common silent performance killers in concurrent Go code.

\`\`\`go
// DISASTROUS PERFORMANCE: False sharing
type BadCounters struct {
    reads   atomic.Int64  // These are on the same cache line!
    writes  atomic.Int64  // Every increment invalidates other CPU's cache
    errors  atomic.Int64
}

// With 8 goroutines incrementing different counters:
// Expected: 8x throughput
// Actual: 0.5x throughput (worse than single-threaded!)

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

// BENCHMARK COMPARISON:
// BenchmarkBadCounters-8     1000000    8500 ns/op  <- False sharing
// BenchmarkGoodCounters-8    1000000     180 ns/op  <- Isolated

// PRODUCTION PATTERN: Use struct alignment
type CacheLinePadded[T any] struct {
    value T
    _     [64 - unsafe.Sizeof(*new(T))%64]byte
}

type Counters struct {
    reads  CacheLinePadded[atomic.Int64]
    writes CacheLinePadded[atomic.Int64]
    errors CacheLinePadded[atomic.Int64]
}
\`\`\`

### The Lock-Free Algorithm Bug

Lock-free algorithms must handle every possible interleaving of concurrent operations, including crash points between two dependent atomic writes. The following example shows a common mistake in lock-free queue implementations where a crash between linking a new node and advancing the tail pointer leaves the queue in an inconsistent state. The corrected version uses the Michael-Scott queue pattern, where other goroutines can detect and repair an incomplete enqueue.

\`\`\`go
// BROKEN: Incorrect lock-free queue
type BrokenQueue struct {
    head atomic.Pointer[node]
    tail atomic.Pointer[node]
}

func (q *BrokenQueue) Push(value int) {
    n := &node{value: value}

    for {
        tail := q.tail.Load()
        next := tail.next.Load()

        if next == nil {
            // Try to link new node
            if tail.next.CompareAndSwap(nil, n) {
                // BUG: What if we crash here?
                // tail.next points to n, but q.tail still points to old tail
                q.tail.CompareAndSwap(tail, n)
                return
            }
        } else {
            // BUG: Another goroutine's push isn't complete
            // We should help it finish, not just retry
            q.tail.CompareAndSwap(tail, next)
        }
    }
}

// Problems:
// 1. Crash between updating next and tail = corrupted queue
// 2. No helping mechanism = livelock under contention
// 3. ABA problem not handled = potential corruption

// CORRECT: Use proven implementations
// Don't write your own lock-free data structures!
// Use: golang.org/x/sync or proven third-party libraries

// If you must, here's the Michael-Scott queue pattern:
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

        if tail == q.tail.Load() {  // Check tail hasn't changed
            if next == nil {
                if tail.next.CompareAndSwap(nil, node) {
                    q.tail.CompareAndSwap(tail, node)  // Best effort
                    return
                }
            } else {
                // Help other enqueue complete
                q.tail.CompareAndSwap(tail, next)
            }
        }
    }
}
\`\`\`

### The Premature Optimization Disaster

The most damaging concurrency optimization is one applied to the wrong bottleneck. The following case study shows a developer who replaced a mutex-based cache with an \`atomic.Value\`-based copy-on-write design, assuming lock contention was the problem. Profiling revealed that JSON parsing, not mutex acquisition, accounted for 95% of CPU time, and the "optimization" actually quadrupled latency by copying the entire map on every write.

\`\`\`go
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

// "Optimized" version (broken, 200µs latency due to bugs)
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

        if c.items.CompareAndSwap(old, newMap) {
            return
        }
        // Retry on contention - gets worse under load!
    }
}

// ACTUAL PROFILING SHOWED:
// - 95% of time spent in JSON parsing (not cache)
// - Cache mutex held for 200ns average
// - "Optimization" added 150µs of copying

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
\`\`\`

### The Work-Stealing Thrashing Problem

Work stealing pays for itself only when the per-task cost of executing work significantly exceeds the overhead of the stealing mechanism (atomic deque operations, random victim selection, cross-CPU cache misses). For very short tasks, a simple channel-based fan-out pool outperforms work stealing because channel sends are cheaper than the combined cost of maintaining per-worker deques.

\`\`\`go
// PROBLEM: Work stealing overhead exceeds benefit
type OverEngineeredPool struct {
    workers []*stealingWorker
    // Complex work-stealing queues per worker
}

// With 1000 tiny tasks (1µs each):
// - Simple channel-based pool: 2ms total
// - Work-stealing pool: 50ms total (25x slower!)

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
\`\`\`

### The Unbounded Parallelism Cliff

Spawning a goroutine per work item is the Go equivalent of creating a thread per request in Java, it works at low scale but collapses under load. For CPU-bound work, the optimal goroutine count equals the number of available cores. Any more and the scheduler spends time context-switching between goroutines rather than executing useful work.

\`\`\`go
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
// - Creates 10,000 goroutines
// - 10,000 goroutines compete for 8 CPUs
// - Context switching overhead dominates
// - Memory for goroutine stacks: ~20MB minimum

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

// BENCHMARK:
// 10,000 items, 8 cores, 1ms per item
// Unbounded: 12.5 seconds (context switch overhead)
// Bounded:   1.3 seconds  (optimal parallelism)
\`\`\`

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

- **Credits:** throughput, latency, cost savings from the optimisation.
- **Debits:** review time, debug time, onboarding cost, correctness risk.

The PR pays for itself only when credits exceed debits over the code's lifetime. Most advanced-concurrency optimisations do not pass this test for most services. Approve the ones that do; reject the rest. This is unglamorous engineering discipline that keeps codebases maintainable over years.

---
`;
