export default `## 15.13 Common Mistakes and Anti-Patterns

### Mistake 1: Lock-Free Without Understanding Memory Model

Writing lock-free code without understanding Go's memory model leads to data races that are invisible to the programmer but detected by the race detector at runtime. Plain integer fields are not atomic even on 64-bit hardware, concurrent reads and writes require \`sync/atomic\` operations to establish the happens-before relationships that make writes visible across goroutines.

\`\`\`go
// WRONG: Assumes sequential consistency
type BrokenCounter struct {
    value int // Not atomic!
}

func (c *BrokenCounter) Increment() {
    c.value++ // DATA RACE!
}

// CORRECT: Use atomic operations
type SafeCounter struct {
    value atomic.Int64
}

func (c *SafeCounter) Increment() {
    c.value.Add(1)
}
\`\`\`

### Mistake 2: Over-Engineering with Lock-Free

Lock-free data structures impose significant complexity cost, they are harder to reason about, harder to test, and harder to maintain. For configuration data that changes infrequently, a simple \`sync.RWMutex\` with multiple concurrent readers provides excellent throughput without the implementation complexity of CAS loops and memory barriers.

\`\`\`go
// WRONG: Lock-free for simple operations is overkill
type OverEngineeredConfig struct {
    // Complex lock-free structure for rarely changed data
}

// CORRECT: Simple mutex for configuration
type SimpleConfig struct {
    mu     sync.RWMutex
    values map[string]string
}

func (c *SimpleConfig) Get(key string) string {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.values[key]
}
\`\`\`

### Mistake 3: Wrong Shard Count

The optimal shard count balances lock contention against memory overhead: too few shards leave multiple goroutines competing for the same lock, while too many waste memory on empty shard structures. A common heuristic is \`runtime.NumCPU() * 4\`, which provides enough shards to keep all cores busy without excessive memory consumption.

\`\`\`go
// WRONG: Too few shards for high concurrency
type BadSharding struct {
    shards [2]shard // Only 2 shards!
}

// WRONG: Too many shards wasting memory
type TooManyShards struct {
    shards [10000]shard // Excessive!
}

// CORRECT: Scale with CPU count
type RightSharding struct {
    shards []shard // runtime.NumCPU() * 4
}
\`\`\`

### Mistake 4: Ignoring False Sharing

Two atomic variables placed adjacent in memory likely share a 64-byte CPU cache line. Writes from one core invalidate the entire cache line on all other cores, serializing what should be independent operations. Padding each variable to a full 64-byte boundary eliminates the cross-core invalidation and can yield order-of-magnitude throughput improvements under high contention.

\`\`\`go
// WRONG: Adjacent atomic values in same cache line
type BadCounters struct {
    a atomic.Int64
    b atomic.Int64 // False sharing with 'a'!
}

// CORRECT: Padding to separate cache lines
type GoodCounters struct {
    a atomic.Int64
    _ [56]byte // 64 - 8 = 56 byte padding
    b atomic.Int64
    _ [56]byte
}
\`\`\`

### Mistake 5: Spinning Without Backoff

A tight CAS retry loop saturates a CPU core and generates excessive cache line traffic that slows down the very goroutine holding the lock. Exponential backoff with a small initial delay allows the holder to complete its critical section and release the lock without competing with the spinner for CPU time.

\`\`\`go
// WRONG: Busy spin wastes CPU
func badSpinLock(lock *atomic.Bool) {
    for !lock.CompareAndSwap(false, true) {
        // Burning CPU!
    }
}

// CORRECT: Exponential backoff
func goodSpinLock(lock *atomic.Bool) {
    backoff := time.Nanosecond
    for !lock.CompareAndSwap(false, true) {
        time.Sleep(backoff)
        backoff = min(backoff*2, time.Microsecond*100)
    }
}
\`\`\`

### The Biggest Mistake: Reaching for Advanced Techniques Too Early

The mistakes in this section are the consequence of one underlying mistake: using advanced concurrency techniques without profile evidence that simpler approaches are insufficient. A mutex that handles 100K ops/sec is rarely the bottleneck of a service that handles 1K requests/sec. The staff-level review question for any PR introducing lock-free code, sharding, or padding: "show me the profile that justifies this complexity". Without the profile, the PR is premature optimisation.

### Staff Lens: Advanced Concurrency Review Bar

For any PR introducing techniques from this chapter, require:

1. **Profile evidence** showing the current primitive is a bottleneck.
2. **Benchmark** comparing the proposed technique to the simpler alternative.
3. **Correctness testing** under the race detector, stress testing, and (for production) a canary deployment.
4. **Maintenance owner** committed to the code for at least three years.

Teams that apply this bar avoid most advanced-concurrency bugs. Teams that do not ship subtle race conditions that surface months later under specific load conditions.

---
`;
