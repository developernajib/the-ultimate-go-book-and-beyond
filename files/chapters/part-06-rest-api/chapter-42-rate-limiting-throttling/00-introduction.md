# Chapter 42: Rate Limiting & Throttling

*The best protection against abuse is not allowing it to happen in the first place.*

A single misbehaving client can degrade service for every other user on your platform. That is simultaneously a fairness problem, a reliability problem, and a cost problem. API abuse takes many forms: a misconfigured client retry loop hammering your endpoints at thousands of requests per second, a scraper exhausting your database connection pool, a credential-stuffing attack attempting millions of login combinations. Rate limiting is the first line of defense against all of them. Rate limiting is also a product feature. Clear headers and informative error responses help legitimate developers build better clients, implement correct backoff, and understand how to use your API efficiently.

Go's concurrency primitives make it a strong platform for rate limiting. In-process token bucket and sliding window limiters can be built with atomics and channels with no external dependencies, and Redis Lua scripts enable atomic multi-instance rate limiting that scales horizontally without race conditions. The canonical in-process choice is `golang.org/x/time/rate`, whose `Limiter` exposes three methods that cover every common pattern: `Allow()` (non-blocking, returns a boolean), `Wait(ctx)` (blocks until a token is available or the context is canceled), and `Reserve()` (returns a `Reservation` carrying the delay you must wait before using the token). That limiter is strictly in-process: it holds its state in a struct on the heap and knows nothing about your other replicas. For cross-instance enforcement, libraries like `github.com/go-redis/redis_rate` implement GCRA (the generic cell rate algorithm, a leaky-bucket variant) on top of Redis Lua, or you can author Lua scripts directly for maximum control. The harder engineering problem is not implementing the algorithm. It is choosing the right algorithm for each use case, setting limits that protect the system without blocking legitimate traffic, and exposing limit state to clients in a machine-parseable format.

> **Senior track**: `rate.NewLimiter(rate.Limit, burst)` takes tokens-per-second (a `rate.Limit` which is `float64`) and a burst size. `rate.Every(100*time.Millisecond)` is a helper for "one token every 100ms" which is easier to read than `10.0`. The limiter is lock-free on the fast path (uses atomics plus a single mutex), so a single instance is safe to share across millions of calls per second.

This chapter builds a complete rate limiting system in Go. You will implement in-process limiters, distributed Redis-backed limiters, tiered per-user and per-endpoint limits, adaptive limiters that respond to system load, and cost-based limiters for operations with different computational weights. Every implementation follows the IETF `RateLimit` / `RateLimit-Policy` header draft so that clients can implement correct retry behavior automatically.

**What you'll learn in this chapter:**
- Fixed window, sliding window, token bucket, and leaky bucket algorithms with implementation and trade-off analysis
- In-process rate limiting with `golang.org/x/time/rate` and atomic counters for single-instance deployments
- Distributed rate limiting with Redis Lua scripts for atomic, race-free multi-instance enforcement
- Tiered limit structures: per-user, per-API-key, per-endpoint, and per-tier quotas like Stripe and Discord use
- IETF `RateLimit` and `RateLimit-Policy` header implementation so clients can self-throttle without guessing
- Cost-based rate limiting: assigning different weights to reads, writes, exports, and batch operations
- Adaptive rate limiting with circuit breaker integration that tightens limits under system stress
- Graceful degradation patterns: queuing, shedding, and backpressure for microservice deployments

**Why this matters at scale:**
Cloudflare has publicly described the approximated sliding window counter it runs at its edge: rather than storing every request timestamp, it weights the previous window's count by how far into the current window you are. That single trick is what makes edge-scale rate limiting affordable in memory, and it is the same algorithm you will implement in Go here. Stripe has likewise published the layered design behind its API limits, built on a Redis-backed token bucket plus concurrency limiters and load shedders. The common thread is that a production limiter is never one algorithm. It is a stack of them, each catching a failure mode the others miss.

**Prerequisites:** Chapter 38 (REST fundamentals), Chapter 39 (auth and API key extraction), Chapter 42B (API design philosophy for limit design)

### Junior → FAANG: Understanding Why Rate Limiting Exists Before You Write a Line of Code

Many junior engineers treat rate limiting as a checkbox: add a library, configure a number, move on. FAANG interviews reveal this gap immediately when a candidate cannot explain why a specific limit value was chosen, or cannot distinguish between protecting the server and protecting the client.

Start by internalizing the five motivations listed in this chapter: abuse protection, fairness, cost control, quality of service, and business model enforcement. Each motivation has a different failure mode if you get the limit wrong. Set the login endpoint limit too high and a credential-stuffing attack succeeds. Set the export limit too low and your paying enterprise customers cannot do their jobs. The limit value is a product decision as much as an engineering one.

The first-job habit to build is always reading the `Retry-After` header your own service returns. Write a small test client that hammers your endpoint until it gets a 429, then checks that the `Retry-After` value is correct and that waiting that long actually results in a successful response. If your limiter returns a `Retry-After` of 30 seconds but the next request still fails, your reset logic is broken.

Interview entry point: be ready to explain the difference between in-process and distributed rate limiting and name a concrete scenario where each is appropriate. A single-process service with one replica can use an in-memory token bucket. A service with three replicas behind a load balancer must use Redis-backed limiting, because each replica only sees one-third of the traffic.

### Senior @ FAANG: Platform-Level Rate Limiting Governance and Maturity Models

At senior level, the question is not how to implement a rate limiter but how to govern rate limits as a platform capability across dozens of services owned by dozens of teams.

**Architecture decision record framing.** Before choosing an algorithm, write down the failure modes you are accepting. Fixed window is simple and fast but exposes a 2x burst at window boundaries. If your downstream can absorb double the steady-state rate for two seconds at a minute boundary, fixed window is acceptable and the simplicity is worth it. If it cannot, you must pay the higher implementation cost of a sliding window counter. This decision belongs in an ADR, not in a code comment, because it affects every team that calls your service.

**Maturity model for rate limiting.** A useful four-level model: Level 1 is IP-based limits applied globally with no headers. Level 2 adds user-keyed limits, standard `RateLimit` and `RateLimit-Policy` headers, and a consistent 429 response schema. Level 3 introduces tiered limits per plan, per-endpoint overrides, and cost-based consumption for expensive operations. Level 4 adds adaptive limits that tighten automatically under system stress, audit trails for limit changes, and a self-service portal where enterprise customers can request temporary quota increases. Most teams ship to production at Level 1 and call it done. A senior engineer defines what Level 3 looks like for their platform before the first line is written.

**Distributed consistency tradeoffs.** Redis Lua scripts give you atomic enforcement across replicas, but they put a synchronous network call on every request. A Redis round-trip inside the datacenter is on the order of a millisecond, which is fine when your handler already does database work and ruinous when your p50 was 300 microseconds. Redis also becomes a hard dependency: when it is unreachable you must decide, in advance and in code, whether to fail open (serve traffic unprotected) or fail closed (429 everyone). The architecture response is not to abandon Redis but to put a local limiter in front of it as a first-pass filter and consult Redis only when the local bucket is nearly exhausted. Under normal load most clients never come close to their limit, so most requests never touch the network, and you keep distributed accuracy exactly where it matters.

**Limit propagation in microservice graphs.** When service A calls service B on behalf of a user, whose limit is consumed? The answer depends on your threat model. If you are protecting service B from overload, the limit key should be service A's identity, not the end user's. If you are enforcing a per-user quota that spans multiple services, you need a shared quota store, which is a distributed systems problem with significant operational overhead. Staff-level engineers identify this distinction at the design phase and make an explicit choice documented in the ADR.

**Bar-raiser signals in interviews.** A candidate who can describe the two-tier local-plus-Redis pattern, articulate when to choose it over pure Redis, and explain how to test its correctness under concurrent load is operating at L6. A candidate who additionally frames the conversation around the maturity model, identifies which tier their current employer is at, and explains the organizational changes needed to reach the next tier is operating at L7. The algorithm implementation is table stakes. The governance thinking is what separates senior from staff.
