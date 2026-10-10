## 37I.14 Exercises

**Exercise 1: Multi-Layer Cache Service**

Build a multi-layer caching service:
- L1: ristretto (100MB, 1-minute TTL)
- L2: Redis cluster (10GB, 10-minute TTL)
- L3: PostgreSQL (source of truth)
- Implement cache-aside with stampede prevention
- Add metrics: hit rate per layer, latency histogram, eviction rate
- Test: verify hit rate improves from 0% to >95% after warm-up

**Exercise 2: Real-Time Rate Limiter**

Build a distributed rate limiter:
- Per-user: 100 requests/minute, 1000 requests/hour
- Per-IP: 1000 requests/minute
- Sliding window algorithm with Redis sorted sets
- Token bucket for burst tolerance
- Benchmark: measure latency at 10K requests/second
- Handle Redis failures gracefully (fallback to local in-memory limiter)

**Exercise 3: Cache Invalidation System**

Build a cache invalidation bus:
- Redis pub/sub for broadcasting invalidations across app instances
- Tag-based invalidation: invalidate all caches tagged with "user:123"
- Version-based keys for optimistic invalidation
- Implement write-through pattern with atomic cache+DB updates
- Simulate and measure: cache consistency under concurrent updates

### Junior to FAANG: Exercise Scaffolding and First-Job Deliverables

Each exercise above is a portfolio artifact. Treat it as a small production system, not a toy. For Exercise 1, the junior deliverable is a Go module with clear interfaces (`type Cache interface { Get, Set, Delete }`), a ristretto implementation, a Redis implementation, a tiered composite that falls through layers, and benchmark tests that show hit-rate convergence over time. Do not skip the benchmark. Interviewers ask for numbers.

Worked starting point for Exercise 1. Define `Cache` as an interface so you can swap implementations. Wire `TieredCache{L1: ristretto, L2: redis, L3: dbLoader}` with `Get` returning the first hit and populating shallower layers on miss. Wrap every layer with the `CacheMetricsCollector` from Section 37I.10. Run a warm-up: simulate 100,000 reads across a Zipfian key distribution (use `rand.Zipf`) and plot hit rate over time. Expect L1 hit rate to plateau around 60 to 80 percent and L2 around 90 to 95 percent for realistic workloads. If your numbers are wildly different, your distribution is wrong or your eviction policy is misconfigured.

Worked starting point for Exercise 2. Start with a fixed-window counter in Lua, measure correctness against boundary bursts, and then upgrade to sliding-window counter with two adjacent windows for weighted math. Only then attempt GCRA if you have time. For the fallback path, use `golang.org/x/time/rate` as the in-process limiter, gate it behind a circuit breaker (`sony/gobreaker`) that opens when Redis errors exceed a threshold.

Worked starting point for Exercise 3. Start with Redis pub/sub and a simple in-process subscriber that evicts from ristretto on message. Add version numbers to detect out-of-order events. Add TTL as the backstop. Write a test that kills the subscriber, mutates a key, restarts the subscriber, and verifies the TTL eventually reconciles. This test is what separates a toy from a production-ready artifact.

First-job deliverable checklist. README with design rationale and failure-mode table. Interface definitions separated from implementations. Table-driven tests. Benchmarks with output committed as `benchmark_results.txt`. Prometheus metrics endpoint. Dockerfile and docker-compose with Redis. A single `make demo` target that runs the warm-up and prints hit-rate curves. Interviewers pull these repos and scan for exactly these artifacts.

Interview entry point. "Walk me through a caching project you built." If you completed Exercise 1 to 3 with the deliverable checklist above, you have 20 minutes of content per exercise: design decisions, trade-offs rejected, failure modes tested, metrics observed. This is how juniors sound like senior candidates.

### Senior at FAANG: Staff Extensions and Governance Exercises

Junior versions of these exercises teach the mechanics. Staff versions teach governance, blast radius, and migration. Below are staff extensions that turn each exercise into a design review artifact.

Staff Extension 1: Tiered cache with OTEL and admission control. Extend Exercise 1 with OTEL spans wrapping every cache operation, semantic attributes for `cache.layer`, `cache.hit`, `cache.miss_reason`. Export to an OTEL collector and view in Grafana Tempo or Jaeger. Add admission control: when L2 eviction rate exceeds a threshold, reject low-priority writes. Add big-key protection: reject writes larger than 1 MB with a structured error. Add hot-key detection via count-min sketch, alerting when top-K traffic concentration exceeds 20 percent. Deliverable: ADR document explaining each guardrail and the failure mode it prevents, plus a load-test harness proving each guardrail fires under the intended stress.

Staff Extension 2: GCRA rate limiter with global SLO and regional fallback. Extend Exercise 2 with GCRA (Generic Cell Rate Algorithm) as the core, which uses one Redis hash per limiter (TAT value) and O(1) memory per key. Shard by `(user_id, endpoint)` across a Redis Cluster. Add a regional fallback: if the global Redis is unreachable, fall back to a regional Redis with a doubled budget (acceptable short-term drift). If both are unreachable, fall back to in-process token bucket with a 10x budget (fail-open for availability). Add observability: per-endpoint allow-rate and reject-rate, per-region fallback activation, and SLO burn-rate alert. Deliverable: ADR explaining the fail-open vs fail-closed decision per endpoint class (auth endpoints fail-closed, search endpoints fail-open), plus a chaos test that kills Redis and verifies fallback activates within 2 seconds.

Staff Extension 3: Cache invalidation event bus with dead-letter queue and reconciliation. Extend Exercise 3 with Kafka instead of Redis pub/sub. Every mutation publishes `{namespace, key, version, timestamp}`. Subscribers track their high-water mark and reconcile on restart. Add a dead-letter queue for messages that fail to process. Add a reconciliation job: every hour, compare a sampled set of keys across L1 and L2 and log divergences. Add a schema registry: invalidation events are versioned Protobuf, so subscribers can reject events they cannot parse. Deliverable: ADR capturing the staleness SLO per namespace, the backstop TTL math, and the migration plan for existing cache users to adopt the bus.

Maturity-ladder exercises (pick one).

Exercise A: Migrate 10 existing services from a shared Redis to a per-namespace cache platform. Audit current usage, register namespaces, dual-write during transition, slot-by-slot read migration, per-namespace SLO monitoring, rollback plan. Timeline and risk analysis documented.

Exercise B: Build a cost-attribution system for the cache platform. Measure per-namespace memory footprint, hit rate, origin-load reduction, and compute a dollar-per-namespace cost. Expose it to owning teams so they can justify their cache budget. This is the system that prevents "cache as a public resource" tragedy-of-the-commons failures.

Exercise C: Build an automated hot-key remediation pipeline. Detect hot keys via count-min sketch in the sidecar, auto-replicate to N shards, notify the owning team with a runbook link and the offending key hash, track remediation lead time as an SLO. This is the system that turns on-call from reactive to proactive.

Governance deliverables for staff extensions. Each extension must ship with: an ADR documenting the decision, a runbook for the on-call engineer, a chaos test proving the failure mode is handled, a cost estimate, a migration plan for adopting teams, and an SLO with burn-rate alerts. Without these deliverables, the code is a prototype. With them, the code is a platform.

Bar-raiser evaluation criteria. A staff candidate presenting one of these extensions is evaluated on: architectural clarity (can you explain the design in 2 minutes?), failure-mode completeness (did you enumerate the top 5 failure modes and their mitigations?), operational maturity (what does on-call look like?), cost awareness (what does this cost per month at 10x scale?), and migration pragmatism (how do existing users adopt without a big-bang rewrite?). Missing any one of these is a hire-as-senior-not-staff signal.

---
