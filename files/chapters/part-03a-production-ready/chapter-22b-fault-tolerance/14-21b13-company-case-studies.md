## 22B.13 Company Case Studies

### Netflix: Hystrix to Adaptive Concurrency

Netflix's Hystrix library (2012) was the industry's first widely adopted circuit breaker framework. It used static thread pools per dependency, the bulkhead pattern from section 22B.2. The problem: thread pool sizes needed constant manual tuning. Too large, and the pool provided no protection against slow dependencies. Too small, and healthy requests were rejected unnecessarily during normal traffic spikes. At Netflix's scale (tens of thousands of microservice instances), maintaining correct static limits across hundreds of dependencies was operationally unsustainable.

By 2018 Netflix moved to **adaptive concurrency limiting**, dynamically adjusting the limit based on observed latency using Little's Law and gradient descent. The gradient compares the minimum observed RTT (the clean baseline) against the current RTT: a ratio below 1.0 means latency is inflating under load, so the limit shrinks. A ratio near 1.0 means there is still headroom, so the limit grows by one. This approach eliminated the need for manual tuning entirely and responded to latency changes within seconds rather than requiring a config deploy.

The implementation below demonstrates the core algorithm. Each completed request updates the minimum RTT and recalculates the concurrency limit. It is a teaching sketch rather than a replacement for `netflix/concurrency-limits`, whose `Gradient2Limit` samples an exponentially smoothed long-term RTT rather than a windowed minimum. Five details below are load-bearing, and each one is a bug that the obvious version of this code has:

```go
// Gradient = minRTT / currentRTT
// If gradient < 1.0 → latency is inflating → reduce the limit
// If gradient ≈ 1.0 → no inflation → grow the limit
type AdaptiveLimiter struct {
    limit    atomic.Int64
    inFlight atomic.Int64
    minRTTns atomic.Int64

    minLimit, maxLimit int64

    mu          sync.Mutex
    windowStart time.Time
    windowLen   time.Duration
}

// NewAdaptiveLimiter seeds the limit. The constructor is not optional.
//
// A zero-value AdaptiveLimiter rejects 100% of traffic forever. Permit tests
// inFlight >= limit, which on the first call is 0 >= 0, so it returns false.
// The only code that ever raises the limit lives in the release closure, and
// release is unreachable without a successful Permit. The limiter cannot
// bootstrap itself, and it fails silently: no panic, no error, just a service
// that refuses every request.
func NewAdaptiveLimiter(initial, minLimit, maxLimit int64) *AdaptiveLimiter {
    al := &AdaptiveLimiter{
        minLimit:    minLimit,
        maxLimit:    maxLimit,
        windowLen:   10 * time.Second,
        windowStart: time.Now(),
    }
    al.limit.Store(initial)
    return al
}

func (al *AdaptiveLimiter) Permit() (release func(), ok bool) {
    // CompareAndSwap, not Load-then-Add: between a Load and an Add, other
    // goroutines observe the same under-limit value and the limit is breached.
    for {
        cur := al.inFlight.Load()
        if cur >= al.limit.Load() {
            return nil, false
        }
        if al.inFlight.CompareAndSwap(cur, cur+1) {
            break
        }
    }

    start := time.Now()
    return func() { al.release(start) }, true
}

func (al *AdaptiveLimiter) release(start time.Time) {
    al.inFlight.Add(-1)

    rttNs := time.Since(start).Nanoseconds()
    if rttNs <= 0 {
        return
    }
    al.observeRTT(rttNs)

    minRTT := al.minRTTns.Load()
    if minRTT <= 0 {
        return
    }

    // Clamp the gradient to [0.5, 1.0], exactly as Netflix's Gradient2Limit
    // does. The 0.5 floor is not a rounding detail, it is what stops the
    // limit from collapsing: a single outlier RTT ten times the baseline
    // would otherwise produce a gradient of 0.1 and cut the limit by 90% in
    // one step, and a few of those in a row drive it to minLimit, where it
    // sits rejecting traffic long after the blip has passed. The floor caps
    // how fast the limiter is allowed to panic.
    gradient := math.Max(0.5, math.Min(1.0, float64(minRTT)/float64(rttNs)))

    cur := float64(al.limit.Load())

    // Netflix allows a queue proportional to sqrt(limit). A bare "+1" grows
    // the limit one step per completed request, far too slow to track a ramp.
    queue := math.Sqrt(cur)
    newLimit := cur*gradient + queue

    // Smoothing, with Netflix's default of 0.2, blends the new estimate with
    // the old one so a single request cannot swing the limit.
    const smoothing = 0.2
    newLimit = cur*(1-smoothing) + newLimit*smoothing

    // Round, do not truncate. With smoothing at 0.2 a healthy limit of 10
    // computes a new estimate of 10.63, and int64() truncates that straight
    // back to 10. The limit then never grows, at any load, forever: the
    // limiter looks like it is adapting and is in fact pinned at its initial
    // value by a integer conversion.
    final := min(max(int64(math.Round(newLimit)), al.minLimit), al.maxLimit)
    al.limit.Store(final)
}

// observeRTT tracks the minimum RTT within a rolling window.
//
// The window is the fourth detail. A minRTT that only ever ratchets DOWN is
// permanent: one lucky fast response during startup pins the baseline for the
// life of the process. As the service legitimately slows down, with a larger
// dataset or a colder cache, every gradient is measured against a baseline
// that is no longer achievable, so the limit collapses to minLimit and stays
// there. Resetting each window lets the baseline track reality.
func (al *AdaptiveLimiter) observeRTT(rttNs int64) {
    al.mu.Lock()
    defer al.mu.Unlock()

    if time.Since(al.windowStart) > al.windowLen {
        al.minRTTns.Store(rttNs) // New window, so re-baseline.
        al.windowStart = time.Now()
        return
    }
    if m := al.minRTTns.Load(); m == 0 || rttNs < m {
        al.minRTTns.Store(rttNs)
    }
}
```

### Google Spanner: Partial Failure in Distributed Transactions

Google Spanner is a globally distributed database that uses Paxos consensus per shard to replicate data across datacenters. Its fault tolerance design illustrates a principle directly applicable to Go services: reads and writes have fundamentally different failure characteristics and should be handled differently.

Key fault tolerance properties:
- **Read-only transactions**: Paxos replication means a shard survives the loss of a minority of its replicas. A read-only transaction is assigned a timestamp and can then be served by any replica that has caught up to it, so it does not need the leader and does not need a fresh quorum round trip. Reads stay available through failures that block writes.
- **Read-write transactions**: two-phase commit (2PC) across shard leaders, with each leader's participation replicated by Paxos. A leader failure blocks the transaction until a new leader is elected, which takes seconds. Writes cannot be partially applied, they are all-or-nothing.
- **External consistency**: TrueTime (backed by GPS receivers and atomic clocks) gives every transaction a globally meaningful commit timestamp, so if transaction A commits before B starts, A's timestamp is smaller, everywhere. Be precise about what does what: atomicity, meaning no reader ever sees half a transaction, comes from 2PC and Paxos. TrueTime supplies **ordering**, not atomicity. Its contribution is bounding clock uncertainty so Spanner can wait out the error interval and guarantee that ordering globally.

The Go lesson here is architectural: distinguish writes (must be atomic, all-or-nothing, retry with idempotency keys) from reads (can tolerate partial results, can serve stale data, can fall back to caches). Applying write-level strictness to reads wastes availability. Applying read-level leniency to writes causes data corruption.

### Amazon: Static Stability

Amazon's static stability principle, published in their Builder's Library, states that data plane systems must never make synchronous calls to control plane systems on the hot path. Configuration, route tables, feature flags, and rate limit state should all be cached locally and refreshed asynchronously in the background.

This principle explains why AWS services continue functioning during Route 53 or Systems Manager outages, their runtime configuration is already cached on the instance. The hot path reads from local memory, not from a remote config service. A control plane outage means config stops updating, but the service keeps operating with its last known good configuration. This trade-off, serving potentially stale config versus blocking on a failed dependency, is almost always correct for production systems. Section 22B.11 covers the implementation pattern in detail.

### Staff Lens: Static Stability as Architecture Principle

Adopt static stability as an org-wide principle: data-plane services never call control-plane services on the hot path. Enforce in design review. The architecture is more resilient, and the review cost is small.

---
