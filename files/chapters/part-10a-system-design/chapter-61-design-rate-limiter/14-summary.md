## Summary

This chapter walked through building rate limiters from single-process algorithms to distributed, multi-tier enforcement:

- **Algorithm trade-offs**: Token bucket allows controlled bursts (good for API clients that batch requests). Sliding window counter provides strict enforcement with O(1) memory. Sliding window log gives exact accuracy but at O(n) memory cost
- **Distributed enforcement**: Redis Lua scripts make the check-and-decrement sequence atomic, eliminating the TOCTOU race condition that plagues separate GET/INCR patterns
- **Multi-tier limiting**: Combining per-second, per-minute, and per-day limits catches both short bursts and sustained abuse, with checks ordered from most restrictive to least restrictive for early short-circuiting
- **Middleware integration**: HTTP middleware returns standard `X-RateLimit-*` headers and `Retry-After` on 429 responses, and gRPC interceptors return `codes.ResourceExhausted` with retry metadata
- **Graceful degradation**: Circuit-breaker-guarded Redis with local in-memory fallback prevents the rate limiter itself from becoming a single point of failure

The central design tension is accuracy versus latency: a synchronized Redis check on every request gives exact distributed counts but adds a network round trip, while local probabilistic counting is fast but approximate. Most production systems use a hybrid, exact counts for billing-critical limits, approximate counts for abuse prevention at the edge.

### Junior → FAANG: Summary as an Interview Preparation Checklist

The six bullet points at the start of this summary capture the six dimensions of rate limiter design that interviewers probe. Use them as a checklist before your interview.

**Algorithm trade-offs.** Can you explain token bucket vs sliding window counter without looking at notes? Can you derive which is appropriate for a given use case in under 30 seconds? Practice stating: "Token bucket for bursty API clients, sliding window counter for strict quota enforcement, fixed window only for trusted internal services."

**Distributed enforcement.** Can you explain why Lua scripts are necessary? Can you describe what happens if you use GET + INCR without a Lua script (TOCTOU race)? Can you explain what Redis WATCH/MULTI does and why it is insufficient for conditional increment?

**Multi-tier limiting.** Can you describe why per-second, per-minute, and per-day tiers are complementary rather than redundant? Can you explain why you check the most restrictive tier first?

**Middleware integration.** Can you name the three standard X-RateLimit headers and what each means? Can you explain the difference between `Retry-After` (seconds to wait before retry) and `X-RateLimit-Reset` (Unix timestamp when the window resets)?

**Graceful degradation.** Can you explain the fail-open principle and when fail-closed is appropriate? Can you describe a circuit breaker in terms of open, half-open, and closed states?

**Pitfalls.** Can you explain the boundary burst problem and its solution? Can you explain why IP-based rate limiting fails for enterprise clients behind NAT?

---

### Senior @ FAANG: The Rate Limiter as Platform Infrastructure

At L6/L7, the rate limiter chapter closes with a set of platform-level concerns that apply to any enforcement infrastructure at FAANG scale.

**Rate limiting is a platform contract, not a feature.** Every service that uses the rate limiting platform depends on its availability, accuracy, and behavior under failure. Changes to the rate limiting platform (new algorithm, new Redis cluster, new fallback policy) must be communicated to all consuming services in advance, with a defined migration path and a rollback plan. The platform team owns the rate limiter code, and consuming teams own the configuration. This separation of concerns prevents consuming teams from implementing ad-hoc rate limiting that conflicts with the platform policy.

**The maturity model for rate limiting infrastructure.** Level 1: in-process rate limiter, no Redis dependency, single-node only. Level 2: Redis-backed distributed limiter with local fallback, correct under clock drift, multi-pod deployment. Level 3: multi-tier enforcement (per-second, per-minute, per-day), per-endpoint configuration, tiered limits by customer type. Level 4: CDN-layer probabilistic enforcement, service mesh integration, adaptive rate limiting based on system load. Level 5: cost-based rate limiting, fair queuing, per-request audit logging with compliance reporting. Most companies need Level 2 or 3. Only the largest platforms need Level 4 or 5. Know which level you need and do not over-engineer.

**Rate limiting governance at FAANG scale.** The largest FAANG-scale platforms have a dedicated Rate Limiting Platform team that owns Levels 2-5 as shared infrastructure. They publish a rate limit policy API (customers can query their current limits), a self-service portal (customer can request limit increases with a business justification), an audit log API (all rate limit decisions are queryable for compliance), and a monitoring dashboard (per-customer limit utilization, error rates, and fallback activation events). Building this governance infrastructure is a multi-year investment. Starting with the audit log is the highest-value first step: knowing what was blocked and why is the prerequisite for improving the policy.
