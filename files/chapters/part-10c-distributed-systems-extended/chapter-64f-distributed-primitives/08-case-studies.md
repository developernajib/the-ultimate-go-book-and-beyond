## Case Studies

### Case Study 1: etcd in Kubernetes

**Usage**: Kubernetes uses etcd as its sole backing store. Leader election for the API server and controller manager, service discovery, configuration storage - all backed by etcd.

**Key patterns**:
- Leader election via `concurrency.Election` with 5s lease TTL
- Service endpoints stored as etcd keys, watched by kube-proxy (instant update propagation)
- Optimistic locking for resource updates: `ResourceVersion` field = etcd revision, rejected on mismatch
- Watch events trigger reconciliation loops (controller pattern)

**Scale**: Single etcd cluster handles ~5,000 node clusters. For larger clusters: etcd sharding by key range (separate etcd for events vs core resources).

### Case Study 2: Netflix's Circuit Breaker (Hystrix → Resilience4j)

**Problem**: In Netflix's microservices architecture, a slow downstream service caused threads to pile up waiting for responses, eventually exhausting thread pools and causing cascading failures across unrelated services.

**Solution**: Hystrix (Java) / Resilience4j with circuit breakers + bulkheads:
- Circuit breaker: opens after 50% error rate in 10-second window
- Bulkhead: max 10 concurrent calls to any downstream service
- Fallback: return cached/degraded response when circuit is open
- Metrics: every circuit state change reported to real-time dashboard

**Go equivalent**: `sony/gobreaker` or custom implementation as shown above.

**Result**: cascading failures from a single slow dependency became rare and bounded, and tail latency during downstream incidents dropped sharply because callers fail fast instead of waiting out 30-second timeouts. Netflix retired Hystrix in 2018 in favor of adaptive concurrency limits, with Resilience4j as the community successor.

### Case Study 3: Redis Rate Limiting at Stripe

**Challenge**: Stripe's API handles 100M+ requests/day. Rate limiting must be consistent across all API nodes without introducing a bottleneck.

**Solution**: Redis Lua scripts for atomic token bucket. Each API key has its own bucket. Lua script runs atomically → no race conditions across Stripe's distributed API servers.

**Key insights**:
- Local rate limit decision in Go (check bucket atomically in Redis)
- Redis cluster sharded by API key → horizontal scale
- Sliding window gives better protection against burst at window boundaries
- Failed Redis calls: fail open (allow the request) rather than fail closed (deny everything)

**Numbers**: 100M req/day = ~1,157 RPS average. Peak 10K RPS. Redis latency < 1ms. Total overhead per request: < 2ms.

### Junior → FAANG: Extracting Interview-Ready Answers from Each Case Study

The three case studies (Kubernetes/etcd, Netflix/Hystrix, Stripe/Redis) each provide a concrete answer to a frequently asked interview question. Memorizing the outcome is less useful than understanding the reasoning.

Kubernetes case study: the answer to "how does Kubernetes ensure only one controller manager is active at a time" is: etcd-based leader election with a 5-second lease TTL. The Kubernetes implementation uses `client-go/tools/leaderelection`, which implements the same campaign/resign lifecycle as the `LeaderElection` struct in this chapter. The `ResourceVersion` as optimistic lock version (etcd revision as a fencing token) is the answer to "how does Kubernetes prevent two controllers from updating the same resource concurrently."

Netflix case study: the answer to "how did Netflix prevent thread exhaustion from propagating into unrelated services" is: circuit breakers per downstream dependency (so one slow dependency does not exhaust threads for all callers) plus bulkheads (bounded thread pool per dependency). The 99.5% reduction in cascading failures is the quantitative result that makes this a compelling system design choice.

Stripe case study: the answer to "how does Stripe enforce per-API-key rate limits consistently across a distributed fleet" is: Redis Lua script with atomic token bucket per API key. The fail-open decision (allow requests when Redis is unavailable) is the critical product tradeoff: Stripe prioritizes payment processing availability over strict rate limit enforcement, accepting occasional rate limit bypass during Redis downtime as preferable to refusing valid payment requests.

For each case study, practice stating: the problem that triggered the design (thread exhaustion, inconsistent rate limits), the design decision (circuit breaker, Redis Lua script), the tradeoff accepted (false positives during transient failures, fail-open during Redis downtime), and the result (quantified improvement). This structure produces system design answers that match FAANG expectations.

### Senior @ FAANG: Case Studies as Templates for Distributed Infrastructure Decisions

At the staff level, these case studies are reference implementations for the most common distributed infrastructure decisions: coordination store selection, resilience pattern adoption, and rate limiting architecture. Each contains an implicit set of requirements that drove the design.

Kubernetes chose etcd not just for leader election but because etcd's watch API maps precisely to the Kubernetes controller pattern: controllers watch for changes to resources and reconcile state. The choice of a strongly consistent, watch-capable coordination store as the central storage layer is an architectural commitment that has shaped the entire Kubernetes operational model. An organization adopting Kubernetes is implicitly adopting etcd's operational characteristics: its storage limits (8GB by default), its backup requirements, its compaction needs, and its latency SLO requirements (etcd recommends p99 < 100ms commit latency for stable operation).

Netflix's Hystrix to Resilience4j migration is a case study in dependency management. Hystrix used a separate thread pool per dependency for bulkheading, which provided strong isolation but had significant overhead (thousands of threads in a large service). Resilience4j uses a semaphore-based bulkhead (as shown in the CountingSemaphore implementation in this chapter), which reduces overhead at the cost of weaker isolation (a blocked semaphore acquisition still ties up the caller's thread). The choice between thread-pool and semaphore bulkheads is a concurrency model decision that should appear in the ADR.

Stripe's fail-open rate limiting decision requires an explicit SLO impact analysis. Fail-open during Redis unavailability means that for the duration of the outage (say, 30 seconds), API keys that are normally rate-limited may send unlimited traffic. If those keys belong to legitimate customers who are occasionally bursty, the impact is acceptable. If those keys belong to known abusers, the impact is 30 seconds of uncontrolled traffic. The correct decision requires knowing the distribution of traffic across API key classes, which requires data that is only available after building observability into the rate limiting system.

For platform architects: use these case studies to calibrate the maturity level of your own distributed infrastructure. Kubernetes-style (etcd-backed, Raft-consistent, watch-based) is the gold standard for coordination infrastructure. Netflix-style (circuit breakers on every downstream dependency, bulkheads sized by expected call volume) is the gold standard for resilience. Stripe-style (Redis Lua for atomic enforcement, sharded by identifier, fail-open on backend failure) is the gold standard for rate limiting. If your implementations are less mature than these, you have a specific improvement target to work toward.

---
