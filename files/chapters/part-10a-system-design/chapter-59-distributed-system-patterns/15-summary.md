## Summary

Production distributed systems rely on proven patterns to handle partial failures, load distribution, and resource coordination:

- **Consistent Hashing** distributes keys across nodes so that adding or removing a node remaps only ~1/N of keys rather than nearly all of them. Virtual nodes improve uniformity, weighted hashing handles heterogeneous hardware, and bounded-load hashing prevents hot spots under skewed access patterns.
- **Raft Consensus** provides leader election and log replication with strong consistency guarantees. The randomized election timeout prevents simultaneous elections, and the log-comparison rule in `RequestVote` ensures only up-to-date candidates can win.
- **Distributed Locking** coordinates exclusive access to shared resources across processes. Redis-based Redlock achieves quorum across independent instances, etcd leases provide automatic expiration on crash, and fencing tokens protect against stale lock holders that outlive their TTL.
- **Distributed Rate Limiting** enforces request quotas across multiple service instances. Sliding window eliminates boundary-burst problems, token bucket allows controlled bursting, and leaky bucket enforces smooth constant-rate output.
- **Circuit Breaker** fails fast when a downstream service is unhealthy, preventing cascading failures. Percentage-based thresholds with minimum request volumes avoid false trips on transient errors.
- **Bulkhead** isolates resource pools per dependency so that a slow service cannot exhaust connections or goroutines needed by unrelated functionality.
- **Retry with Backoff** recovers from transient failures while exponential backoff and jitter prevent thundering-herd amplification. Retry budgets cap the total retry load across all requests in a process.
- **Idempotency** makes operations safe to retry by caching results keyed on a request identifier. Redis-backed idempotency handles the fast path, and database-backed idempotency handles the durable path for financial or critical mutations.

The key design principle across all these patterns: compose them in the right order. A production client applies rate limiting first, then bulkhead isolation, then circuit breaking, then retries, ensuring that expensive retry attempts only occur when resources are available and the downstream service is believed healthy.

### Junior -> FAANG: Building a Study Plan from This Chapter

The patterns in this chapter have a natural learning order that mirrors the interview question difficulty curve. Start with consistent hashing (hash ring, virtual nodes, binary search lookup), which is frequently asked in system design interviews and has a clean, self-contained implementation. Move to circuit breakers and retry patterns, which appear in both design and coding interviews. Save Raft consensus for last: it is asked less frequently but is a strong differentiator when it comes up.

For each pattern, build three artifacts: a working implementation in Go (use the code in this chapter as a starting point), a timing diagram showing the pattern's behavior under the primary failure mode, and a one-paragraph explanation you can deliver verbally in under 60 seconds. The verbal explanation is the hardest part and requires practice.

The verbal explanation template: "The problem [pattern] solves is [problem]. Without it, [failure mode]. The solution is [mechanism]. The key configuration knob is [parameter] and the trade-off is [tension]." For circuit breakers: "Circuit breakers prevent cascading failures. Without them, a slow downstream exhausts all caller resources. The solution is a state machine that fails fast when errors exceed a threshold. The key configuration knob is the error threshold and the trade-off is between false positives (tripping on transient errors) and false negatives (not tripping during real outages)."

First-job habit: when you encounter any of these patterns in production code, read the configuration. What is the virtual node count? What is the circuit breaker threshold? What is the rate limit? Can you explain why each number was chosen? If you cannot, that is a gap in your team's operational knowledge worth closing.

### Senior @ FAANG: Chapter Review as a Platform Maturity Checklist

Use this chapter's pattern catalog as a platform maturity checklist. For each pattern, assess whether your organization has it at the right maturity level.

Consistent hashing: does your caching or storage tier use it? Is the virtual node count documented and justified? Is the ring topology visible in your observability platform so you can see key distribution without querying individual nodes?

Distributed locking: is there a standard library that teams use, or does each team roll their own? Is the locking substrate (Redis, etcd, DynamoDB) documented with its correctness guarantees? Are lock acquisitions and releases emitting structured events?

Rate limiting: is rate limiting a platform service or a per-team responsibility? Are limits configurable without deployments? Are rejections attributed to specific clients in your metrics?

Circuit breakers: are breaker state transitions visible in your observability platform across all services simultaneously? Are thresholds documented with supporting data? Is there a runbook for manually overriding breaker state during incidents?

Retry and idempotency: does your organization have a policy on which operations may be retried? Is there a standard idempotency library? Are teams required to document idempotency in their API design reviews?

A team at level one has none of these consistently. Level three has them for critical services. Level five has them for all services, with automated verification (chaos tests that confirm breakers trip at the correct thresholds, load tests that confirm rate limiters enforce limits under the expected request distribution). Building toward level five is a multi-year organizational effort. Use this chapter as the starting point for the conversation with your platform team.

---
