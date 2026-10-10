## 15.13 Common Mistakes and Anti-Patterns

### Mistake 1: Lock-Free Without Understanding Memory Model

Writing lock-free code without understanding Go's memory model leads to data races. Plain integer fields are not atomic even on 64-bit hardware, and concurrent reads and writes need `sync/atomic` operations to establish the happens-before relationships that make writes visible across goroutines.

Be precise about why `c.value++` is wrong, because the usual explanation is the weaker one. Visibility is not the main problem here. `value++` is a read, an add, and a write, and two goroutines interleaving those three steps lose updates even on hardware with perfectly sequential memory ordering. It would still be broken on a machine that never reorders anything. Atomicity and ordering are separate properties, and this line fails the first one.

```go
// WRONG: read-modify-write is not atomic
type BrokenCounter struct {
    value int // Not atomic!
}

func (c *BrokenCounter) Increment() {
    c.value++ // DATA RACE, and lost updates even without reordering
}

// CORRECT: Use atomic operations
type SafeCounter struct {
    value atomic.Int64
}

func (c *SafeCounter) Increment() {
    c.value.Add(1)
}
```

### Mistake 2: Over-Engineering with Lock-Free

Lock-free data structures impose a real complexity cost. They are harder to reason about, harder to test, and harder to maintain. For configuration data that changes rarely, a `sync.RWMutex` gives you concurrent readers without CAS loops or reclamation schemes.

```go
// WRONG: hand-rolled lock-free structure for rarely changed data
type OverEngineeredConfig struct {
    // CAS loops, retry logic, and a reclamation scheme, to serve a map
    // that is written once at startup
}

// CORRECT: simple mutex for configuration
type SimpleConfig struct {
    mu     sync.RWMutex
    values map[string]string
}

func (c *SimpleConfig) Get(key string) string {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.values[key]
}
```

If a profile later shows that even the `RLock` is contended, the next step is still not a hand-rolled structure. Config is read-mostly and replaced wholesale, which is exactly what `atomic.Pointer[Config]` is for: readers `Load` with no lock at all, and a writer swaps in a fully built replacement. That is lock-free, it is four lines, and it is in the standard library. The mistake in this section is not "using lock-free techniques", it is *hand-rolling* them when the stdlib already has the pattern.

### Mistake 3: Wrong Shard Count

The optimal shard count balances lock contention against memory overhead: too few shards leave multiple goroutines competing for the same lock, while too many waste memory on empty shard structures. A common heuristic is `runtime.NumCPU() * 4`, which provides enough shards to keep all cores busy without excessive memory consumption.

```go
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
```

### Mistake 4: Ignoring False Sharing

Two atomic variables placed adjacent in memory share a 64-byte CPU cache line. Writes from one core invalidate that line on every other core, serializing operations that are logically independent. The two counters never touch each other's data, yet each write drags the other's cache line away.

The effect is real and worth measuring rather than asserting. Two goroutines each incrementing their own counter, differing only in whether the counters share a line, measured roughly 39ns per operation unpadded against 6ns padded: about a sixfold difference for identical instructions. Treat that as an illustration of the mechanism, not a constant. The penalty depends on core count, on which cores the goroutines land, and on the cache topology, and it collapses to nothing the moment the counters stop being hot. This is a real effect that is also frequently overstated, so measure your own case before spending 56 bytes per field on it.

```go
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
```

### Mistake 5: Spinning Without Backoff

A tight CAS retry loop saturates a CPU core and generates cache line traffic that slows down the very goroutine holding the lock. Backing off lets the holder finish its critical section instead of competing with the spinner for CPU.

```go
// WRONG: Busy spin wastes CPU
func badSpinLock(lock *atomic.Bool) {
    for !lock.CompareAndSwap(false, true) {
        // Burning CPU, and starving the holder we are waiting for
    }
}

// LESS WRONG: back off between attempts
func backoffSpinLock(lock *atomic.Bool) {
    // Start at a duration the runtime can actually deliver. time.Sleep
    // parks the goroutine and waits on a runtime timer, so a requested
    // 1ns costs microseconds. Asking for nanoseconds is asking for a
    // precision that does not exist.
    backoff := time.Microsecond
    for !lock.CompareAndSwap(false, true) {
        time.Sleep(backoff)
        backoff = min(backoff*2, time.Microsecond*100)
    }
}

// CORRECT: don't write a spinlock
var mu sync.Mutex
```

The framing of this mistake is a trap in itself. Adding backoff to a spinlock fixes the symptom and leaves the disease: you have hand-rolled a lock that is unfair, starves waiters, and assumes the holder is running on another core, which for a goroutine is not something you get to assume. The runtime can park the holder mid-critical-section, and then every spinner burns a core waiting for a goroutine that is not scheduled.

`sync.Mutex` already does the sophisticated version of this. It spins briefly, then parks the waiter so the core is released, and it has a starvation mode that hands the lock directly to a long waiter. It beats a hand-rolled spinlock in essentially every realistic case. The correct fix for "my spinlock burns CPU" is to delete the spinlock.

### The Biggest Mistake: Reaching for Advanced Techniques Too Early

The mistakes in this section are the consequence of one underlying mistake: using advanced concurrency techniques without profile evidence that simpler approaches are insufficient. A mutex that handles 100K ops/sec is rarely the bottleneck of a service that handles 1K requests/sec. The staff-level review question for any PR introducing lock-free code, sharding, or padding: "show me the profile that justifies this complexity". Without the profile, the PR is premature optimization.

### Staff Lens: Advanced Concurrency Review Bar

For any PR introducing techniques from this chapter, require:

1. **Profile evidence** showing the current primitive is a bottleneck.
2. **Benchmark** comparing the proposed technique to the simpler alternative.
3. **Correctness testing** under the race detector, stress testing, and (for production) a canary deployment.
4. **Maintenance owner** committed to the code for at least three years.

Teams that apply this bar avoid most advanced-concurrency bugs. Teams that do not ship subtle race conditions that surface months later under specific load conditions.

---
