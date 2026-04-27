export default `## 12.12 Interview Questions

Concurrency-pattern questions test whether you can pick the right shape for a problem and implement it without leaks, deadlocks, or unbounded resource use. Interviewers expect candidates to name the standard library or community tool that solves a problem before rolling their own.

> **What FAANG actually tests here**: pattern selection with tradeoffs, backpressure and cancellation wiring, and awareness that \`golang.org/x/sync/errgroup\`, \`golang.org/x/time/rate\`, and well-known libraries (\`sony/gobreaker\`, \`cenkalti/backoff\`) are usually better than hand-rolled versions in production.

### Question 1: When Would You Use Fan-Out/Fan-In vs Worker Pool?

**What FAANG expects**: clear criteria based on job duration, shared resources, and lifecycle. Strong candidates mention that \`errgroup.Group.SetLimit(n)\` is the idiomatic bounded-parallel pattern in modern Go.

**Answer:**

**Fan-Out/Fan-In:**
- Best for processing independent items with variable work
- Each worker processes different data from shared input
- Natural for pipelines where stages can parallelize
- Workers are created per-fan-out, not reused

**Worker Pool:**
- Best for high-throughput with reusable workers
- Workers are long-lived and process many jobs
- Better for resource management (connection pools, etc.)
- Easier to monitor and scale dynamically

Choose worker pool when:
- Jobs need shared resources (DB connections, etc.)
- You need precise control over concurrency
- Jobs have similar processing time
- You want to avoid goroutine creation overhead

Choose fan-out when:
- Processing is CPU-bound with independent items
- Work naturally fits pipeline stages
- Each item might need different processing time
- Simpler code is preferred

For most practical work in modern Go, \`errgroup.Group.SetLimit(n)\` gives you a bounded parallel runner with error propagation and cancellation built in. Reach for a hand-rolled worker pool only when you need features errgroup does not cover (long-lived workers holding per-worker state, priority queues, multi-phase pipelines).

**Follow-ups**:
- How does \`errgroup\` propagate the first error and cancel in-flight work?
- When would you prefer the \`conc\` package from sourcegraph over errgroup?

### Question 2: How Do You Implement Backpressure?

**What FAANG expects**: at least three distinct strategies (bounded buffers, drop-on-full, rate limiting) plus honest tradeoffs between latency, loss, and memory. Backpressure questions are a staple for senior backend interviews.

**Answer:**

Backpressure prevents fast producers from overwhelming slow consumers:

1. **Bounded channels**: Natural backpressure through blocking
\`\`\`go
jobs := make(chan Job, 100)  // Producer blocks when full
\`\`\`

2. **Dropping**: Drop items when overloaded
\`\`\`go
select {
case ch <- item:
default:
    metrics.Increment("dropped")
}
\`\`\`

3. **Sampling**: Process every Nth item
\`\`\`go
if atomic.AddInt64(&counter, 1) % 10 == 0 {
    process(item)
}
\`\`\`

4. **Rate limiting**: Control throughput explicitly
\`\`\`go
limiter := rate.NewLimiter(100, 10)
limiter.Wait(ctx)
process(item)
\`\`\`

5. **Feedback loops**: Consumer signals capacity
\`\`\`go
type Job struct {
    Data     any
    Feedback chan<- int  // Consumer sends capacity
}
\`\`\`

**Follow-ups**:
- What are the observable symptoms of each backpressure strategy failing (memory growth, latency spike, sudden drops), and how would you alert on them?
- When is dropping the right choice over blocking, and how do you decide what to drop?

### Question 3: Explain Circuit Breaker States

**What FAANG expects**: the three states, correct transition conditions, and awareness that production code should use \`sony/gobreaker\` or a framework-provided breaker rather than a hand-rolled one. Bonus: you know that circuit breakers compose with timeouts and retries, and the retry-on-open anti-pattern.

**Answer:**

Circuit breakers have three states:

**Closed (Normal):**
- Requests flow through normally
- Failures are counted
- Transitions to Open when failure threshold exceeded

**Open (Failing Fast):**
- Requests fail immediately without execution
- Protects downstream services
- After timeout, transitions to Half-Open

**Half-Open (Testing):**
- Limited requests allowed through
- If they succeed, transitions to Closed
- If they fail, transitions back to Open

Key parameters:
- Failure threshold: How many failures trigger Open
- Success threshold: How many successes close the circuit
- Timeout: How long to stay Open before testing

**Follow-ups**:
- Why is retrying a call that just hit an open circuit often wrong, and how do you express that correctly in a resilience layer?
- How does a circuit breaker differ from a rate limiter, and when do you need both?

### Question 4: Design a Rate Limiter for an API

**What FAANG expects**: a layered design (global + per-user), awareness that \`golang.org/x/time/rate\` provides token bucket out of the box, and knowledge that distributed rate limiting across many pods typically needs Redis or a purpose-built service (e.g., Envoy's RLS).

**Answer:**

A production API rate limiter typically combines multiple layers: a global limiter that caps total throughput to protect infrastructure, and a per-user limiter that prevents any single caller from monopolizing capacity. The \`Allow\` method checks the global limit first (cheaper, rejects broad overload immediately), then the per-user limit. The \`Wait\` variant blocks until both layers have capacity, respecting context cancellation so callers can time out rather than queue indefinitely.

\`\`\`go
type APIRateLimiter struct {
    // Per-user rate limiting
    userLimiters *PerKeyLimiter

    // Global rate limiting
    globalLimiter *SlidingWindowLimiter

    // Burst allowance
    burstTokens *TokenBucket
}

func (rl *APIRateLimiter) Allow(userID string) (bool, error) {
    // Check global limit first
    if !rl.globalLimiter.Allow() {
        return false, ErrGlobalLimitExceeded
    }

    // Check per-user limit
    if !rl.userLimiters.Allow(userID) {
        return false, ErrUserLimitExceeded
    }

    return true, nil
}

func (rl *APIRateLimiter) Wait(ctx context.Context, userID string) error {
    // Wait for global limit
    if err := rl.globalLimiter.Wait(ctx); err != nil {
        return err
    }

    // Wait for per-user limit
    return rl.userLimiters.Wait(ctx, userID)
}
\`\`\`

**Follow-ups**:
- How do you rate-limit consistently across 100 pods behind a load balancer? What are the tradeoffs of Redis-based limiting versus client-side token allocation?
- How would you communicate the limit back to clients (headers, status codes) and what retry semantics should they use?

### Question 5: How Would You Test Concurrent Code?

**What FAANG expects**: the race detector is always step 1, plus two or three more techniques (goroutine-count check, \`goleak\`, \`testing/synctest\` in 1.25+, stress iteration). Candidates who skip the race detector in an answer fail the senior bar.

**Answer:**

1. **Race detector**: \`go test -race\`

2. **Table-driven tests with goroutines**: spawn many goroutines that exercise the same function simultaneously to surface data races.
\`\`\`go
func TestConcurrentAccess(t *testing.T) {
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            result := functionUnderTest(n)
            assert(t, result)
        }(i)
    }
    wg.Wait()
}
\`\`\`

3. **Stress testing**: Run tests many times
\`\`\`bash
for i in {1..100}; do go test -race ./...; done
\`\`\`

4. **Deterministic testing**: use channels as barriers to enforce a specific execution order, removing scheduler nondeterminism from the test.
\`\`\`go
func TestOrdering(t *testing.T) {
    step1 := make(chan struct{})
    step2 := make(chan struct{})

    go func() {
        <-step1
        doFirst()
        close(step2)
    }()

    close(step1)
    <-step2
    doSecond()
}
\`\`\`

5. **testing/synctest (experiment in 1.24, stable in 1.25, preferred API \`synctest.Test\`)**: run the test inside a goroutine bubble with a virtual clock, and call \`synctest.Wait()\` to block until every goroutine in the bubble is finished or durably blocked. Removes scheduler flakiness entirely for code that can be isolated into a bubble. On Go 1.25 use \`synctest.Test(t, func(t *testing.T){...})\`, the older \`synctest.Run\` form is deprecated.

**Follow-ups**:
- Why does \`go test -race\` slow tests 2-20x and use 5-10x more memory? When should you run it?
- How would you detect data races that the race detector misses? (hint: races only show if triggered during the run)

### Q (Senior track): When would you reject each of the patterns in this chapter?

**What FAANG expects**: pattern-selection judgment, showing you know when each pattern is overkill or wrong.

**Answer**:

- **Generator.** Reject when \`iter.Seq\` or a plain slice works. Channel-based generators are for cross-goroutine production, not lazy in-goroutine iteration.
- **Pipeline.** Reject when the stages are not genuinely independent. If every stage is fast CPU work, a tight for-loop is faster than channel hops.
- **Fan-out.** Reject when work items are small (overhead dominates) or when ordering matters (fan-out reorders results).
- **Worker pool.** Reject when \`errgroup.SetLimit\` is enough. Long-lived pools are for connection reuse or warmup cost.
- **Pub/sub.** Reject when the coupling would be better as synchronous calls. Pub/sub introduces async complexity; use it when you need the decoupling benefit.
- **Rate limiting.** Reject when the downstream handles it. Do not rate-limit in your service if the service mesh or the downstream's own rate limiter is the source of truth.
- **Circuit breaker.** Reject when failures are rare and retries are cheap. The breaker adds state complexity; skip when the downstream is reliable.
- **Retry.** Reject for non-idempotent operations without idempotency keys. Reject when the error is terminal (4xx business errors).
- **Broadcast.** Reject when \`context.Context\` fits. Custom broadcast primitives are rarely necessary.
- **Sharding.** Reject without profile evidence of contention. Sharding is a last-resort optimisation.

Knowing when not to apply a pattern is as valuable as knowing when to apply it. This question separates engineers who reach for patterns reflexively from engineers who reach for them deliberately.

### Q (Staff track): You are designing a service that fans out to 50 downstream services per request. Walk through the concurrency architecture.

**What FAANG expects**: a layered answer covering fan-out width, per-dependency circuit breakers, rate limits, timeouts, error propagation, and observability.

**Answer**:

- **Fan-out width.** Cap the per-request fan-out at the number of genuinely independent downstreams. If requests actually need all 50, the architecture is questionable. Usually the answer is "5 critical, 45 optional".
- **Per-dependency concurrency limits.** Each downstream has its own semaphore. A slow downstream cannot exhaust the pool.
- **Per-dependency circuit breakers.** Separate breakers per downstream. One bad downstream does not trip the whole service.
- **Per-dependency rate limits.** If the downstream has a contract rate, honour it with \`golang.org/x/time/rate\`.
- **Per-dependency timeouts.** Each call has a deadline derived from the request deadline minus a buffer. Never propagate the full request deadline to a downstream (leaves no time for response handling).
- **errgroup with context.** First error cancels remaining calls. Partial results are acceptable for non-critical downstreams (set error-to-warning for those).
- **Observability.** Metrics per downstream (latency, success rate, circuit-breaker state), tracing spans per call, structured logs with correlation IDs.
- **Graceful degradation.** When critical downstreams fail, the request fails. When optional downstreams fail, the response includes what succeeded.

This is the shape of a mature fan-out service. Teams that do not design for this fail at scale in predictable ways: one slow downstream blocks everything, no per-downstream observability makes diagnosis impossible, missing timeouts cause goroutine leaks.

**Follow-ups**:
- How do you handle the case where some downstreams are internal and rate-free, others are third-party and rate-limited?
- What is the testing strategy for a service with 50 downstream integrations?

---
`;
