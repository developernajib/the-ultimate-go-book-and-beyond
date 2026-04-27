export default `## 15.15 Interview Questions

Advanced concurrency questions target staff-level and senior-infra roles at FAANG, HFT, databases, and high-scale platform teams. Interviewers use them to separate candidates who have benchmarked lock-free code from those who merely read about it. The unifying test: whether you reach for a hand-rolled advanced primitive or for a well-worn standard answer (sharded mutex, \`sync.Map\`, \`errgroup\`, \`golang.org/x/sync/semaphore\`).

> **What FAANG actually tests here**: whether you know the ABA problem and its real mitigations, when sharding actually helps, what false sharing is and how to detect it, and the discipline to answer "what would you benchmark first" rather than "I would write a lock-free version".

### Question 1: Explain the ABA problem and how to solve it

**What FAANG expects**: a correct ABA scenario walk-through, at least two canonical mitigations (tagged pointers, hazard pointers, or epoch-based reclamation), and awareness that in Go the ABA problem rarely comes up in practice because the GC prevents pointer reuse while anything is still referencing an object.

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

\`\`\`go
// Tagged pointer solution
type TaggedValue struct {
    value   unsafe.Pointer
    version uint64
}

func CASTagged(addr *atomic.Uint64, old, new uint64) bool {
    return addr.CompareAndSwap(old, new)
}
\`\`\`

Note for Go specifically: ABA on raw pointer CAS is typically not an issue because the garbage collector keeps an object alive as long as any goroutine holds a reference to it, so you cannot actually get the "A-B-A" pointer recycling scenario the way you can in manual-memory languages. The problem still exists for value-level CAS loops (counters, version numbers), which is the common shape in Go.

**Follow-ups**:
- What is epoch-based reclamation, and how does it differ from hazard pointers?
- Why is ABA more relevant in C++ lock-free queues than in Go equivalents?

### Question 2: When would you use a sharded data structure over sync.Map?

**What FAANG expects**: correct sync.Map use cases (two optimized scenarios per the Go docs: write-once-read-many, and goroutines accessing disjoint key sets), plus awareness that a sharded \`[N]map+mutex\` design typically outperforms \`sync.Map\` on write-heavy workloads. Bonus: you know that Go 1.24 rewrote \`sync.Map\` internally on top of a concurrent hash-trie (HashTrieMap), which narrowed the gap with sharded designs, especially for write-heavy loads. HashTrieMap itself lives in \`internal/sync\` and is not exported for user code, the surface is still \`sync.Map\`.

**Answer:**
Use sharded data structures when:
1. **High write throughput**: sync.Map is optimized for read-heavy workloads
2. **Predictable performance**: Sharding gives consistent O(1) performance
3. **Custom key types**: sync.Map works with any key, but sharding can be optimized for specific types
4. **Memory control**: Sharded maps have more predictable memory usage

Use sync.Map when:
1. Keys are written once and read many times
2. Multiple goroutines read/write disjoint key sets
3. You need the standard library interface

**Follow-ups**:
- How many shards is too many? What does the contention profile look like when you over-shard?
- How would you pick a hash function for the shard index, and why does modulo by a power of two matter?

### Question 3: How does work stealing improve performance?

**What FAANG expects**: accurate description of the Go scheduler's work-stealing model (per-P local queues, steal-half from random victim), and the recognition that your user code benefits from it automatically via goroutines, you do not need to hand-roll it.

**Answer:**
Work stealing improves performance through:

1. **Load balancing**: Idle workers steal from busy ones, maximizing CPU utilization
2. **Cache locality**: Workers process their own tasks LIFO (most recent first), keeping data in cache
3. **Reduced contention**: Only stealing causes synchronization. Normal operations are lock-free
4. **Automatic adaptation**: Naturally balances heterogeneous workloads

\`\`\`
Performance comparison (1M tasks):
- Static partitioning: 2.5 seconds (uneven load)
- Work stealing:       0.8 seconds (balanced load)
\`\`\`

**Follow-ups**:
- What does the Go scheduler check first when a P runs out of work? (hint: not the random victim immediately)
- When would static partitioning beat work stealing?

### Question 4: What is false sharing and how do you prevent it?

**What FAANG expects**: correct definition (separate variables on the same 64-byte cache line causing cross-CPU invalidations), the \`[56]byte\` padding pattern, and the \`perf c2c\` or similar profiling approach to detect it in production. Bonus: you know Go 1.20+ has \`CacheLinePad\` in \`golang.org/x/sys/cpu\` for exactly this.

**Answer:**
False sharing occurs when different cores modify variables on the same cache line, causing cache invalidations even though they're accessing different memory locations.

**Prevention:**
\`\`\`go
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
\`\`\`

**Follow-ups**:
- How do you detect false sharing in a running service? What Linux perf counters would you reach for?
- When is the padding a waste of memory? (hint: low-contention, small N)

### Question 5: Design a rate limiter that handles 1M requests/second

**What FAANG expects**: sharding to avoid contention, awareness of clock-drift between shards, and a note that the bucket-index approach using \`runtime.NumGoroutine()\` is a weak distributor. A production design uses goroutine-local state, CPU-id hashing, or per-P storage (runtime hacks) for best distribution.

**Answer:**
\`\`\`go
type HighThroughputLimiter struct {
    // Sharded token buckets for parallelism
    buckets []*TokenBucket
    mask    int
}

func NewHighThroughputLimiter(rps int) *HighThroughputLimiter {
    numBuckets := 64 // Power of 2 for fast modulo
    rpsPerBucket := rps / numBuckets

    l := &HighThroughputLimiter{
        buckets: make([]*TokenBucket, numBuckets),
        mask:    numBuckets - 1,
    }

    for i := range l.buckets {
        l.buckets[i] = NewTokenBucket(rpsPerBucket, rpsPerBucket)
    }

    return l
}

func (l *HighThroughputLimiter) Allow() bool {
    // Use goroutine ID for bucket selection (approximation)
    id := runtime.NumGoroutine() & l.mask
    return l.buckets[id].Allow()
}
\`\`\`

Key design decisions:
- 64 shards for minimal contention
- Each shard handles 15,625 rps
- Lock-free token bucket per shard
- Uses runtime information for distribution

The \`runtime.NumGoroutine() & mask\` trick is a coarse distributor. For uniform load, hash a request-local identifier (request ID, connection fd, or trace ID) into the bucket index. For truly top-end throughput, look at how \`golang.org/x/time/rate\` and distributed limiters like \`lyft/ratelimit\` approach the same problem at scale.

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

**Answer**: Ask for profile evidence. In 2026 Go, \`sync.Map\` is well-tuned for its intended workload (read-mostly, stable keys). Beating it requires a workload that is specifically unsuited to \`sync.Map\` (balanced read/write, or keys updated frequently).

If profile evidence supports the claim, the next step is not a custom lock-free map. It is a sharded \`map[K]V\` with per-shard mutexes, which is simpler, easier to review, and usually competitive with lock-free alternatives. Reach for lock-free only if sharded still shows contention.

Most "we need to replace sync.Map" proposals fail on investigation: either the workload actually suits sync.Map, or a sharded alternative is sufficient. The staff-level response is to slow down the proposal, require evidence, and guide toward the simpler alternative.

---
`;
