## Summary

Rate limiting and throttling essentials:

1. **Algorithms**: Fixed window, sliding window, token bucket, leaky bucket, each with specific trade-offs
2. **Distributed Limiting**: Redis with Lua scripts for atomic operations across multiple instances. In-process limiters, including `golang.org/x/time/rate`, do not coordinate across replicas at all
3. **Tiered Limits**: Different limits for user tiers with cost-based limiting for expensive operations
4. **Company Patterns**: Cloudflare's approximated sliding window at the edge, Discord's bucket system with runtime bucket discovery, Stripe's layered per-second and concurrency limits
5. **Adaptive Limiting**: Adjust limits based on system load and health
6. **Headers**: The IETF draft's `RateLimit` and `RateLimit-Policy`, plus `Retry-After` on 429
7. **Monitoring**: Prometheus metrics with alerts for high rejection rates
8. **Resilience**: Fail open on Redis errors, circuit breakers, fallback to local limiting

### Junior → FAANG: Using This Summary as an Interview Scaffold

The eight points in this summary map directly onto FAANG system design interview dimensions. Before your interview, practice stating each point in one sentence without looking at notes. If you can do that, you have the vocabulary. Here is how to go deeper on each.

**Algorithms (point 1):** Know the default hierarchy. Sliding window counter for general APIs (O(1) space, good accuracy). Token bucket when clients legitimately burst (mobile apps, batch jobs). Leaky bucket only when the downstream cannot absorb spikes and you need traffic shaping. Fixed window only when simplicity is the dominant constraint. Be able to say this in under 30 seconds.

**Distributed limiting (point 2):** The phrase "Lua scripts for atomic operations" is necessary but not sufficient. Also say: "Lua runs atomically on the Redis instance, which means read-check-write is a single uninterruptible operation with no race condition across replicas." That is the sentence that shows you understand why Lua is used, not just that it is used.

**Tiered limits (point 3):** Mention that tiers must be stored in a config source that does not require a deploy to change. If your tier limits are constants in source code, a limit increase for an enterprise customer requires a deploy and a prod cut. That is not acceptable at FAANG scale.

**Adaptive limiting (point 5):** If you can name one external reference, name Netflix/concurrency-limits. It is open-source and implements the gradient algorithm. Naming it signals you have done reading beyond textbooks.

**Headers (point 6):** Be exact here, because half-remembered header names are a cheap tell. `429 Too Many Requests` comes from RFC 6585 and `Retry-After` from RFC 9110. The rate limit fields themselves come from `draft-ietf-httpapi-ratelimit-headers`, which is **still a draft, not an RFC**, and which consolidated its earlier `RateLimit-Limit` / `-Remaining` / `-Reset` trio into a single `RateLimit` header (`RateLimit: "default";r=50;t=30`) paired with `RateLimit-Policy` (`"default";q=100;w=60`). Most deployed APIs still emit the unstandardised GitHub-style `X-RateLimit-*`. Know that `Retry-After` belongs on the 429, not on every response.

**Resilience (point 8):** The phrase "fail open on Redis errors" needs a qualifier: "fail open for critical paths, fail closed or conservative for non-critical paths." Without that qualifier, an interviewer will ask you "so you would fail open on a login endpoint?" and you have painted yourself into a corner.

### Senior @ FAANG: What This Summary Omits and Why It Matters

The summary covers mechanism. A senior engineer is accountable for the three things the summary does not address: operability, evolvability, and organizational fit.

**Operability:**

A rate limiter that works in tests but cannot be debugged in production is not production-ready. Ask yourself: when the on-call engineer sees a spike in `ratelimit_requests_rejected_total`, what is their runbook? The runbook needs: how to identify which key is being limited most aggressively, how to temporarily raise a limit without a deploy, how to distinguish a legitimate traffic spike from an attack, and how to verify that a Redis failover did not leave the circuit breaker stuck open. None of this is in the code. It is in the runbook, the dashboard, and the oncall rotation.

**Evolvability:**

Rate limiting requirements change. Free tier limits change when pricing changes. Enterprise customers negotiate custom limits. New attack patterns require new limit dimensions. A rate limiting system designed for today's requirements will be re-architected in 18 months if it cannot absorb these changes cheaply. The key design decision: externalize all limit values into a config service, and make the rate limiter key structure extensible (add a new dimension without changing the Redis key schema). If adding "per-tenant" limiting requires a Redis migration, you have a design debt that will cost two weeks of work when a large enterprise customer signs.

**Organizational fit:**

At most companies, rate limits are owned by multiple teams simultaneously. The platform team owns the mechanism. The product team owns the user-facing limits. The security team owns the abuse thresholds. The sales team negotiates enterprise custom limits. Without explicit ownership documented in a runbook or wiki, every incident becomes a blame-assignment exercise. A senior engineer proposes a RACI before writing code. At FAANG, the governance model is as important as the technical design.

**The one metric most teams skip:**

Client retry amplification ratio. When you reject a request with 429, what fraction of clients retry within one second? If 80% retry immediately (because you did not include `Retry-After`, or clients ignore it), your effective load after a limit event is 1.8x the incoming load. A good rate limiter measures this: track `retry_within_1s_after_429` as a counter, and alert if it exceeds 20% of rejections. If it is high, clients are not respecting your `Retry-After` header, which means your API documentation is wrong, your SDKs are not implemented correctly, or you are not setting the header on every 429 response.

**The summary in one sentence for an interview opening:**

"Rate limiting is a distributed coordination problem where the right algorithm, the right failure contract, and the right observability matter more than any single implementation detail."

---
