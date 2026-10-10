## Learning Objectives

After completing this chapter, you will be able to:

- **Implement multiple rate limiting algorithms** including fixed window, sliding window, token bucket, and leaky bucket with appropriate trade-offs
- **Build distributed rate limiters** using Redis with Lua scripts for atomic operations in multi-instance deployments
- **Design tiered rate limiting systems** with per-user, per-endpoint, and per-tier limits like Stripe and Discord
- **Create adaptive rate limiters** that adjust limits based on system load and circuit breaker patterns
- **Apply proper rate limit headers** following the IETF draft (`RateLimit`, `RateLimit-Policy`) plus `Retry-After`
- **Implement cost-based rate limiting** for APIs with varying operation costs (read vs write vs export)
- **Handle rate limiting in microservices** with distributed coordination and graceful degradation

### Junior → FAANG: Turning Objectives Into Interview Talking Points

Learning objectives are not just a reading checklist. Each bullet is a potential interview question. For this chapter, the most common entry-level question is: "Describe the difference between token bucket and sliding window and tell me when you would choose each." A strong answer names the burst behavior of token bucket, names the boundary-spike problem of fixed window, and explains that sliding window counter is the practical default for general-purpose API limiting.

A first-job habit worth building: after reading a chapter like this, write one sentence for each objective summarizing what you can now do and one sentence explaining when you would apply it at work. If you cannot write the second sentence, you have memorized the concept without understanding the context. Interviewers probe exactly this gap.

The objectives here also set up a natural project to include in a portfolio: a single Go binary that implements all four algorithms behind a common interface, exposes a `/benchmark` endpoint that shows requests-per-second for each, and returns the standard `RateLimit` and `RateLimit-Policy` headers. That one project demonstrates interfaces, concurrency, HTTP middleware, and benchmarking, which covers a large fraction of what a Go backend role requires.

### Senior @ FAANG: Evaluating Learning Objectives as a Platform Contract

At senior level, a chapter's learning objectives function as the minimum acceptance criteria for any rate limiting implementation shipped to production. The question is not whether you can implement each objective but whether your team's current implementation satisfies all of them and whether the gaps are intentional and documented.

Walk through the objectives as an audit: Does your distributed limiter use atomic Redis operations, or does it have a race condition between the check and increment? Do you emit `RateLimit-Policy` so clients can discover the quota shape, or only a remaining count they have to reverse-engineer? Do your microservices handle backpressure gracefully or do they propagate load spikes upstream?

The adaptive rate limiting objective is where most teams have the largest gap. Adaptive limiting requires integrating with your observability stack to detect system stress (CPU saturation, database connection pool exhaustion, upstream error rates) and tightening limits automatically. This is not a middleware concern alone. It requires an architectural decision about where system health signals are aggregated and how they flow to the limiter. A senior engineer owns the design of that signal path, not just the code that reads from it.

Cost-based limiting is the other frequently skipped objective. When a search query costs 10x what a profile read costs in database CPU, applying the same rate limit to both is inaccurate capacity planning. Defining the cost model and encoding it into the limiter interface is a product-engineering collaboration, and a senior engineer facilitates that conversation.
