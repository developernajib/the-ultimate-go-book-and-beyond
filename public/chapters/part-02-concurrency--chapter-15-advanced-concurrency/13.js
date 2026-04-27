export default `## 15.12 Company Case Studies

### Google: Go Scheduler Internals

Go's runtime scheduler is itself a work-stealing system, making the patterns in this chapter directly relevant to understanding how goroutines are scheduled. The scheduler maps G (goroutines) to M (OS threads) via P (processor contexts), where each P maintains a local run queue. When a P's local queue is empty, it steals half of another P's queue, the same algorithm described in Section 14.2.

\`\`\`
Google's Go Scheduler Architecture:
┌─────────────────────────────────────────────────────────────────────┐
│                        Go Runtime Scheduler                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Global Run Queue (GRQ)         Per-P Local Run Queues (LRQ)        │
│  ┌──────────────────┐           ┌───────┐ ┌───────┐ ┌───────┐       │
│  │ Overflow queue   │           │ P0    │ │ P1    │ │ P2    │       │
│  │ for goroutines   │           │ LRQ   │ │ LRQ   │ │ LRQ   │       │
│  └────────┬─────────┘           │┌─────┐│ │┌─────┐│ │┌─────┐│       │
│           │                      ││ G0  ││ ││ G3  ││ ││ G6  ││       │
│           │                      ││ G1  ││ ││ G4  ││ ││ G7  ││       │
│           │                      ││ G2  ││ ││ G5  ││ ││     ││       │
│           │                      │└─────┘│ │└─────┘│ │└─────┘│       │
│           │                      └───┬───┘ └───┬───┘ └───┬───┘       │
│           │                          │         │         │           │
│           │                          M0        M1        M2          │
│           │                       (thread)  (thread)  (thread)       │
│           │                                                          │
│  Work Stealing:                                                     │
│  - When LRQ is empty, P steals from other P's LRQ                   │
│  - Steals half of the victim's queue                                │
│  - Falls back to GRQ if no work to steal                            │
│  - Uses randomized victim selection to reduce contention            │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

**Key techniques used:**
- Work stealing with 256-element circular queues
- Lock-free operations for local queue access
- Randomized victim selection
- Adaptive spinning before parking threads

### Uber: High-Throughput Metrics Collection

Uber processes trillions of metrics per day across thousands of microservices. A single-lock metrics aggregator would become the bottleneck under this load, so their approach shards the metrics store across 256 independent segments. Each shard guards its own map with a \`sync.RWMutex\`, and individual metric values use atomic operations for count, sum, min, and max, avoiding write locks entirely for the hot path of recording a measurement.

\`\`\`go
// Uber-inspired metrics aggregator
type MetricsAggregator struct {
    shards [256]*metricsShard
}

type metricsShard struct {
    mu      sync.RWMutex
    metrics map[string]*MetricValue
    _       [40]byte // Cache line padding
}

type MetricValue struct {
    count atomic.Int64
    sum   atomic.Int64
    min   atomic.Int64
    max   atomic.Int64
}

func (a *MetricsAggregator) Record(name string, value int64) {
    // FNV hash for shard selection
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

    metric.count.Add(1)
    metric.sum.Add(value)

    // Update min/max with CAS
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
\`\`\`

**Results at Uber:**
- 10M+ metrics/second per host
- Sub-millisecond P99 latency
- 256 shards eliminates contention

### Netflix: Adaptive Concurrency Limits

Static concurrency limits are fragile: set too low and you waste capacity, set too high and the service collapses under load. Netflix developed an adaptive concurrency limiter (open-sourced as \`concurrency-limiter\`) that infers the optimal limit from observed round-trip latency. When latency stays close to the unloaded baseline, the limiter increases the allowed concurrency. When latency degrades, it cuts the limit. This gradient-based approach automatically adapts to changing backend capacity without manual tuning.

\`\`\`go
// Netflix-inspired adaptive concurrency limiter
type AdaptiveLimiter struct {
    mu          sync.Mutex
    limit       int
    inflight    atomic.Int32
    minLimit    int
    maxLimit    int

    // Gradient-based adjustment
    rttNoLoad   time.Duration
    rttSamples  []time.Duration
    sampleIdx   int
}

func NewAdaptiveLimiter(minLimit, maxLimit int) *AdaptiveLimiter {
    return &AdaptiveLimiter{
        limit:      minLimit,
        minLimit:   minLimit,
        maxLimit:   maxLimit,
        rttNoLoad:  time.Millisecond * 10,
        rttSamples: make([]time.Duration, 100),
    }
}

func (l *AdaptiveLimiter) Acquire(ctx context.Context) (func(time.Duration), error) {
    // Check if at limit
    for {
        current := l.inflight.Load()
        if int(current) >= l.limit {
            // Wait or reject
            select {
            case <-ctx.Done():
                return nil, ctx.Err()
            case <-time.After(time.Millisecond * 10):
                continue
            }
        }
        if l.inflight.CompareAndSwap(current, current+1) {
            break
        }
    }

    start := time.Now()
    return func(rtt time.Duration) {
        l.inflight.Add(-1)
        l.updateLimit(rtt)
    }, nil
}

func (l *AdaptiveLimiter) updateLimit(rtt time.Duration) {
    l.mu.Lock()
    defer l.mu.Unlock()

    // Store RTT sample
    l.rttSamples[l.sampleIdx%len(l.rttSamples)] = rtt
    l.sampleIdx++

    // Calculate gradient
    avgRTT := l.averageRTT()
    gradient := float64(l.rttNoLoad) / float64(avgRTT)

    // Adjust limit based on gradient
    if gradient > 0.9 {
        // Good performance - increase limit
        l.limit = min(l.limit+1, l.maxLimit)
    } else if gradient < 0.5 {
        // Degraded performance - decrease limit
        l.limit = max(l.limit/2, l.minLimit)
    }
}

func (l *AdaptiveLimiter) averageRTT() time.Duration {
    var sum time.Duration
    count := min(l.sampleIdx, len(l.rttSamples))
    for i := 0; i < count; i++ {
        sum += l.rttSamples[i]
    }
    if count == 0 {
        return l.rttNoLoad
    }
    return sum / time.Duration(count)
}
\`\`\`

### Stripe: Idempotency with Lock-Free Maps

Payment processing requires exactly-once semantics: a network retry must not charge a customer twice. Stripe's idempotency layer caches the response for each idempotency key so that retried requests receive the same response without re-executing the operation. The cache uses sharded locking with a per-entry completion channel, concurrent requests for the same key block on the channel until the first request completes, then all waiters receive the cached result.

\`\`\`go
// Stripe-inspired idempotency cache
type IdempotencyCache struct {
    shards []*idempotencyShard
    ttl    time.Duration
}

type idempotencyShard struct {
    mu    sync.RWMutex
    items map[string]*idempotencyEntry
}

type idempotencyEntry struct {
    response   []byte
    statusCode int
    createdAt  time.Time
    mu         sync.Mutex
    done       chan struct{}
}

func (c *IdempotencyCache) GetOrExecute(
    key string,
    execute func() ([]byte, int, error),
) ([]byte, int, error) {
    shard := c.getShard(key)

    // Try to get existing entry
    shard.mu.RLock()
    entry, exists := shard.items[key]
    shard.mu.RUnlock()

    if exists {
        // Wait for completion if in progress
        <-entry.done
        return entry.response, entry.statusCode, nil
    }

    // Create new entry
    shard.mu.Lock()
    if entry, exists = shard.items[key]; exists {
        shard.mu.Unlock()
        <-entry.done
        return entry.response, entry.statusCode, nil
    }

    entry = &idempotencyEntry{
        createdAt: time.Now(),
        done:      make(chan struct{}),
    }
    shard.items[key] = entry
    shard.mu.Unlock()

    // Execute the operation
    response, statusCode, err := execute()

    entry.mu.Lock()
    entry.response = response
    entry.statusCode = statusCode
    close(entry.done)
    entry.mu.Unlock()

    return response, statusCode, err
}
\`\`\`

### Staff Lens: Scale-Matched Techniques

Each case study shows an advanced technique at a specific scale. Google's groupcache uses sharded locks because its throughput genuinely justifies it. CockroachDB uses lock-free structures because transactional throughput requires it. Fastly uses sharded counters because its edge compute serves millions of requests per second.

Your service is probably not at their scale. Copying their patterns without matching scale adds complexity without benefit. The staff-level diagnostic: compare your service's real throughput to the case study's. If you are 10x or more below, the technique is probably overkill.

### Principal Lens: Outgrowing In-Process Patterns

Every technique in these case studies is in-process. At some scale, in-process patterns are insufficient and distributed equivalents are required. Sharded maps become distributed caches. Lock-free queues become distributed message brokers. Atomic counters become distributed rate limiters. Recognise when your service crosses this threshold. Continuing to optimise in-process patterns past their scale ceiling is wasted effort; the right move is architectural change.

---
`;
