## 22B.15 Interview Questions

**Q1: Fault tolerance vs high availability?**
HA = system is running. FT = system behaves correctly during partial failure. A system can be highly available but return wrong results or cascade badly under failure.

**Q2: How does bulkhead prevent cascading failures?**
Bulkheads give each dependency a separate resource pool. Slow Dependency A can't starve Dependency B's goroutines because they have separate semaphores.

**Q3: How do you size bulkheads?**
`limit = RPS × P99_latency_seconds × 1.5`. Example: 500 RPS, 200ms P99 → limit = 500 × 0.2 × 1.5 = 150. Monitor rejection rate. Alert at >2%.

**Q4: What is a timeout hierarchy?**
Nested timeouts where user SLA subdivides into per-operation budgets. Total of all budgets must be ≤ user SLA with buffer for overhead. Use `TimeoutBudget` to propagate remaining time.

**Q5: How does full jitter prevent thundering herd?**
Without jitter all retried requests arrive at the same moment. Full jitter randomizes delay to `random(0, base × 2^attempt)`, spreading retries uniformly and eliminating synchronized spikes.

**Q6: When NOT to retry?**
Never retry: 400, 401, 403, 404. Retry with jitter: network errors, 429 (respect Retry-After), 503, 504. Only retry non-idempotent ops with idempotency keys.

**Q7: Graceful degradation vs circuit breaker?**
Circuit breaker stops calling the failing service. Degradation defines what to do instead (stale data, simpler algorithm, defaults). They work together: open CB triggers degradation.

**Q8: What is load shedding?**
Rejecting excess requests under overload to protect the requests the service can handle. Shed at the door, before any real work, and shed by priority so cheap traffic goes first. Admission control is better than queue tuning: a request never admitted never queues at all.

**Q9: How do you implement a fallback chain?**
List of providers implementing the same interface, tried in order. Each must be genuinely independent. Log every tier activation. Include stale-cache and static-default as final tiers.

**Q10: What is an error budget?**
The permitted unavailability from your SLO. 99.9% = 43.8 min/month. Healthy budget → ship features. Exhausted → freeze features, fix reliability.

**Q11: How do you test fault tolerance?**
Fault injection middleware (random errors/latency) in staging. Chaos experiments in production with blast radius limits. Unit tests with mock failures. Integration tests with simulated partitions.

**Q12: Timeout vs deadline?**
Timeout = relative duration from now. Deadline = absolute time. Go's `context.WithTimeout` converts to a deadline internally. Deadlines propagate correctly through nested calls. Timeouts reset at each layer (wrong).

**Q13: Why adaptive LIFO under overload?**
Under overload FIFO serves requests whose clients have already timed out, which is pure wasted work. LIFO serves the newest request, the one most likely to still have someone waiting. Say "adaptive": FIFO under normal load, switching to LIFO only once a queue forms. Unconditional LIFO reorders for no benefit and worsens tail latency when there is no queue. This is Facebook's approach in "Fail at Scale" (ACM Queue, 2015), paired with CoDel.

**Q14: How do you communicate partial failures?**
HTTP 207 for bulk ops. Single-resource: `"partial": true` + `"degraded_features": ["recs", "social_proof"]` in body. `X-Partial-Response: true` header. Describe what's missing and why.

**Q15: What Prometheus metrics for bulkhead?**
`bulkhead_requests_total`, `bulkhead_rejections_total` (alert >2%), `bulkhead_in_flight` and `bulkhead_max_concurrent` gauges, `bulkhead_call_duration_seconds` histogram. Export the limit as a gauge too, otherwise "in-flight as a fraction of capacity" has no denominator to divide by.

**Q16: How does Netflix adaptive concurrency work?**
Measures gradient = minRTT / currentRTT. Gradient < 1 means latency is inflating → reduce limit. Gradient ≈ 1 means no inflation → increase limit. Self-tunes without manual config.

**Q17: Amazon's static stability principle?**
Systems keep working even when control planes (config service, service discovery, rate limiter) are down. Cache config locally with long TTL. Sync in background. Never block hot path on control plane.

**Q18: What is the retry budget pattern?**
Cap total retry time as a fraction of the request deadline. If deadline is 2s and budget is 10%, never spend >200ms on retries total. Prevents retry loops from consuming the entire deadline.

**Q19: How does tenant isolation prevent noisy neighbors?**
Per-tenant bulkheads give each tenant their own concurrency limit. A bursty tenant exhausts only their pool, not the shared pool. Combine with per-tenant Redis token bucket for complete isolation.

**Q20: Design fault-tolerant payment processing.**
1. Idempotency key prevents duplicate charges on retry.
2. Payment bulkhead (30 concurrent) prevents provider failure cascading.
3. 3s total timeout. 2s for primary provider.
4. Fallback chain: Stripe to Adyen to Braintree, but only failing over on errors that PROVE no charge was authorized (refused connection, failed health check, explicit pre-auth decline). Never fail over on a timeout: the charge may have succeeded and the response been lost, and idempotency keys are per provider, so Adyen has no idea what Stripe already did. Ambiguous outcome means stop and reconcile, not retry elsewhere.
5. All providers down, return 503 with Retry-After. Never silently drop. An ambiguous outcome is not a failed payment: surface it for reconciliation rather than reporting the charge did not happen.
6. Emit `PaymentAttempted` event regardless of outcome for audit.
7. Per-provider circuit breaker: 50% failure in 30s, open CB, skip to next provider.

### Staff Track Questions

**Q21: How do you drive fault-tolerance discipline across 100 services?**

Standard library with shared patterns. Production readiness gate including fault tolerance. Chaos engineering program. Incident postmortems that feed back into standards. Culture of "every incident is a fault-tolerance improvement".

**Q22: When does fault tolerance cost more than it saves?**

When patterns are applied to low-risk paths they add complexity without benefit. Triage: which paths are customer-facing, which are business-critical, which can fail with acceptable impact? Invest heavily in the first two, and accept cheaper trade-offs in the third.

---
