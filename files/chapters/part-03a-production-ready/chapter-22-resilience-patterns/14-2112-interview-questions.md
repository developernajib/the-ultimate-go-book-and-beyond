## 22.12 Interview Questions

### Question 1: Explain the Circuit Breaker Pattern

**What FAANG expects:** The three states and the transitions between them, plus the design decisions that make a breaker actually useful: what counts as a "failure" (5xx yes, 4xx no, context cancellation maybe), the difference between consecutive-failure and failure-ratio triggers, and why per-endpoint or per-dependency scoping matters. Bonus for naming production libraries (`sony/gobreaker`, `failsafe-go`) instead of implying you would write one from scratch.

**Answer**: The circuit breaker pattern prevents cascading failures by wrapping calls to external services. It has three states:

1. **Closed**: Normal operation. Requests pass through. Failures are counted.
2. **Open**: After failure threshold reached, requests fail immediately without calling the service.
3. **Half-Open**: After timeout, a limited number of requests are allowed to test if the service recovered.

Key considerations:
- Failure threshold and timeout must be tuned per service
- Should be applied per-endpoint, not globally
- Metrics are essential for monitoring circuit state
- Fallbacks provide graceful degradation when circuit is open

**Follow-ups:**
- *Should a 4xx error trip the breaker?* Usually no. A 400 means the caller sent garbage, the downstream is healthy. Tripping on 4xx hides client bugs behind a false "dependency unhealthy" signal. Only 5xx and connection errors should count.
- *What goes wrong with a single global breaker across many endpoints?* One flaky endpoint trips the breaker and takes down every other endpoint on the same host. Always scope breakers per logical dependency (per gRPC method or per REST route).
- *How do you tune the half-open probe count?* Too few and a recovering service stays "open" forever because one straggler fails. Too many and you hammer a wobbly downstream back into overload. Typical values: 1-5 concurrent probes, measured by `MaxRequests` in gobreaker.

### Question 2: How Would You Prevent Retry Storms?

**What FAANG expects:** Name all three ingredients that cause the storm (synchronized clients + no backoff + unbounded retries) and pair each with a mitigation. Bonus for referencing AWS's canonical "full jitter" recommendation, Google SRE's retry budget pattern (cap retries as a fraction of total request rate, typically 10%), and deadline propagation so retries do not outlive the original request budget.

**Answer**: Retry storms occur when many clients retry simultaneously, overwhelming a recovering service. Prevention strategies:

1. **Exponential backoff**: Increase wait time between retries
2. **Jitter**: Add randomization to prevent synchronized retries
3. **Retry budgets**: Limit retry ratio (e.g., max 10% of requests can be retries)
4. **Circuit breakers**: Stop retries entirely when service is unhealthy
5. **Client-side load balancing**: Retry to different instances
6. **Deadline propagation**: Stop retrying when deadline is exhausted

The following `SmartRetrier` combines all six strategies into a single decision function that checks the circuit breaker, retry budget, and remaining deadline before computing a jittered backoff delay:

```go
// Implementing all strategies
type SmartRetrier struct {
    budget         *RetryBudget
    circuitBreaker *CircuitBreaker
    maxWait        time.Duration
}

func (r *SmartRetrier) ShouldRetry(attempt int, deadline time.Time) (bool, time.Duration) {
    // 1. An open breaker means the dependency is known-bad. Do not retry
    //    into it, and do not sleep first: fail now so the caller can fall back.
    if r.circuitBreaker.State() == StateOpen {
        return false, 0
    }

    // 2. Retry budget: caps the FLEET's retry rate, not just this call's.
    if !r.budget.CanRetry() {
        return false, 0
    }

    // 3. Exponential ceiling, capped.
    ceiling := time.Second * time.Duration(math.Pow(2, float64(attempt)))
    if ceiling > r.maxWait {
        ceiling = r.maxWait
    }

    // 4. FULL jitter: draw uniformly from [0, ceiling). Not `ceiling + rand`,
    //    which only ever makes the wait longer and leaves every client
    //    clustered just above the same instant.
    wait := time.Duration(rand.Int64N(int64(ceiling)))

    // 5. Deadline check: never start an attempt that cannot finish. Note this
    //    compares against the WAIT alone, so it should really budget for the
    //    attempt itself too (wait + p99 latency).
    if time.Now().Add(wait).After(deadline) {
        return false, 0
    }

    return true, wait
}
```

Watch the jitter arithmetic in an interview. `baseWait + rand(...)` is the reflex, and it is backwards: it treats the exponential value as a *floor* and only ever adds delay, so clients stay bunched together just above `baseWait` and wait longer than necessary. Full jitter treats it as a *ceiling* and draws below it, which both de-correlates the fleet and lowers the mean wait.

**Follow-ups:**
- *Full jitter vs equal jitter vs decorrelated jitter, when do you pick which?* Full jitter (`wait = random(0, cap*2^n)`) is the AWS default and wins in most scenarios. Equal jitter (`base/2 + random(0, base/2)`) keeps a floor, useful when you need a minimum polling interval. Decorrelated jitter has worse convergence properties in practice. Default to full jitter.
- *What is a retry budget and where do you enforce it?* A per-client (or per-deployment) cap on total retry volume as a fraction of base traffic, typically 10%. Enforced at the retry interceptor level so a pathological loop cannot consume 100x the intended load. gRPC's hedging policy and Envoy's `retry_budget` both implement this.
- *Why are non-idempotent retries dangerous?* A POST retried after a timeout may have succeeded server-side, so the retry creates a duplicate. Fix with client-generated idempotency keys that the server dedupes on, the pattern Stripe documented and everyone copied.

### Question 3: Design a Rate Limiter for a Distributed System

**What FAANG expects:** Compare local (`golang.org/x/time/rate`) vs distributed (Redis, dedicated rate-limit service), explain the algorithm trade-offs (fixed window has boundary burst, sliding window is smoother but more expensive, token bucket allows configurable burst), and address the failure mode, what happens when Redis is down? The "right" answer is fail-open with local fallback, because failing-closed turns a rate-limiter outage into a full outage.

**Answer**: For distributed systems, rate limiting requires coordination across instances. A single-process token bucket does not work when traffic is spread across multiple replicas, each instance would enforce its own independent limit, allowing the aggregate to exceed the intended cap. A Redis-backed sliding window stores timestamped entries in a sorted set, giving atomic cross-instance enforcement with a single round-trip:

```go
// Redis-based sliding window rate limiter
type DistributedRateLimiter struct {
    redis  *redis.Client
    key    string
    limit  int
    window time.Duration
}

func (r *DistributedRateLimiter) Allow(ctx context.Context, identifier string) (bool, error) {
    key := fmt.Sprintf("%s:%s", r.key, identifier)
    now := time.Now().UnixMicro()
    windowStart := now - r.window.Microseconds()

    pipe := r.redis.Pipeline()

    // Remove old entries
    pipe.ZRemRangeByScore(ctx, key, "0", strconv.FormatInt(windowStart, 10))

    // Count current entries
    countCmd := pipe.ZCard(ctx, key)

    // Add new entry
    pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: now})

    // Set expiry
    pipe.Expire(ctx, key, r.window)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return false, err
    }

    return countCmd.Val() < int64(r.limit), nil
}
```

**Follow-ups:**
- *Fail-open or fail-closed when Redis is unavailable?* Fail-open with a conservative local bucket as fallback. A rate limiter is an *enabler* of capacity. Taking the service down because the limiter is down trades one outage for a worse one. Document this trade-off explicitly in the runbook.
- *How do you handle hot keys (one tenant dominates one Redis shard)?* Shard by `hash(tenant_id % shard_count)` and run multiple Redis instances. For extreme outliers, pre-allocate a dedicated limiter shard per whale tenant.
- *Where should the rate limiter live, client, API gateway, or service?* API gateway (Envoy, Kong, or a dedicated tier) is the pragmatic answer: one place to enforce, visible to operators, and removes the concern from every service owner. Per-service limits can layer on top for internal fairness.

### Question 4: How Do You Test Resilience Patterns?

**What FAANG expects:** A pyramid: unit tests with injected errors, integration tests with real dependencies via testcontainers, chaos tests (Toxiproxy, Chaos Mesh, or in-house fault injection) in staging, and finally GameDays in production with blast-radius controls. Calling out `testing/synctest` (Go 1.25+) for deterministic timeout/retry tests is a strong signal.

**Answer**: Testing resilience requires simulating failures at multiple levels:

1. **Unit tests**: Mock dependencies to return errors
2. **Integration tests**: Use testcontainers or docker-compose
3. **Chaos testing**: Inject failures in staging/production
4. **Load testing**: Verify behavior under stress

This test drives the circuit breaker through a full state cycle, closed to open via consecutive failures, then open to half-open after the configured timeout elapses:

```go
func TestCircuitBreakerOpens(t *testing.T) {
    cb := circuit.New("test", circuit.Settings{
        MaxRequests: 3,
        Timeout:     100 * time.Millisecond,
        ReadyToTrip: func(c circuit.Counts) bool {
            return c.ConsecutiveFailures > 2
        },
    })

    // Force failures
    for i := 0; i < 3; i++ {
        cb.Execute(func() (any, error) {
            return nil, errors.New("failure")
        })
    }

    assert.Equal(t, circuit.StateOpen, cb.State())

    // Wait for half-open
    time.Sleep(150 * time.Millisecond)
    assert.Equal(t, circuit.StateHalfOpen, cb.State())
}
```

**Follow-ups:**
- *Why is `time.Sleep(150ms)` a bad signal in this test?* Wall-clock sleeps make tests flaky on loaded CI and slow to run in aggregate. Use `testing/synctest` (stable in Go 1.25) to virtualize time, or inject a clock interface so the test can advance time deterministically.
- *What does Toxiproxy let you test that unit mocks cannot?* Real TCP-level faults: packet loss, latency injection, bandwidth limits, connection drops mid-response. These catch bugs that pure error-return mocks miss (keepalive pools, write buffers, TLS handshake timeouts).
- *What are the blast-radius controls for chaos in production?* Percentage-of-traffic gates, tenant allowlists, automatic abort on SLO burn-rate alert, and a big red button in the runbook. Without them, chaos engineering becomes chaos.

### Question 5: Explain Bulkhead Pattern and When to Use It

**What FAANG expects:** The "ship with watertight compartments" analogy is fine as a hook, but the technical answer is: separate semaphores or connection pools per dependency, sized so that one slow dependency cannot exhaust resources the other dependencies need. Bonus for calling out that adaptive concurrency (Netflix concurrency-limits) self-tunes the bulkhead size based on measured latency gradient, which beats static sizing at scale.

**Answer**: The bulkhead pattern isolates failures by partitioning resources, preventing a failure in one component from consuming all resources and affecting others.

Use cases:
- **Connection pools**: Separate pools per service
- **Thread/goroutine pools**: Limit concurrent requests per dependency
- **Memory**: Separate memory allocations for different features

```go
// Service-level isolation
type ServiceIsolator struct {
    payments  *Bulkhead // Critical path
    analytics *Bulkhead // Can degrade
    logging   *Bulkhead // Best effort
}

func NewServiceIsolator() *ServiceIsolator {
    return &ServiceIsolator{
        payments:  NewBulkhead(50),  // High priority
        analytics: NewBulkhead(10),  // Lower priority
        logging:   NewBulkhead(5),   // Lowest priority
    }
}
```

Key insight: When the analytics service slows down, it won't affect payment processing because they have isolated resource pools.

**Follow-ups:**
- *How do you size a bulkhead?* Starting formula: `limit = target_RPS * P99_latency_seconds * safety_factor` (1.5x is common). Monitor rejection rate and adjust. If rejection > 2% at normal load, the bulkhead is undersized.
- *What is adaptive concurrency and how does it beat static bulkheads?* Measures `gradient = minRTT / currentRTT`. Gradient < 1 means latency is inflating under load, reduce the limit. Gradient ≈ 1 means headroom, grow it. Self-tunes in response to the real downstream state without operator intervention. Netflix's `concurrency-limits` is the reference implementation.
- *Bulkhead vs rate limiter, what is the difference?* Rate limiter caps requests-per-second (temporal), bulkhead caps concurrent-in-flight (spatial). A slow dependency with normal RPS still exhausts a bulkhead but passes a rate limiter. Use both, they cover different failure modes.

### Q (Staff track): When does resilience belong in the app vs the service mesh?

**Answer**: Mesh handles it if you have one. Otherwise app handles it.

Mesh advantages: consistent across languages, centralized observability, no per-service implementation. Mesh disadvantages: another dependency to operate, some patterns (content-aware retry, domain-specific fallback) are harder.

For new orgs: start with mesh if infrastructure is ready, otherwise in the app. Do not implement both in the same service, because the interaction is hard to reason about.

---
