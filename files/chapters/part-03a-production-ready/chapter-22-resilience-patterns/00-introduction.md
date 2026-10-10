# Chapter 22: Resilience Patterns

*"Everything fails, all the time."* (Werner Vogels, Amazon CTO)

Distributed systems do not fail occasionally. They fail constantly, partially, and in combinations that no engineer anticipated during design. A network packet is delayed by 200 milliseconds. A downstream service returns 503 for 8 seconds. A database connection pool is exhausted by a spike in slow queries. A third-party API begins responding in 30 seconds instead of 30 milliseconds. In each case, the question is not whether your service will encounter the failure, but whether it will amplify that failure into a system-wide outage or absorb it gracefully. Resilience patterns are the engineering vocabulary for absorbing failures, and in Go's concurrency model they have a natural, idiomatic implementation using goroutines, channels, and context cancellation.

The circuit breaker is the foundational resilience primitive: it wraps a call to a remote dependency and monitors the success rate. When failures exceed a threshold, the breaker opens and subsequent calls fail immediately instead of blocking for a timeout. That lets the caller execute a fallback, preserve its own response time, and give the failing dependency room to recover. Exponential backoff with jitter ensures that a fleet of services retrying simultaneously after a transient failure does not create a synchronized thundering herd that overwhelms the recovering system. Bulkheads isolate resource pools by dependency, so a slow database connection pool cannot exhaust the goroutines handling unrelated user requests. Together these patterns form a layered defense that transforms binary up/down reliability into a graceful degradation spectrum.

Netflix coined the term "chaos monkey" partly to validate that resilience patterns actually worked under real failure conditions, because patterns implemented incorrectly provide false confidence. A recurring lesson from public engineering write-ups is that circuit breakers without proper fallbacks merely shift failure modes rather than preventing them, and that improper retry amplification during a partial outage can turn a small error rate into a near-total one within seconds. Amazon's AWS SDKs include jitter by default in their retry logic, a direct response to the well-documented way synchronized client retries extend outages. These lessons shape the specific design choices you will make in this chapter.

**What you'll learn in this chapter:**

- How to implement a circuit breaker from scratch and integrate `sony/gobreaker` or `failsafe-go` for production use, with proper state transitions and metrics
- How to design retry strategies with exponential backoff, full jitter, and per-attempt deadlines that prevent thundering herd under partial outages
- How to build bulkheads using separate goroutine pools and semaphores so one slow dependency cannot starve unrelated request paths
- How to implement token-bucket and sliding-window rate limiters using `golang.org/x/time/rate` and distributed Redis-backed variants
- How to compose fallback chains (cached responses, degraded feature sets, static defaults) that preserve partial functionality when dependencies fail
- How to set context-propagated timeouts at the correct layer (client call, total request, individual retry) to prevent unbounded waits
- How to combine circuit breakers, retries, and bulkheads into a coherent resilience policy using the `failsafe-go` or `sony/gobreaker` policy APIs. The community `hystrix-go` port is unmaintained and should not be used for new code, and Netflix's original Hystrix, a Java library, entered maintenance mode in 2018
- How to instrument resilience patterns with Prometheus metrics so circuit breaker state changes and retry rates appear in your dashboards

**Why this matters at scale:**

Netflix's Hystrix library popularized many modern circuit breaker implementations as a response to slow dependencies causing cascading outages. Adding jitter to retry logic measurably reduces retry-storm amplification during partial outages. Amazon's AWS SDK v2 includes full jitter by default, after historical incidents demonstrated that synchronized retries can extend outage duration by an order of magnitude. Payment and other correctness-critical tiers commonly use layered bulkheads so that a degraded non-critical service (fraud scoring, recommendations) never impacts the critical execution path.

**Prerequisites:** Chapters 1, 21. Comfort with Go's `context` package, goroutines, and HTTP client usage.

> **For readers new to distributed systems:** these patterns are essential but easy to get wrong. Use battle-tested libraries rather than hand-rolling.
>
> **For readers already senior at a FAANG-equivalent:** the primary takeaway is combining patterns correctly. Individual patterns help. Combined incorrectly, they amplify failures.

**Chapter navigation by career stage.**

- **Junior:** understand each pattern individually.
- **Senior:** learn to combine them. Layered defense with proper interaction.
- **Staff or Principal:** architectural question is whether the service mesh handles this or the app does. Drive the decision and consistency.

**Staff and Principal lens: resilience patterns without measurement cause outages.** A circuit breaker with wrong thresholds is worse than none. Retries without jitter amplify failures. Instrument every resilience primitive with metrics and validate behavior under realistic failure conditions before trusting them.

**Go version note.** Modern Go services often delegate resilience to the service mesh (Envoy, Linkerd, Istio). Application-level patterns remain relevant for in-process or library code, but check whether your mesh already handles it before implementing.

---
