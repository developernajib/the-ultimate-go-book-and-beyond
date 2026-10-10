# Chapter 61: Design Rate Limiter

*Any sufficiently advanced throttle is indistinguishable from a denial of service.*

Rate limiting is one of those deceptively straightforward requirements that becomes extraordinarily subtle the moment you move beyond a single server. The basic idea - track how many requests a client has made and reject those over a threshold - sounds like a few lines of code. In practice, designing a correct, fair, and performant rate limiter requires choosing between fundamentally different algorithms, each with different burst characteristics, implementation complexity, and failure modes. Token bucket allows bursting but requires floating-point state. Fixed window is simple but creates thundering-herd spikes at window boundaries. Sliding window log is precise but memory-intensive. Sliding window counter splits the difference, but only approximates the true rate.

The distributed dimension multiplies this complexity. When your API is served by 50 application nodes, where does rate-limit state live? If it lives in each node independently, a client can multiply its effective limit by targeting different nodes. If it lives in a centralized Redis cluster, you face atomicity challenges - a read-then-write sequence has a race condition, so you need Lua scripts executed atomically on Redis to make the check-and-decrement operation safe. Clock skew between distributed nodes introduces another failure mode: if two servers disagree on the current time by even a few hundred milliseconds, sliding window calculations become inconsistent. These are the problems this chapter is designed to arm you against.

Go's strengths - lightweight goroutines, fast I/O, and a clean standard library - make it an ideal implementation language for rate limiters embedded in API gateways, middleware stacks, or standalone services. You will implement each major algorithm from scratch, understand their mathematical properties, then graduate to a Redis-backed distributed implementation with atomic Lua scripts. The chapter also addresses multi-tier rate limiting: enforcing limits at the CDN edge, at the API gateway, and within individual microservices - a defense-in-depth approach adopted by Stripe, Cloudflare, and AWS API Gateway.

**What you'll learn in this chapter:**

- Implementing and benchmarking fixed window, sliding window log, sliding window counter, token bucket, and leaky bucket algorithms in Go
- Writing atomic Redis Lua scripts to perform rate-limit checks without race conditions in distributed environments
- Handling clock drift and time synchronization challenges in multi-node rate limiter deployments
- Designing graceful degradation strategies - fail-open vs fail-closed - when the rate-limit backend is unavailable
- Applying rate limiting at multiple architectural tiers: CDN, API gateway, service mesh, and application middleware
- Building per-user, per-IP, and per-API-key rate limit policies with independent counters and quotas
- Implementing burst allowances and credit carry-over for token bucket configurations
- Returning correct HTTP 429 responses with `Retry-After` headers and meaningful error bodies

**Why this matters at scale:**

Stripe enforces rate limits across every API endpoint with a tiered system - per-second, per-minute, and per-day counters - using Redis Lua scripts for atomicity and falling back to conservative in-memory limits if Redis becomes unavailable. Cloudflare's rate limiting product handles trillions of requests per month across edge nodes globally. Their approach uses probabilistic counting at the edge with periodic synchronization to a central store to avoid the latency of synchronous Redis calls on every request. GitHub's API learned the hard way that naive fixed-window rate limiting created a stampede every hour on the hour as millions of CI pipelines simultaneously reset their counters - the move to sliding windows smoothed traffic patterns significantly.

**Prerequisites:** Chapters 1-60. Understanding of Redis data structures and Lua scripting basics. Familiarity with HTTP middleware patterns in Go.

---

### Junior → FAANG: Why Rate Limiting Is a Core System Design Skill

Rate limiting appears in FAANG interviews because it tests your understanding of distributed state management, algorithmic correctness, and failure handling in a bounded, well-understood problem. Candidates who have not thought about it before tend to propose a single global counter in Redis and call it done. Candidates who understand it can explain five algorithms, three distributed coordination approaches, and the failure modes of each.

**The four questions that expose your depth.** An interviewer will probe any rate limiter proposal with: (1) What happens when Redis is unavailable? (2) How do you handle clients behind a shared NAT? (3) What is the difference between token bucket and sliding window? (4) How do you prevent the boundary burst problem? Knowing the answers to all four before the interview is a prerequisite for passing the rate limiter design question at FAANG.

**Algorithm names matter.** Using precise names (token bucket, leaky bucket, fixed window, sliding window log, sliding window counter) signals familiarity with the literature. Saying "I would keep a counter" without naming the algorithm signals that you have not studied this problem. The algorithms have distinct mathematical properties: token bucket accumulates unused capacity as tokens, leaky bucket enforces a fixed output rate, sliding window eliminates the boundary burst of fixed window. Know these distinctions.

**The distributed dimension is the hard part.** Single-process rate limiting is a few lines of code with a mutex. Distributed rate limiting across 50 pods requires atomic state management, which Redis provides through Lua scripts. The Lua script runs atomically on the Redis server, so the check-and-decrement cannot be interleaved with another request. This is the key insight that separates a correct distributed rate limiter from one with a race condition.

**Entry-level interview framing.** When asked to design a rate limiter, start by clarifying: per-user or per-IP? What algorithm is preferred (token bucket for burstable APIs, sliding window for strict enforcement)? Is this for a single service or a distributed API gateway? What happens when the rate limit backend fails (fail-open or fail-closed)? These questions demonstrate that you understand the design space before proposing a solution.

---

### Senior @ FAANG: Rate Limiting as Platform Infrastructure

At L6/L7, a rate limiter is not a feature added to a single service. It is a platform component with its own availability requirements, governance policies, and multi-tenant configuration model.

**Rate limiting as a platform primitive.** FAANG API platforms enforce rate limits at multiple layers: CDN (Cloudflare or Akamai blocking volumetric DDoS), API gateway (Kong, Envoy, or a custom gateway enforcing per-customer limits), and application middleware (per-endpoint limits based on resource cost). Each layer has different accuracy requirements, different latency budgets, and different failure modes. The CDN layer uses probabilistic counting with no Redis dependency. The gateway layer uses Redis Lua scripts with a local fallback. The application layer uses in-process token buckets with no network dependency. Designing these three layers and their interaction is an L6/L7 concern.

**Multi-tenant rate limiting requires a policy management system.** A single Redis rate limiter with hardcoded limits is not a platform. A platform has a policy store (database table or configuration system) that maps customer IDs to rate limit policies, a control plane API for customers to view and request changes to their limits, and a data plane that reads the current policy for each request. Changes to a customer's rate limit must take effect within a bounded time (typically 60 seconds for Redis key-based policies) and must be audited (who changed this limit, when, and why). Building this policy management system is a significant engineering investment that is often underestimated.

**The fail-open vs fail-closed decision is a governance question, not a technical one.** When Redis is unavailable, the rate limiter can fail open (allow all requests) or fail closed (deny all requests). Failing closed during a Redis outage means your API is completely unavailable even though all application servers are healthy. Failing open means a determined attacker can exhaust your backend during a Redis outage. The correct answer depends on your threat model: for a public-facing API with abuse risk, fail-open with a conservative local fallback is usually correct. For an internal API with no abuse risk, fail-open with no limit is acceptable. Document this decision and the rationale as a governance policy, not an implementation detail.
