## 15.15 Interview Questions

Advanced concurrency questions target staff-level and senior-infra roles at FAANG, HFT, databases, and high-scale platform teams. Interviewers use them to separate candidates who have benchmarked lock-free code from those who merely read about it. The unifying test: whether you reach for a hand-rolled advanced primitive or for a well-worn standard answer (sharded mutex, `sync.Map`, `errgroup`, `golang.org/x/sync/semaphore`).

> **What FAANG actually tests here**: whether you know the ABA problem and its real mitigations, when sharding actually helps, what false sharing is and how to detect it, and the discipline to answer "what would you benchmark first" rather than "I would write a lock-free version".

### Question 1: Explain the ABA problem and how to solve it

**What FAANG expects**: a correct ABA scenario walk-through, at least two canonical mitigations (tagged pointers, hazard pointers, or epoch-based reclamation), and precision about what Go's GC does and does not remove. The candidates who stand out are the ones who split ABA into its two halves rather than waving at the garbage collector.

**Answer:**
The ABA problem occurs in lock-free programming when:
1. Thread 1 reads value A from location X
2. Thread 1 is preempted
3. Thread 2 changes X from A to B, then back to A
4. Thread 1 resumes and sees A, assuming nothing changed
5. CAS succeeds but the assumption is wrong

**Solutions:**
- **Tagged pointers**: Combine pointer with version number
- **Hazard pointers**: Track which pointers are in use
- **Epoch-based reclamation**: Defer memory reuse until safe

```go
// Version the thing you CAS on, so the comparison covers both.
// Each update allocates a fresh head record, so a successful CAS
// proves nothing changed underneath us.
type stackHead[T any] struct {
    node    *Node[T]
    version uint64
}

type Stack[T any] struct {
    head atomic.Pointer[stackHead[T]]
}
```

**The Go-specific part, stated carefully.** This is where most candidates lose the question, because the popular version of the answer is wrong. The claim "Go's GC prevents ABA" is false, and an interviewer who knows the area will push on it.

Split ABA into two halves:

- **Memory reclamation (use-after-free).** Go's GC *does* eliminate this. A node you hold a pointer to cannot be freed, and its address cannot be recycled into a different object underneath you. This is the half that makes ABA so dangerous in C and C++, and it is genuinely gone.
- **Logical ABA.** Untouched. If another goroutine pops A, pops B, and pushes *the same node A* back, then `head` is A again, your CAS on the pointer succeeds, and you install a `next` you read from a stale state. The node is perfectly alive the whole time. Nothing about the GC prevents this, and it resurrects an already-popped node.

The mitigation is to CAS on something that carries a version, as above. Note the trap that catches people: adding a `version atomic.Uint64` field *next to* the pointer and incrementing it does nothing at all, because `CompareAndSwap` compares only the pointer. A version the CAS never reads cannot reject anything. Section 15.1 walks through the failing interleaving.

**Follow-ups**:
- Which half of ABA does Go's GC actually remove, and which does it leave?
- Why does incrementing a separate version counter fail to fix ABA?
- What is epoch-based reclamation, and how does it differ from hazard pointers?

### Question 2: When would you use a sharded data structure over sync.Map?

**What FAANG expects**: correct `sync.Map` use cases (the two scenarios the Go docs call out: write-once-read-many, and goroutines accessing disjoint key sets), and calibration about how big the difference actually is. Bonus: you know that Go 1.24 replaced `sync.Map`'s internals with a concurrent hash-trie (`HashTrieMap`), which narrowed the gap with sharded designs. `HashTrieMap` lives in `internal/sync` and is not exported, so the public surface is still `sync.Map`.

**Answer:**
Use sharded data structures when:
1. **Sustained key churn**: constant creation of new keys is `sync.Map`'s weak spot, since growing and rebalancing trie structure is its most expensive path
2. **Custom hashing or per-shard behaviour**: you want typed keys, a specific hash, or per-shard eviction and metrics
3. **Predictable memory**: sharded maps have more obvious memory behaviour and can be sized per shard

Use `sync.Map` when:
1. Keys are written once and read many times
2. Multiple goroutines read and write disjoint key sets
3. You want the standard library and no custom code to maintain, which is the default answer

**The calibration that separates candidates.** "Sharded beats `sync.Map` on write-heavy workloads" is repeated constantly and is much weaker than people think, especially since 1.24. Measured across a shared key space on an 8-thread machine, sharded lost at 1% writes by roughly 2x, lost at 50% writes, drew at 90% writes, and won by only about 15% on pure new-key churn. The crossover exists, but it sits far further toward churn than the folklore suggests, and the margin past it is small. Saying "it depends on the write ratio, and I would measure my own" is a better answer than naming a winner.

Watch what you are actually measuring, too. The naive generic shard hash routes keys through `fmt.Sprintf("%v", key)`, which allocates per lookup and cost more than the locking it was being blamed on. `maphash.Comparable` removes that.

**Follow-ups**:
- How many shards is too many? What does the profile look like when you over-shard?
- How does the hash-trie design handle concurrent writes to the same key range, and where does it still serialize?
- How would you pick a hash for the shard index, and why does a power-of-two count matter?

### Question 3: How does work stealing improve performance?

**What FAANG expects**: accurate description of the Go scheduler's work-stealing model (per-P local queues, steal-half from random victim), and the recognition that your user code benefits from it automatically via goroutines, you do not need to hand-roll it.

**Answer:**
Work stealing improves performance through:

1. **Load balancing**: Idle workers steal from busy ones, maximizing CPU utilization
2. **Cache locality**: Workers process their own tasks LIFO (most recent first), keeping data in cache
3. **Reduced contention**: Only stealing causes synchronization. Normal operations are lock-free
4. **Automatic adaptation**: Naturally balances heterogeneous workloads

The size of the win depends entirely on how uneven the work is. With uniform task durations, static partitioning matches work stealing and costs less. The more the durations vary, the more static partitioning is held hostage by its unluckiest partition while other workers sit idle, and that gap is what work stealing closes. Quote a mechanism, not a number: an interviewer asking for "the speedup" is checking whether you know it depends on the distribution.

**Follow-ups**:
- What does the Go scheduler check first when a P runs out of work? (hint: not the random victim immediately)
- When would static partitioning beat work stealing?

### Question 4: What is false sharing and how do you prevent it?

**What FAANG expects**: correct definition (separate variables on the same 64-byte cache line causing cross-CPU invalidations), the `[56]byte` padding pattern, and the `perf c2c` or similar profiling approach to detect it in production. Bonus: you know the `golang.org/x/sys/cpu` package provides `CacheLinePad` for exactly this.

**Answer:**
False sharing occurs when different cores modify variables on the same cache line, causing cache invalidations even though they're accessing different memory locations.

**Prevention:**
```go
// Bad: a and b share cache line
type Bad struct {
    a int64 // 8 bytes
    b int64 // 8 bytes - same cache line!
}

// Good: padding separates cache lines
type Good struct {
    a int64
    _ [56]byte // Pad to 64-byte cache line
    b int64
    _ [56]byte
}

// Or use the portable helper from golang.org/x/sys/cpu:
import "golang.org/x/sys/cpu"

type Counter struct {
    _ cpu.CacheLinePad
    value atomic.Int64
    _ cpu.CacheLinePad
}
```

**Follow-ups**:
- How do you detect false sharing in a running service? What Linux perf counters would you reach for?
- When is the padding a waste of memory? (hint: low-contention, small N)

### Question 5: Design a rate limiter that handles 1M requests/second

**What FAANG expects**: sharding to avoid contention, a *working* distributor, and awareness that splitting the rate across buckets splits the budget too. The strongest signal is a candidate who catches the `runtime.NumGoroutine()` selector, which is a well-travelled piece of bad advice.

**The version to critique:**
```go
func (l *HighThroughputLimiter) Allow() bool {
    // BROKEN: NumGoroutine is a gauge, not an identity
    id := runtime.NumGoroutine() & l.mask
    return l.buckets[id].Allow()
}
```

`runtime.NumGoroutine()` returns how many goroutines exist. Every goroutine calling it at the same instant reads the *same* number and picks the *same* bucket. A quick test appears to disprove this, showing traffic spread across buckets, but that spread comes entirely from goroutines starting and exiting and moving the gauge. Hold the goroutine count steady, which is what a saturated server at 1M rps looks like, and the measurement is unambiguous: 1 of 16 buckets touched, every single request on one shard. You have paid for 64 buckets, kept the contention of one, and capped yourself at one bucket's budget.

**The version to propose:**
```go
type HighThroughputLimiter struct {
    buckets []*TokenBucket
    mask    uint32
}

func NewHighThroughputLimiter(rps int) *HighThroughputLimiter {
    numBuckets := 64 // Power of 2, so & mask replaces %
    l := &HighThroughputLimiter{
        buckets: make([]*TokenBucket, numBuckets),
        mask:    uint32(numBuckets - 1),
    }
    // Each bucket gets an equal slice of the global budget.
    rpsPerBucket := rps / numBuckets
    for i := range l.buckets {
        l.buckets[i] = NewTokenBucket(rpsPerBucket, rpsPerBucket)
    }
    return l
}

func (l *HighThroughputLimiter) Allow() bool {
    // math/rand/v2 top-level funcs read a per-thread runtime source:
    // no lock, no shared state, well distributed.
    return l.buckets[rand.Uint32()&l.mask].Allow()
}
```

Key design decisions, and the trade-off each one buys:
- 64 buckets removes the single-cache-line bottleneck. The count should come from a contention profile, not from a round number.
- Each bucket holds 1/64th of the budget, which is the real cost of this design. The limiter is now only approximate: unlucky distribution can reject a request while other buckets hold idle tokens, so it under-admits near the limit. At 1M rps the error is noise. At 100 rps across 64 buckets it is a broken limiter, which is why sharding a *small* limit is a mistake.
- Go exposes no goroutine ID by design, so per-goroutine affinity is not available. `sync.Pool` gets true per-P storage through `runtime_procPin`, which is internal to the standard library. Statistical spread via `rand.Uint32` is the honest public answer.

For the real thing, `golang.org/x/time/rate` is the standard in-process limiter, and distributed limiters solve the cross-pod version.

**Follow-ups**:
- How would you enforce a *global* 1M RPS across 100 pods rather than per-pod?
- When does the shard approach start losing to a single central limiter backed by atomics?

### Q (Staff track): When would you approve a PR that introduces a lock-free data structure?

**What FAANG expects at staff**: a high bar with specific criteria, not handwaving.

**Answer**: All of these must be true:

1. Profile evidence shows the current (mutex-based) primitive is the bottleneck.
2. Benchmarks show the lock-free version is measurably faster under the real workload, not just microbenchmarks.
3. The algorithm is from a published, peer-reviewed source, not invented on the spot.
4. At least two reviewers with lock-free experience have verified correctness.
5. The implementation passes the race detector, long-running stress tests, and canary deployment.
6. A named owner commits to maintaining it for three years minimum.

Lock-free code that fails any of these criteria is a time bomb. Better to say no and use a mutex than to approve something the team cannot safely maintain.

### Q (Staff track): A team proposes replacing sync.Map with a custom lock-free map for "better performance". How do you respond?

**Answer**: Ask for profile evidence. In 2026 Go, `sync.Map` is well-tuned for its intended workload (read-mostly, stable keys). Beating it requires a workload that is specifically unsuited to `sync.Map` (balanced read/write, or keys updated frequently).

If profile evidence supports the claim, the next step is not a custom lock-free map. It is a sharded `map[K]V` with per-shard mutexes, which is simpler, easier to review, and usually competitive with lock-free alternatives. Reach for lock-free only if sharded still shows contention.

Most "we need to replace sync.Map" proposals fail on investigation: either the workload actually suits sync.Map, or a sharded alternative is sufficient. The staff-level response is to slow down the proposal, require evidence, and guide toward the simpler alternative.

---
