## 15.12 Company Case Studies

### Google: Go Scheduler Internals

Go's runtime scheduler is itself a work-stealing system, making the patterns in this chapter directly relevant to understanding how goroutines are scheduled. The scheduler maps G (goroutines) to M (OS threads) via P (processor contexts), where each P maintains a local run queue. When a P's local queue is empty, it steals half of another P's queue, the same algorithm described in Section 15.2.

```
Google's Go Scheduler Architecture:
┌──────────────────────────────────────────────────────────────────────┐
│                        Go Runtime Scheduler                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Global Run Queue (GRQ)         Per-P Local Run Queues (LRQ)         │
│  ┌──────────────────┐           ┌───────┐ ┌───────┐ ┌───────┐        │
│  │ Overflow queue   │           │ P0    │ │ P1    │ │ P2    │        │
│  │ for goroutines   │           │ LRQ   │ │ LRQ   │ │ LRQ   │        │
│  └────────┬─────────┘           │┌─────┐│ │┌─────┐│ │┌─────┐│        │
│           │                     ││ G0  ││ ││ G3  ││ ││ G6  ││        │
│           │                     ││ G1  ││ ││ G4  ││ ││ G7  ││        │
│           │                     ││ G2  ││ ││ G5  ││ ││     ││        │
│           │                     │└─────┘│ │└─────┘│ │└─────┘│        │
│           │                     └───┬───┘ └───┬───┘ └───┬───┘        │
│           │                         │         │         │            │
│           │                        M0        M1        M2            │
│           │                     (thread)  (thread)  (thread)         │
│           │                                                          │
│  Work Stealing:                                                      │
│  - When LRQ is empty, P steals from other P's LRQ                    │
│  - Steals half of the victim's queue                                 │
│  - Falls back to GRQ if no work to steal                             │
│  - Uses randomized victim selection to reduce contention             │
└──────────────────────────────────────────────────────────────────────┘
```

**Key techniques used:**
- Work stealing with 256-element circular local run queues (`runq [256]guintptr` in `runtime2.go`)
- Lock-free operations for local queue access
- Randomized victim selection
- Adaptive spinning before parking threads

### Uber: High-Throughput Metrics Collection

Uber's metrics platform ingests an enormous volume of measurements across thousands of microservices. A single-lock metrics aggregator becomes the bottleneck long before that kind of load, so the approach shards the metrics store across many independent segments. Each shard guards its own map with a `sync.RWMutex`, and individual metric values use atomic operations for count, sum, min, and max, avoiding write locks entirely on the hot path of recording a measurement.

The shape below is worth studying for two details that are easy to get wrong: the padding arithmetic, and a CAS loop for min and max where no single atomic instruction exists.

```go
// Uber-inspired metrics aggregator
type MetricsAggregator struct {
    shards [256]*metricsShard
}

// NewMetricsAggregator is required: the zero value is an array of nil
// shard pointers, and the first Record would dereference one.
func NewMetricsAggregator() *MetricsAggregator {
    a := &MetricsAggregator{}
    for i := range a.shards {
        a.shards[i] = &metricsShard{metrics: make(map[string]*MetricValue)}
    }
    return a
}

type metricsShard struct {
    mu      sync.RWMutex // 24 bytes
    metrics map[string]*MetricValue // 8 bytes
    _       [32]byte // Pad to 64. [40]byte would make this 72 and
                     // straddle two lines, defeating the padding.
}

type MetricValue struct {
    count atomic.Int64
    sum   atomic.Int64
    min   atomic.Int64
    max   atomic.Int64
}

func fnvHash(s string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(s))
    return h.Sum32()
}

func (a *MetricsAggregator) Record(name string, value int64) {
    // FNV hash for shard selection. 256 shards, so &0xFF is the mask.
    shard := a.shards[fnvHash(name)&0xFF]

    shard.mu.RLock()
    metric, exists := shard.metrics[name]
    shard.mu.RUnlock()

    if !exists {
        shard.mu.Lock()
        if metric, exists = shard.metrics[name]; !exists {
            metric = &MetricValue{}
            metric.min.Store(value)
            metric.max.Store(value)
            shard.metrics[name] = metric
        }
        shard.mu.Unlock()
    }

    // count and sum have a single-instruction atomic. Use it.
    metric.count.Add(1)
    metric.sum.Add(value)

    // min and max do not: the new value depends on the old one, so this
    // is the case where a CAS retry loop genuinely earns its place.
    // Read the condition carefully: it exits when our value cannot
    // lower the minimum, OR when we successfully lowered it. A failed
    // CAS means someone else moved it, so we re-read and re-decide.
    for {
        min := metric.min.Load()
        if value >= min || metric.min.CompareAndSwap(min, value) {
            break
        }
    }
    for {
        max := metric.max.Load()
        if value <= max || metric.max.CompareAndSwap(max, value) {
            break
        }
    }
}
```

**What this buys:** sharding removes the single-lock bottleneck, and per-metric atomics keep the recording path off the write lock entirely, so the common case of updating an existing metric never blocks. The write lock is taken only to create a metric that does not exist yet, which happens once per metric name for the life of the process. The double-check after acquiring it is mandatory, since another goroutine may have created the same metric while we held no lock.

Match the shard count to your own contention profile rather than copying 256. The number that matters is measured lock contention in a profile, not a number from someone else's architecture.

### Netflix: Adaptive Concurrency Limits

Static concurrency limits are fragile: set too low and you waste capacity, set too high and the service collapses under load. Netflix developed an adaptive concurrency limiter (open-sourced as `concurrency-limits`) that infers the limit from observed round-trip latency. When latency stays close to the unloaded baseline, the limiter raises the allowed concurrency. When latency degrades, it cuts it. This gradient approach adapts to changing backend capacity without manual tuning.

Two things about the sketch below deserve attention. `limit` is mutable shared state written under `l.mu`, so it must be *read* under `l.mu` too. Reading it unlocked on the acquire path, next to an atomic `inflight`, is a data race, and the fact that the neighbouring variable is atomic makes it read as though it were safe. Mixing a mutex-guarded field and an atomic field in one condition is a reliable way to produce this bug. And `rttNoLoad` must track the *minimum observed* RTT rather than sitting at a hardcoded constant, or the gradient is measured against a baseline that has no relationship to the real service.

```go
// Netflix-inspired adaptive concurrency limiter
type AdaptiveLimiter struct {
    mu       sync.Mutex
    limit    int
    inflight int // Guarded by mu, alongside limit: see below
    minLimit int
    maxLimit int

    // Gradient-based adjustment
    rttNoLoad  time.Duration
    rttSamples []time.Duration
    sampleIdx  int
}

func NewAdaptiveLimiter(minLimit, maxLimit int) *AdaptiveLimiter {
    return &AdaptiveLimiter{
        limit:      minLimit,
        minLimit:   minLimit,
        maxLimit:   maxLimit,
        rttNoLoad:  0, // Learned from observation, not assumed
        rttSamples: make([]time.Duration, 100),
    }
}

// tryAcquire takes a slot if one is free. inflight is a plain int under
// the mutex, not an atomic: it is compared against limit, which the
// mutex already guards, and one lock is both cheaper and more obviously
// correct than an atomic that has to be read together with a locked
// field anyway.
func (l *AdaptiveLimiter) tryAcquire() bool {
    l.mu.Lock()
    defer l.mu.Unlock()
    if l.inflight >= l.limit {
        return false
    }
    l.inflight++
    return true
}

func (l *AdaptiveLimiter) Acquire(ctx context.Context) (func(time.Duration), error) {
    for {
        if l.tryAcquire() {
            break
        }
        // At the limit. Poll rather than queue, for brevity: a real
        // implementation should park on a channel instead of sleeping.
        t := time.NewTimer(10 * time.Millisecond)
        select {
        case <-ctx.Done():
            t.Stop()
            return nil, ctx.Err()
        case <-t.C:
        }
    }

    return func(rtt time.Duration) {
        l.release(rtt)
    }, nil
}

func (l *AdaptiveLimiter) release(rtt time.Duration) {
    l.mu.Lock()
    defer l.mu.Unlock()

    l.inflight--

    // Store RTT sample
    l.rttSamples[l.sampleIdx%len(l.rttSamples)] = rtt
    l.sampleIdx++

    // Learn the no-load baseline instead of hardcoding it. The minimum
    // RTT ever seen is the best available estimate of an unloaded call.
    if l.rttNoLoad == 0 || rtt < l.rttNoLoad {
        l.rttNoLoad = rtt
    }

    // Calculate gradient: 1.0 means we are as fast as our best-ever
    // call, lower means the backend is queueing.
    avgRTT := l.averageRTTLocked()
    if avgRTT == 0 {
        return
    }
    gradient := float64(l.rttNoLoad) / float64(avgRTT)

    switch {
    case gradient > 0.9:
        // Latency near baseline: probe upward, one at a time.
        l.limit = min(l.limit+1, l.maxLimit)
    case gradient < 0.5:
        // Latency badly degraded: back off fast. Additive increase and
        // multiplicative decrease, the same asymmetry TCP uses, because
        // overshooting the limit is far more expensive than undershooting.
        l.limit = max(l.limit/2, l.minLimit)
    }
}

// averageRTTLocked must be called with l.mu held. The Locked suffix is
// worth the keystrokes: it is the only thing telling the next reader
// that this function has a locking precondition.
func (l *AdaptiveLimiter) averageRTTLocked() time.Duration {
    count := min(l.sampleIdx, len(l.rttSamples))
    if count == 0 {
        return 0
    }
    var sum time.Duration
    for i := 0; i < count; i++ {
        sum += l.rttSamples[i]
    }
    return sum / time.Duration(count)
}
```

The caller must report the RTT it actually observed, and the release function is the only thing that decrements `inflight`. A caller that forgets to invoke it leaks a permit and ratchets the effective limit down to zero, so treat it exactly like `mu.Unlock` and `defer` it at the call site.

### Stripe: Idempotency with Lock-Free Maps

Payment processing requires exactly-once semantics: a network retry must not charge a customer twice. An idempotency layer caches the outcome for each idempotency key so that retried requests receive the same response without re-executing the operation. The cache uses sharded locking with a per-entry completion channel: concurrent requests for the same key block on the channel until the first request completes, then all waiters receive the cached result.

This is the highest-stakes code in the chapter, so it is the right place to be pedantic about failure paths. Two of them turn this pattern into a payments incident.

**A failed operation must not be cached as a success.** If the naive version stores whatever `execute` returned and closes `done` regardless of the error, then every waiter and every subsequent retry receives that entry with a `nil` error, and `execute` never runs again. A transient gateway timeout permanently poisons the key:

```
caller 1 (the real attempt) saw error: payment gateway timeout
caller 2 (retry)  -> response=[] code=500 err=<nil>
   ^ retry got err=nil for a charge that FAILED, and execute never re-ran
```

The customer's retry is answered with a fabricated success for a charge that never happened. The entry must record the error, and a *transient* failure must be evicted so a retry can genuinely re-execute.

**A panic must not strand the waiters.** If `close(entry.done)` is reached only on the normal path, a panic inside `execute` leaves `done` open forever. Every present and future request for that key blocks permanently, and the entry sits in the map poisoning it for the process lifetime. `close` belongs in a `defer`.

Note also that the per-entry mutex in the naive version protects nothing. Readers never take it, they synchronize via `<-entry.done`, and the `close` already establishes happens-before for everything written before it. Deleting it removes the illusion of protection.

```go
// Stripe-inspired idempotency cache
type IdempotencyCache struct {
    shards []*idempotencyShard
    ttl    time.Duration
}

func NewIdempotencyCache(numShards int, ttl time.Duration) *IdempotencyCache {
    c := &IdempotencyCache{shards: make([]*idempotencyShard, numShards), ttl: ttl}
    for i := range c.shards {
        c.shards[i] = &idempotencyShard{items: make(map[string]*idempotencyEntry)}
    }
    return c
}

func (c *IdempotencyCache) getShard(key string) *idempotencyShard {
    return c.shards[fnvHash(key)%uint32(len(c.shards))]
}

type idempotencyShard struct {
    mu    sync.RWMutex
    items map[string]*idempotencyEntry
}

type idempotencyEntry struct {
    // Written once by the executing goroutine before close(done).
    // Readers must not touch these until <-done returns, which is the
    // happens-before edge that makes a mutex here unnecessary.
    response   []byte
    statusCode int
    err        error
    createdAt  time.Time
    done       chan struct{}
}

func (c *IdempotencyCache) GetOrExecute(
    key string,
    execute func() ([]byte, int, error),
) ([]byte, int, error) {
    shard := c.getShard(key)

    // Fast path: an entry already exists.
    shard.mu.RLock()
    entry, exists := shard.items[key]
    shard.mu.RUnlock()

    if exists {
        <-entry.done
        return entry.response, entry.statusCode, entry.err
    }

    // Create the entry under the write lock, re-checking first.
    shard.mu.Lock()
    if entry, exists = shard.items[key]; exists {
        shard.mu.Unlock()
        <-entry.done
        // Return the recorded error, never a synthesized nil.
        return entry.response, entry.statusCode, entry.err
    }

    entry = &idempotencyEntry{
        createdAt: time.Now(),
        done:      make(chan struct{}),
    }
    shard.items[key] = entry
    shard.mu.Unlock()

    // We own this entry, so we are responsible for always publishing an
    // outcome. Nothing below may return or panic without closing done.
    var (
        response   []byte
        statusCode int
        err        error
    )
    func() {
        defer func() {
            if r := recover(); r != nil {
                err = fmt.Errorf("idempotency: execute panicked: %v", r)
            }
            entry.response, entry.statusCode, entry.err = response, statusCode, err

            // Deferred: a panic in execute must still release waiters.
            // Without this, every future request for this key blocks
            // forever and the key is poisoned for the process lifetime.
            close(entry.done)
        }()
        response, statusCode, err = execute()
    }()

    // A failure must not be remembered as a result. Evict it so the next
    // retry genuinely re-executes rather than being served a cached
    // error for a charge that may never have been attempted.
    //
    // Be deliberate here: evicting on every error means a request that
    // failed AFTER the charge succeeded will be retried and may double
    // charge. Production systems distinguish outcomes that are known not
    // to have taken effect from outcomes that are simply unknown, and
    // keep the unknown ones so a human can resolve them.
    if err != nil {
        shard.mu.Lock()
        if cur, ok := shard.items[key]; ok && cur == entry {
            delete(shard.items, key)
        }
        shard.mu.Unlock()
    }

    return response, statusCode, err
}
```

### Staff Lens: Scale-Matched Techniques

Each case study applies an advanced technique at a scale that justifies it. The Go scheduler is lock-free and work-stealing because it is on the path of every goroutine switch in every Go program ever run. Uber shards its metrics store because a single lock cannot absorb that ingest rate. Netflix adapts its concurrency limit because its backends' capacity genuinely moves. In each case the technique answers a measured problem, not an aesthetic preference.

Your service is probably not at their scale, and copying the pattern without inheriting the problem buys complexity and nothing else. The staff-level diagnostic is to compare your service's measured throughput and contention profile against the case study's. If you are an order of magnitude below, the technique is overkill and the mutex you were about to replace is fine.

Note the asymmetry the fixes in this section illustrate. Every bug worth finding here was in a *failure* path: a cached error, a panic that stranded waiters, a limit read without its lock. The clever concurrency was mostly fine. That is the usual distribution, and it is why these patterns should be reviewed by reading the error paths first.

### Principal Lens: Outgrowing In-Process Patterns

Every technique in these case studies is in-process. At some scale, in-process patterns are insufficient and distributed equivalents are required. Sharded maps become distributed caches. Lock-free queues become distributed message brokers. Atomic counters become distributed rate limiters. Recognize when your service crosses this threshold. Continuing to optimize in-process patterns past their scale ceiling is wasted effort. The right move is architectural change.

---
