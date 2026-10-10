## Summary

Resilience patterns transform binary "up or down" availability into a spectrum of graceful degradation. Each pattern addresses a different failure mode, and their real power comes from composition: rate limiting gates traffic before it reaches the circuit breaker, the circuit breaker stops retries against a dead service, and bulkheads keep one slow dependency from starving unrelated request paths.

| Pattern | Purpose | Go Primitive | The detail that decides whether it works |
|---------|---------|--------------|------------------------------------------|
| Circuit Breaker | Fail fast on unhealthy dependencies | State machine with `sync.Mutex` | Gate half-open on probes **in flight**, not probes completed |
| Retry | Handle transient failures with backoff | `time.After` + `context.Done` select | **Full** jitter (`random(0, backoff)`), plus a budget and a deadline |
| Timeout | Bound operation duration | `context.WithTimeout` | One per attempt *and* one for the whole operation |
| Bulkhead | Isolate failures per dependency | Buffered channel as semaphore | A timeout **inside** it, or slots are never returned |
| Rate Limiting | Protect from overload | `golang.org/x/time/rate` | A stable key (never `RemoteAddr`) and eviction |
| Fallback | Graceful degradation | Function chaining | Do not fall back on cancellation, and count every degradation |
| Health Check | Monitor system health | Concurrent goroutine probes | Per-check timeouts, and liveness must not check dependencies |

The last column is the point of the chapter. Every one of these patterns is easy to implement in a way that compiles, passes tests, looks right in review, and does nothing (or actively harms you) during the outage it was written for. A half-open gate that counts completed probes admits an unbounded stampede. A `±10%` jitter is not jitter. A rate limiter keyed on `IP:port` never limits. A bulkhead without an inner timeout converts a slow dependency into a permanently unreachable one.

**Ordering.** Rate limiting runs outermost (cheapest check first), then the bulkhead, then retry, then the circuit breaker, then a per-attempt timeout, with a fallback wrapping the whole thing. The retry/breaker nesting is a real decision rather than a convention: retry outside the breaker (as `failsafe-go` composes it) lets the breaker vote on every attempt and trips it promptly, while the breaker outside retry gives each logical operation one vote but needs far more traffic to trip. Whichever you choose, an open-circuit error must never be treated as retryable, or the retry loop sleeps through its full backoff schedule to re-ask a breaker that will keep saying no.

Instrument every resilience layer with metrics. A circuit breaker that opens silently is worse than no circuit breaker at all, because operators cannot distinguish between "working correctly" and "silently dropping traffic." Prometheus counters on state transitions, rejection rates, and retry counts make failure handling observable and tunable in production.

### For the Senior-at-FAANG Track

The practical payoff is layered defense: no single pattern is enough, so combine them correctly. Enforce in review.

### For the Staff and Principal Track

Decide mesh vs app. Drive consistency. Validate via chaos testing. Treat resilience as architectural, not per-service.

### Mental Model to Take Away

Distributed systems fail constantly. Resilience patterns absorb failures gracefully. A well-designed service degrades instead of collapsing. Build resilience in from day one, validate with chaos, and tune with metrics.

---
