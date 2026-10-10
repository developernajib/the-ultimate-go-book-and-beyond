## Summary

Distributed primitives require careful design to handle the inherent challenges of distributed systems:

- **Distributed Locks**: Use etcd leases for correctness. Always include fencing tokens for split-brain protection. TTL prevents permanent lock starvation.
- **Leader Election**: etcd `concurrency.Election` provides safe leader election. Include term/epoch numbers in all leader actions to detect stale leadership.
- **Rate Limiting**: Redis Lua scripts for atomic token bucket or sliding window. Fail open on Redis failure (allow requests) to prevent availability degradation.
- **Barriers & Semaphores**: etcd watches for efficient waiting without polling. Redis counting semaphores for high-throughput scenarios.
- **Service Registry**: etcd-backed with lease-based deregistration ensures dead instances are automatically removed.
- **Circuit Breaker**: Three-state FSM (closed/open/half-open) with configurable failure thresholds and timeout. Combined with bulkheads for layered resilience.
- **Retry**: Exponential backoff with jitter prevents thundering herd. Circuit breaker prevents retries against a broken downstream.

The most important rule: all distributed primitives must handle failure gracefully. Design for "what happens when this operation fails halfway through" - not just the happy path.

### Junior → FAANG: Building a Mental Model from the Summary Bullets

The summary lists seven primitive categories. For interview preparation, the highest-yield habit is constructing a "primitive card" for each one: the name, the backend it runs on (etcd or Redis), the primary correctness mechanism, and the failure mode it does not handle. This produces a compact reference that covers 90% of distributed primitives interview questions.

Distributed locks: backend is etcd (for correctness) or Redis (for throughput). Correctness mechanism is lease-based TTL plus fencing token. Does not handle: a storage layer that ignores fencing tokens.

Leader election: backend is etcd. Correctness mechanism is concurrency.Election plus session TTL. Does not handle: the window between session expiry and new leader election (brief unavailability).

Rate limiting: backend is Redis with Lua script. Correctness mechanism is atomic Lua execution. Does not handle: Redis unavailability (must fail open to preserve availability).

Barriers and semaphores: backend is etcd for correctness, Redis for throughput. Correctness mechanism is watch-based waiting (etcd) or atomic Lua increment-check (Redis). Does not handle: participants that crash before releasing the semaphore (requires lease-based expiry on holders).

Service registry: backend is etcd. Correctness mechanism is lease-based deregistration (auto-expiry on crash) plus health check-based status updates. Does not handle: the TTL window between crash and lease expiry (traffic routed to dead instances during this window).

Circuit breaker: in-process (single instance) or Redis (fleet-wide state). Correctness mechanism is three-state FSM with configurable thresholds. Does not handle: a misconfigured threshold that either never trips (too high) or oscillates (too low timeout).

Retry: in-process. Correctness mechanism is exponential backoff with jitter. Does not handle: retrying non-idempotent operations (must verify idempotency before adding retry).

For the final interview statement: "Every distributed primitive I implement gets a TTL (to handle crashes), a monotonic token (to handle delayed processes), and a fail-open or fallback strategy (to handle backend unavailability)."

### Senior @ FAANG: The Summary as a Platform Capabilities Inventory

At the staff level, the summary bullet list maps to a platform capabilities inventory. For each primitive, the question is not "do we have this" but "is our implementation correct, observable, and maintainable at our current scale, and what does the next scale require?"

Distributed locks: current state is likely a service-level implementation using Redis SETNX or a database advisory lock. The platform upgrade is a centralized lock service backed by etcd with fencing token support, consumed through a Go library with a well-defined interface. The upgrade is justified when any correctness-critical operation requires split-brain protection that the current implementation does not provide.

Rate limiting: current state is often per-instance in-memory limiting (wrong) or a Redis Lua script without sharding (correct but single-point-of-failure). The platform upgrade is a sharded Redis cluster with local pre-filtering and observability (per-key throttle rate dashboards). The upgrade is justified when Redis rate limit latency exceeds 2ms at peak load or when Redis availability directly affects API availability.

Service registry: current state is often Kubernetes service DNS (correct for intra-cluster, wrong for cross-cluster). The platform upgrade is an etcd-backed registry with watch propagation and passive health tracking at the client. The upgrade is justified when Kubernetes service DNS propagation delay (typically 5-30 seconds) causes too many failed requests during rolling deployments.

Circuit breaker: current state is often absent or per-service with inconsistent configuration. The platform upgrade is a standard library with fleet-wide state (shared circuit breaker via Redis) and centralized observability (circuit open events visible in a unified dashboard). The upgrade is justified when a downstream failure in one service causes cascading failures in other services before human intervention.

Organizational maturity model for distributed primitives: Level 0 is each team implementing primitives independently with inconsistent correctness. Level 1 is a shared library with correct implementations but no enforcement. Level 2 is a platform API with SLA-backed service-level implementations. Level 3 is automatic enforcement (required library use, IaC validation of configuration parameters). Level 4 is continuous observability with automated incident creation on correctness violations. Most organizations operate at Level 1. Moving to Level 2 requires a staff engineer investment, and Level 3 and 4 require principal engineering and platform team resources.
