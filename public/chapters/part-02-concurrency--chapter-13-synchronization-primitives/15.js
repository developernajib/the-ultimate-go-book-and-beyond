export default `## 13.14 Interview Questions

Synchronization questions separate candidates who memorize primitive names from those who can pick between mutex, RWMutex, atomic, sync.Once, and channel-based coordination with numbers and tradeoffs in hand. Expect the race detector and contention profile to come up.

> **What FAANG actually tests here**: correctness under concurrency, ability to recognize deadlock shapes from code, and the judgment to reach for the cheapest primitive that is still safe. Hand-rolled lock-free code is almost always the wrong answer unless you can justify it against a benchmark.

### Question 1: Mutex vs RWMutex Trade-offs

**What FAANG expects**: a numerical read-to-write ratio threshold, awareness that RWMutex has higher per-op overhead than Mutex, and knowledge that RWMutex read-locks do not stack infinitely (heavy writer starvation or long critical sections can reverse the verdict).

**Q: When would you choose sync.Mutex over sync.RWMutex, and vice versa?**

**A:** The choice hinges on read/write ratio and how long each critical section takes. \`RWMutex\` adds roughly 30 to 40 percent overhead per lock operation compared to \`Mutex\` on microbenchmarks, so it only wins when enough concurrent readers exist to offset that cost through parallelism. Most measured Go code needs above 90 percent reads plus non-trivial critical section duration before RWMutex beats Mutex.

\`\`\`go
// Use Mutex when:
// 1. Write-heavy workloads (>30% writes)
// 2. Very short critical sections (< 100ns)
// 3. Uncertain about access patterns
// 4. Simplicity is preferred

type Counter struct {
    mu    sync.Mutex  // Mutex: writes frequent, operation trivial
    value int64
}

// Use RWMutex when:
// 1. Read-heavy workloads (>90% reads)
// 2. Longer critical sections benefit from parallel reads
// 3. High read contention
// 4. Performance testing confirms benefit

type Cache struct {
    mu    sync.RWMutex  // RWMutex: many readers, few writers
    items map[string]Item
}

// RWMutex has ~30-40% more overhead per operation
// Only wins when parallel reads compensate for overhead
\`\`\`

**Follow-ups**:
- Can a writer starve under RWMutex? What does the Go implementation do about it?
- Under what contention profile does a sharded \`Mutex\` beat a single \`RWMutex\`?

### Question 2: Implementing a Thread-Safe Singleton

**What FAANG expects**: you know \`sync.Once\` is the idiomatic answer, you recognize that \`OnceValue\` and \`OnceValues\` (Go 1.21+) eliminate the boilerplate entirely, and you can pick \`atomic.Pointer[T]\` when the singleton must be swappable.

**Q: Implement a thread-safe singleton pattern in Go.**

**A:** Go offers four approaches, each suited to a different situation. \`sync.Once\` is the classic choice: it guarantees the initializer runs exactly once with no lock on subsequent accesses. Since Go 1.21, \`sync.OnceValue\` and \`sync.OnceValues\` wrap this pattern into a helper that returns the initialized value directly. \`init()\` is even simpler but runs at program startup regardless of whether the value is ever needed. An \`atomic.Pointer\` is best when the singleton must be swappable at runtime, such as during configuration hot-reload.

\`\`\`go
// Method 1: sync.Once (recommended)
type Database struct {
    conn *sql.DB
}

var (
    dbInstance *Database
    dbOnce     sync.Once
)

func GetDatabase() *Database {
    dbOnce.Do(func() {
        conn, _ := sql.Open("postgres", "...")
        dbInstance = &Database{conn: conn}
    })
    return dbInstance
}

// Method 2: init() function (simpler but less flexible)
var db *Database

func init() {
    conn, _ := sql.Open("postgres", "...")
    db = &Database{conn: conn}
}

// Method 3: Atomic pointer (for hot-reload scenarios)
var dbPtr atomic.Pointer[Database]

func GetDB() *Database {
    return dbPtr.Load()
}

func SetDB(db *Database) {
    dbPtr.Store(db)
}

// Method 4: sync.OnceValue (Go 1.21+, cleanest)
var getDatabase = sync.OnceValue(func() *Database {
    conn, _ := sql.Open("postgres", "...")
    return &Database{conn: conn}
})
// Call getDatabase() anywhere. First call initializes; all subsequent calls
// return the cached value with no locking on the fast path.
\`\`\`

**Follow-ups**:
- What happens if the function passed to \`sync.Once.Do\` panics? Is \`Do\` callable again?
- How would you lazily initialize a value that can fail and should be retried on failure?

### Question 3: Deadlock Detection

**What FAANG expects**: you spot the "two resources acquired in opposite orders" shape on sight, can state the correct fix (consistent global ordering) without hesitation, and know that \`go test -race\` does not detect deadlocks (it finds data races, not stuck locks).

**Q: What causes this code to deadlock and how do you fix it?**

\`\`\`go
func transfer(from, to *Account, amount int64) {
    from.mu.Lock()
    defer from.mu.Unlock()

    to.mu.Lock()
    defer to.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}
\`\`\`

**A:**

\`\`\`go
// Deadlock occurs when:
// Goroutine 1: transfer(A, B, 100)  - locks A, waits for B
// Goroutine 2: transfer(B, A, 50)   - locks B, waits for A

// Fix 1: Consistent lock ordering
func transfer(from, to *Account, amount int64) {
    // Always lock lower address first
    first, second := from, to
    if uintptr(unsafe.Pointer(from)) > uintptr(unsafe.Pointer(to)) {
        first, second = to, from
    }

    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}

// Fix 2: Global transaction lock (simpler, less concurrent)
var txLock sync.Mutex

func transfer(from, to *Account, amount int64) {
    txLock.Lock()
    defer txLock.Unlock()

    from.balance -= amount
    to.balance += amount
}
\`\`\`

**Follow-ups**:
- How does Go's runtime report a deadlock when every goroutine is blocked? What is the "all goroutines are asleep" panic?
- When is a global lock the right answer despite hurting concurrency?

### Question 4: sync.Pool Use Cases

**What FAANG expects**: the GC-clearable semantics, why that disqualifies pools for resources needing explicit cleanup, and the right use case (per-request buffers and temporaries). Bonus: you know the per-P local caches and the victim cache added in Go 1.13.

**Q: Why is sync.Pool unsuitable for connection pooling?**

**A:** The garbage collector is free to clear \`sync.Pool\` entries at any time between GC cycles. This means a database or TCP connection stored in a \`sync.Pool\` can be silently discarded without calling \`Close()\`, leaking the underlying file descriptor or socket. A proper connection pool needs deterministic lifecycle management, health checks, and minimum connection guarantees, none of which \`sync.Pool\` provides.

\`\`\`go
// sync.Pool objects can be garbage collected at any time!
// GC clears pools during collection cycles.

// Bad: Connection pool with sync.Pool
var connPool = sync.Pool{
    New: func() any {
        conn, _ := net.Dial("tcp", "server:8080")
        return conn  // This connection might be GC'd!
    },
}

// Problems:
// 1. Connections closed unexpectedly during GC
// 2. No control over minimum connections
// 3. No health checking
// 4. Resources leaked if not properly tracked

// Good: Dedicated connection pool
type ConnPool struct {
    mu      sync.Mutex
    conns   chan *Connection
    factory func() (*Connection, error)
    maxSize int
}

// sync.Pool is good for:
// - Short-lived buffers
// - Temporary objects in hot paths
// - Reducing GC pressure
// - Objects that can be recreated cheaply
\`\`\`

**Follow-ups**:
- How do the per-P local caches reduce contention on Get and Put? What happens when local is empty?
- How does the victim cache (Go 1.13+) interact with the GC to smooth pool clearing?

### Question 5: Atomic Operations Design

**What FAANG expects**: correct CAS loop with termination conditions, awareness that atomics on the same cache line trigger cross-CPU invalidations under contention (false sharing), and the judgment to reach for a mutex when the critical section spans multiple fields.

**Q: Design a lock-free counter with overflow protection.**

**A:**

\`\`\`go
type BoundedCounter struct {
    value atomic.Int64
    max   int64
}

func NewBoundedCounter(max int64) *BoundedCounter {
    return &BoundedCounter{max: max}
}

func (c *BoundedCounter) Increment() bool {
    for {
        current := c.value.Load()
        if current >= c.max {
            return false  // At limit
        }
        if c.value.CompareAndSwap(current, current+1) {
            return true
        }
        // CAS failed, retry
    }
}

func (c *BoundedCounter) Decrement() bool {
    for {
        current := c.value.Load()
        if current <= 0 {
            return false  // Already zero
        }
        if c.value.CompareAndSwap(current, current-1) {
            return true
        }
        // CAS failed, retry
    }
}

func (c *BoundedCounter) Value() int64 {
    return c.value.Load()
}

// Used for: Semaphores, connection limits, rate limiting
\`\`\`

**Follow-ups**:
- Under heavy contention, will this CAS loop livelock? What does Go's scheduler guarantee about progress?
- When would a \`sync.Mutex\` + \`int64\` beat this CAS-based counter? Give a plausible contention profile.

### Q (Senior track): How do you diagnose a mutex-contention bottleneck in a running Go service?

**What FAANG expects**: a specific workflow using the mutex profiler, blocked-goroutine profile, and pprof visualisation.

**Answer**: Four steps.

1. **Enable mutex profiling.** \`runtime.SetMutexProfileFraction(5)\` samples 1 in 5 contention events. Set this at service start or via a dynamic config. The cost is negligible in production.
2. **Capture the profile.** \`curl http://service/debug/pprof/mutex > mutex.prof\`, then \`go tool pprof mutex.prof\`. Run \`top\` and \`list\` to see the hottest contention sites.
3. **Inspect the specific mutex.** For each hot mutex, read the critical section. Usually the fix is obvious: the critical section includes work that could happen outside the lock, or the lock granularity is too coarse.
4. **Measure before and after.** Rerun the profile after the fix. Verify the contention dropped. Check overall throughput also improved; sometimes fixing one mutex just moves contention elsewhere.

Bonus: the \`block\` profile shows goroutines blocked on any synchronization primitive (channels, mutexes, cond), which complements the mutex-only view.

### Q (Staff track): When would you replace a mutex-protected data structure with a lock-free alternative?

**What FAANG expects at staff**: an answer that balances correctness cost, performance benefit, and maintenance burden.

**Answer**: Three conditions must all hold.

1. **The mutex is a measured bottleneck.** Profile evidence, not theory. The mutex accounts for a meaningful fraction of CPU time or blocks goroutines for significant duration.
2. **The workload has high concurrent access that cannot be sharded.** If sharding the state into N independent mutexes works, do that first. Sharding is simpler and often sufficient.
3. **The lock-free alternative has a well-understood correctness proof.** Hand-rolled lock-free structures are notoriously bug-prone. Use a published, peer-reviewed algorithm or a well-tested library.

If all three hold, the lock-free version is justified. Otherwise, the mutex wins for simplicity. Most teams wrongly assume they are in the lock-free case and end up with subtle bugs that take months to find. Do not be that team.

### Q (Staff track): Your team uses sync.RWMutex widely. Should you audit or leave alone?

**What FAANG expects**: recognition that RWMutex is overused, with a practical audit plan.

**Answer**: Audit, but targeted. RWMutex wins only when reads vastly outnumber writes AND critical sections are long enough that concurrent readers actually run simultaneously. Many codebases use RWMutex reflexively where \`sync.Mutex\` would be faster.

The audit plan:

1. **Find every RWMutex in the codebase.** \`grep -r sync.RWMutex\`.
2. **For each, measure the contention profile.** Read rate, write rate, critical section length.
3. **Replace with Mutex where the criteria do not apply.** Usually half to three-quarters of uses.
4. **Measure the impact.** Simpler code; sometimes better performance; occasionally the same performance with lower risk.

This audit takes a week for a medium codebase and often produces measurable latency improvements plus a simpler code base. High return on investment.

**Follow-ups**:
- What specific metrics would you collect during the audit?
- How would you roll out the changes without risk?

---
`;
