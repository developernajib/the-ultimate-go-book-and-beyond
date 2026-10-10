## 42.5 Adaptive Rate Limiting

### Load-Based Rate Limiting

Static rate limits are a compromise: set them high enough for peak legitimate traffic and they may not protect the system under stress. Set them low enough for safety and they reject valid requests during normal operation. `AdaptiveRateLimiter` resolves this by sampling system load every 10 seconds and scaling the effective limit between `minRate` and `maxRate`. Under heavy load (>90% utilization), the limiter drops to `minRate` to shed traffic quickly. Under light load (<30%), it increases to 1.5x the base rate to give clients more headroom. The `getSystemLoad` function shown here uses memory allocation ratios and goroutine count as a cheap proxy for system pressure. In production, replace this with observed p99 latency and actual CPU metrics from `gopsutil` or your metrics pipeline, goroutine count is a poor signal (a healthy system can run tens of thousands without stress).

> **Senior track**: The modern production approach is concurrency-based rather than rate-based. Netflix's `concurrency-limits` library applies TCP-style congestion control: maintain a measured `minRTT` (no-load latency) and compare it to the current RTT. The gradient `minRTT / currentRTT` approaches 1 when the system is idle and drops as queues build. Multiply the current limit by the gradient plus an allowable queue (default `sqrt(limit)`) to get the new limit. This automatically finds the saturation point without a hand-tuned CPU threshold and adapts when hardware or dependencies change. Envoy's adaptive concurrency filter and Vector's adaptive request concurrency apply the same latency-gradient idea. In Go, look at `github.com/platinummonkey/go-concurrency-limits` (a port of Netflix's library) or `github.com/bohde/codel` for CoDel.

Three details in the code below matter more than the threshold ladder itself: the limiter pointer is swapped atomically, the background goroutine is stoppable, and swapping the limiter is acknowledged as the compromise it is.

```go
// ... imports omitted for brevity (runtime, sync/atomic, time)

// AdaptiveRateLimiter adjusts limits based on system load
type AdaptiveRateLimiter struct {
    baseRate int
    minRate  int
    maxRate  int

    currentRate atomic.Int64

    // limiter is replaced by the adjust goroutine while request goroutines
    // are calling Allow. A plain *TokenBucketLimiter field here is a data
    // race: one goroutine writes the pointer while others read it, with no
    // synchronisation. `go test -race` reports it immediately, and on a
    // weakly-ordered CPU a reader can observe a partially-published struct.
    // atomic.Pointer makes the publication safe and stays lock-free on the
    // read path, which matters because Allow is the hot path.
    limiter atomic.Pointer[TokenBucketLimiter]

    stop chan struct{}
}

func NewAdaptiveRateLimiter(baseRate, minRate, maxRate int) *AdaptiveRateLimiter {
    a := &AdaptiveRateLimiter{
        baseRate: baseRate,
        minRate:  minRate,
        maxRate:  maxRate,
        stop:     make(chan struct{}),
    }

    a.limiter.Store(NewTokenBucketLimiter(float64(baseRate)/60, baseRate))
    a.currentRate.Store(int64(baseRate))

    go a.adjust()

    return a
}

// Close stops the adjust goroutine. Without this, every AdaptiveRateLimiter
// ever constructed leaks a goroutine and a ticker for the life of the
// process. Tests that build a limiter per case notice first.
func (a *AdaptiveRateLimiter) Close() { close(a.stop) }

func (a *AdaptiveRateLimiter) adjust() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-a.stop:
            return
        case <-ticker.C:
        }

        load := a.getSystemLoad()

        var newRate int
        switch {
        case load > 0.9:
            // Very high load - significantly reduce
            newRate = a.minRate
        case load > 0.8:
            // High load - reduce
            newRate = int(float64(a.baseRate) * 0.5)
        case load > 0.6:
            // Moderate load - slightly reduce
            newRate = int(float64(a.baseRate) * 0.75)
        case load < 0.3:
            // Low load - can increase
            newRate = int(float64(a.baseRate) * 1.5)
            if newRate > a.maxRate {
                newRate = a.maxRate
            }
        default:
            newRate = a.baseRate
        }

        // Clamp to bounds
        if newRate < a.minRate {
            newRate = a.minRate
        }
        if newRate > a.maxRate {
            newRate = a.maxRate
        }

        oldRate := a.currentRate.Swap(int64(newRate))
        if int64(newRate) != oldRate {
            // Publish the new limiter atomically.
            //
            // Be aware of what this costs: the replacement limiter starts
            // with every bucket full, so a rate change hands every client a
            // brand new burst allowance and discards all accumulated state.
            // Adjusting under *rising* load therefore briefly admits MORE
            // traffic, which is the opposite of the intent. A production
            // implementation mutates the rate inside the existing limiter
            // (guarded by the limiter's own mutex, or via
            // rate.Limiter.SetLimit) instead of replacing the instance.
            a.limiter.Store(NewTokenBucketLimiter(float64(newRate)/60, newRate))
        }
    }
}

func (a *AdaptiveRateLimiter) getSystemLoad() float64 {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    // Pitfall: m.TotalAlloc is a lifetime counter and trends up forever,
    // so Alloc/TotalAlloc shrinks to ~0 over time. Compare Alloc against
    // Sys (current heap + stack reserved from OS) instead, or better, poll
    // container cgroup memory limits via /sys/fs/cgroup/memory.current.
    memUsage := float64(m.Alloc) / float64(m.Sys)

    // Goroutine count is a weak signal on its own (a healthy pool may
    // run 50k goroutines). A better proxy is observed p99 latency vs a
    // rolling baseline. This is illustrative only.
    goroutines := runtime.NumGoroutine()
    goroutineLoad := float64(goroutines) / 10000.0

    // Weighted average
    return memUsage*0.5 + goroutineLoad*0.5
}

func (a *AdaptiveRateLimiter) Allow(key string) (bool, int, time.Time) {
    return a.limiter.Load().Allow(key)
}

func (a *AdaptiveRateLimiter) CurrentRate() int {
    return int(a.currentRate.Load())
}
```

### Circuit Breaker Integration

A circuit breaker monitors calls to a dependency and opens the circuit (failing fast) when the error rate exceeds a threshold. After a configurable cooldown period, the circuit transitions to half-open, allowing a probe request to test whether the dependency has recovered.

Read that definition again before reading the code, because the pairing hides a trap that is easy to write and painful to debug. A circuit breaker's failure signal must come from **the dependency**, meaning timeouts, 5xx responses, connection refusals. It must never come from **the rate limiter's own rejections**. The two look similar at the call site (both are "the call did not go through") and mean opposite things. A limiter returning false is the system working correctly, and a dependency returning errors is the system failing.

Wiring a limiter's `false` into a breaker's failure counter produces a catastrophic failure mode: one client exhausts its own quota. The limiter correctly rejects it. Those rejections increment a failure counter that is global rather than per-key. The counter crosses the threshold, the breaker opens, and now **every** client is rejected without the limiter even being consulted, because one client used the quota it was entitled to. A single free-tier user takes down the API for everyone, and the metric that fires is "circuit open" so the on-call goes hunting for a downstream outage that does not exist.

The code below therefore separates the two signals. `Allow` consults the limiter and the breaker independently, and callers report dependency outcomes through `RecordSuccess` and `RecordFailure` after the work is actually attempted.

```go
// ... imports omitted for brevity (sync, time)

// CircuitBreakerRateLimiter pairs a rate limiter with a circuit breaker.
// The two are deliberately independent:
//   - the limiter decides whether THIS caller has quota,
//   - the breaker decides whether the DEPENDENCY is healthy enough to call.
// A request must satisfy both. Rejections by the limiter are never fed to
// the breaker.
type CircuitBreakerRateLimiter struct {
    limiter RateLimiter

    mu               sync.Mutex
    state            CircuitState
    failures         int
    successCount     int
    failureThreshold int
    successThreshold int
    openTimeout      time.Duration
    openedAt         time.Time
    probeInFlight    bool
}

type CircuitState int

const (
    CircuitClosed CircuitState = iota
    CircuitOpen
    CircuitHalfOpen
)

func NewCircuitBreakerRateLimiter(limiter RateLimiter, failureThreshold, successThreshold int, openTimeout time.Duration) *CircuitBreakerRateLimiter {
    return &CircuitBreakerRateLimiter{
        limiter:          limiter,
        state:            CircuitClosed,
        failureThreshold: failureThreshold,
        successThreshold: successThreshold,
        openTimeout:      openTimeout,
    }
}

// Allow reports whether the request may proceed. The breaker is checked
// first: if the dependency is down there is no point spending the caller's
// quota on a request that cannot succeed.
func (c *CircuitBreakerRateLimiter) Allow(key string) (bool, int, time.Time) {
    c.mu.Lock()
    defer c.mu.Unlock()

    now := time.Now()

    switch c.state {
    case CircuitOpen:
        if now.Sub(c.openedAt) < c.openTimeout {
            // Fail fast, and do NOT charge the limiter for this attempt.
            return false, 0, c.openedAt.Add(c.openTimeout)
        }
        // Cooldown elapsed: try a probe.
        c.state = CircuitHalfOpen
        c.successCount = 0
        c.probeInFlight = false
        fallthrough

    case CircuitHalfOpen:
        // Admit exactly one probe at a time. Letting every waiting request
        // through the moment the cooldown expires is the classic
        // thundering-herd bug: a recovering dependency is immediately
        // re-flattened by the backlog and the breaker reopens.
        if c.probeInFlight {
            return false, 0, now.Add(c.openTimeout)
        }
        c.probeInFlight = true
        return true, 0, now

    default: // CircuitClosed
        // Normal path: quota is the only question. A false here means this
        // caller is out of quota. It says nothing about dependency health,
        // so it must not touch c.failures.
        return c.limiter.Allow(key)
    }
}

// RecordSuccess reports that the downstream call actually succeeded.
// Call it after the work, not after Allow.
func (c *CircuitBreakerRateLimiter) RecordSuccess() {
    c.mu.Lock()
    defer c.mu.Unlock()

    switch c.state {
    case CircuitHalfOpen:
        c.probeInFlight = false
        c.successCount++
        if c.successCount >= c.successThreshold {
            c.state = CircuitClosed
            c.failures = 0
        }
    case CircuitClosed:
        c.failures = 0
    }
}

// RecordFailure reports a genuine dependency failure: a timeout, a 5xx, a
// refused connection. Never call this because the rate limiter said no.
func (c *CircuitBreakerRateLimiter) RecordFailure() {
    c.mu.Lock()
    defer c.mu.Unlock()

    switch c.state {
    case CircuitHalfOpen:
        // The probe failed: the dependency is still sick. Back to open and
        // restart the cooldown.
        c.state = CircuitOpen
        c.openedAt = time.Now()
        c.probeInFlight = false
    case CircuitClosed:
        c.failures++
        if c.failures >= c.failureThreshold {
            c.state = CircuitOpen
            c.openedAt = time.Now()
        }
    }
}

func (c *CircuitBreakerRateLimiter) State() CircuitState {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.state
}
```

### Junior → FAANG: Understanding Adaptive Rate Limiting

Static limits are easy to reason about but they embed assumptions about system capacity that become wrong whenever infrastructure changes, traffic patterns shift, or a dependency degrades. Adaptive rate limiting is the mechanism that lets the system express its own capacity at runtime rather than requiring an operator to update a config file.

The `AdaptiveRateLimiter` in this chapter is a readable entry point. The goroutine polls system metrics every 10 seconds and adjusts the effective limit up or down based on a load estimate. The code comment correctly identifies the main pitfall: `m.TotalAlloc` is a monotonically increasing lifetime counter, making `Alloc/TotalAlloc` converge toward zero over time. Goroutine count is also a weak proxy because a healthy pool-based server may sustain tens of thousands of goroutines without stress. As a first-job habit, prefer measuring what you actually care about: p99 response latency from your metrics pipeline is a far more reliable load signal than runtime memory stats.

The circuit breaker pattern is complementary. A rate limiter controls the inflow of new requests. A circuit breaker detects that a downstream dependency has failed and short-circuits calls to it, returning an immediate error instead of consuming threads waiting for a timeout. Combining both means the rate limiter protects your service from overload, while the circuit breaker prevents your service from amplifying failures into dependent systems.

The interview-grade insight is that these two must never share a signal. "The limiter rejected this caller" and "the dependency is broken" both surface as a failed call, and they demand opposite responses: the first is the system working, the second is the system failing. Feed the first into the second and one client's quota exhaustion opens the circuit for your entire user base, as shown above. If you take one thing from this section, take the habit of asking, for every failure counter you write, exactly which failures are allowed to increment it.

Interview entry point: "How would you rate limit a service whose capacity changes with traffic patterns?" The expected answer covers dynamic thresholds, feedback signals (latency, error rate, queue depth), and the difference between preventive throttling (rate limit) and reactive protection (circuit breaker).

### Senior @ FAANG: Adaptive Rate Limiting as a Platform Capability

**Concurrency-Based vs Rate-Based Control**

The `AdaptiveRateLimiter` shown here is a rate-based controller: it adjusts requests per second based on sampled metrics. The standard approach at FAANG is concurrency-based control, which limits the number of in-flight requests rather than their arrival rate.

The gradient concurrency limit algorithm, popularized by Netflix, works as follows. The system tracks `minRTT` (the lowest observed latency, representing no-load baseline) and a rolling `windowRTT` (current observed latency). The gradient is `minRTT / windowRTT`, which approaches 1 when the system is idle and drops toward 0 as queues build. The new limit is:

```
newLimit = currentLimit * gradient + sqrt(currentLimit)
```

The `sqrt(currentLimit)` addend is the allowable queue, sometimes described as a probe budget: it lets the limit grow even when the gradient is below 1, so the system can discover headroom rather than ratcheting permanently downward. Implementations also clamp the gradient (Netflix's caps it at 1 and floors it around 0.5) so that a single latency outlier cannot collapse the limit. The appeal is that it self-tunes with no hand-coded CPU or memory threshold.

Envoy's adaptive concurrency filter and Vector's adaptive request concurrency use variants of the same latency-gradient idea. Hystrix is a different animal and is often miscited here: its bulkheads use a **fixed** thread-pool or semaphore size that you configure, and its circuit breaker trips on error percentage. Nothing in Hystrix measures latency gradient or adapts the concurrency ceiling at runtime. It is a useful contrast precisely because it shows what the previous generation did instead: pick a number, and hope it is still right next quarter.

**ADR: Rate-Based vs Concurrency-Based**

For request routing and API gateway layers: concurrency-based limits are preferable because they respond directly to queue saturation, which is what causes latency SLO violations. For externally-facing per-user quotas (billing, fairness): rate-based limits with fixed windows are preferable because they are auditable, predictable for customers, and compatible with contractual SLAs. Mixing both is common: concurrency limits protect the service, rate limits protect the quota.

**Maturity Model for Adaptive Limiting**

Level 1: Static limit configured at deploy time, updated manually after incidents.
Level 2: Adaptive limit that adjusts based on sampled CPU or latency, single service.
Level 3: Propagated back-pressure: when service B slows down, service A's adaptive limiter detects the downstream latency increase and reduces its own request rate to B, preventing queue buildup at B from becoming an outage.
Level 4: Platform-managed adaptive concurrency with centralized policy, per-dependency tuning, and automatic drift alerts when the measured `minRTT` baseline rises (indicating a permanent capacity change that should trigger a capacity review).

**Governance and Safety**

An adaptive limiter that can drop a service's effective throughput to `minRate` on its own is a risk: a noisy metric, a misconfigured threshold, or a clock skew can cause the limiter to shed all traffic without a human decision. Senior engineers design safeguards: a minimum rate floor tied to SLO commitments (never drop below the rate required to serve P0 customers), alerting when the limiter has been in reduced mode for more than `N` minutes, and a kill switch that reverts to a static limit in an emergency. These controls are part of the design, not afterthoughts.

**Bar-Raiser Interview Signals**

"What happens when your adaptive limiter's load signal lags the actual load by 30 seconds?" The answer must address control loop delay, the risk of the limiter responding to a load spike that has already passed, and why derivative (rate-of-change) terms in a PID controller help reduce overshoot compared to a pure proportional response.

"How do you prevent the adaptive limiter from entering a death spiral where shedding load increases error rate, which increases perceived load, which causes more shedding?" The answer is hysteresis: require the load signal to be below the recovery threshold for a sustained window before increasing the limit, and require it to be above the reduction threshold for a sustained window before reducing, so transient spikes do not cause cascading limit drops.

---
