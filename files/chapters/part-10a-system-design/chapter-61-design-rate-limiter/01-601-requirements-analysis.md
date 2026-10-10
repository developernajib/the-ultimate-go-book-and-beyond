## 61.1 Requirements Analysis

### Why Rate Limiting?

1. **Prevent Resource Starvation**: Ensure fair resource allocation
2. **Security**: Protect against DoS attacks and brute force
3. **Cost Control**: Limit API usage for billing purposes
4. **Stability**: Prevent cascading failures
5. **SLA Compliance**: Enforce agreed-upon usage limits

### Functional Requirements

1. Limit requests per user/IP/API key within a time window
2. Support multiple rate limiting strategies
3. Return remaining quota and reset time in responses
4. Support different limits for different endpoints
5. Allow dynamic configuration changes

### Non-Functional Requirements

1. **Low Latency**: < 1ms overhead per request
2. **High Accuracy**: Minimal false positives/negatives
3. **Distributed**: Work across multiple servers
4. **Fault Tolerant**: Degrade gracefully if backend fails
5. **Scalable**: Handle millions of requests per second

---

### Junior → FAANG: Translating Requirements into Design Constraints

Rate limiter requirements look simple on paper but contain hidden conflicts. Understanding these conflicts before proposing a design separates junior candidates from strong ones.

**"Low latency" and "high accuracy" are in tension.** The most accurate rate limiter (sliding window log) stores every request timestamp in memory and counts them on each check. This is O(n) in memory and O(n) in check time. The least accurate (fixed window) uses O(1) memory and O(1) check time. The sliding window counter is the practical compromise: O(1) memory, near-perfect accuracy. When an interviewer asks about algorithm choice, frame your answer in terms of this accuracy-efficiency trade-off.

**"Fault tolerant" requires a defined fallback behavior.** Fault tolerance for a rate limiter means the service continues operating when the rate limit backend (Redis) is unavailable. The requirements say "degrade gracefully" without specifying what degradation means. In your design, answer this explicitly: "When Redis is unavailable, I fall back to an in-process token bucket with a limit set at 10% of the normal limit. This prevents DoS during Redis failures while keeping the service available."

**"Dynamic configuration" has an implementation cost.** Supporting dynamic configuration changes means the rate limiter cannot hardcode limits at startup. Limits must be loaded from a database or configuration store on each check (or cached with a short TTL). This adds a read dependency and a cache invalidation problem. Know that this requirement changes the architecture: you now need a configuration source, a caching layer for the configuration, and a mechanism to push updates.

**Non-functional requirements need measurable targets.** "Less than 1ms overhead per request" is measurable. Write it down with a measurement method (p99 latency measured at the middleware layer, not including application handler time) and a load condition (at 50K requests per second per pod). Without the measurement method and load condition, you cannot write a valid benchmark or set a meaningful alert threshold.

---

### Senior @ FAANG: Requirements Governance and the Rate Limiter Policy Model

At L6/L7, requirements for a rate limiter service extend beyond functional correctness to include the governance model for how limits are set, changed, and communicated to customers.

**Rate limit policies are a product decision, not just an engineering decision.** The limits themselves (100 requests per minute for free tier, 10,000 for enterprise) are pricing and product decisions made with input from product management, sales, and finance. Engineering implements and enforces them, but does not set them unilaterally. At L6+, you build the enforcement infrastructure and the control plane for setting limits, then work with product to define the initial limits and the process for changing them. Document the governance model: who can request a limit change, who approves it, what is the review process, and how are exceptions handled (individual enterprise customers with custom limits).

**The SLA for rate limit accuracy must be defined.** "High accuracy" in the requirements is not measurable. Define it: "The rate limiter must not allow more than 1% over the nominal limit under steady-state load, and not more than 5% over the limit during a Redis failover to the local fallback." This SLA can be validated with a load test that counts allowed requests and compares to the configured limit. Without this definition, you cannot validate that the system meets its requirements, and you cannot argue in a post-mortem that the behavior during an incident was within specification.

**Compliance implications of rate limiting decisions.** For a payments API (like Stripe), rate limit decisions have compliance implications. If a payment is blocked by the rate limiter, the customer's funds may be delayed. This requires: (1) an audit log of every rate limit decision for blocked requests (timestamp, customer, endpoint, limit, current count), (2) a mechanism for customers to request rate limit increase in real time during a critical business operation, (3) a contractual SLA on the maximum time a blocked payment request can be queued before it expires. These are not engineering concerns that can be deferred to later. They must be addressed in the requirements phase, because they change the architecture (audit log storage, real-time override API, request queuing mechanism).
