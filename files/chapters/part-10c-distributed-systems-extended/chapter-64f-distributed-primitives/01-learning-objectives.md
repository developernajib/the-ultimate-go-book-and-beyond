## Learning Objectives

By the end of this chapter, you will be able to:
- Implement distributed locks with automatic expiry and fencing tokens
- Build leader election using etcd and Redis
- Design distributed rate limiters that work across multiple nodes
- Implement distributed counters, barriers, and semaphores
- Build a service registry with health checking and watch-based updates
- Design distributed task queues with at-least-once and exactly-once semantics
- Implement circuit breakers, bulkheads, and retry strategies
- Understand the pitfalls of distributed primitives (clock skew, network partitions, split-brain)

### Junior → FAANG: Mapping Learning Objectives to Interview Scenarios

Each learning objective in this list corresponds to a specific category of interview question that appears regularly in FAANG distributed systems interviews. Treating this list as a preparation checklist helps ensure you cover the full scope of the topic.

"Implement distributed locks with automatic expiry and fencing tokens" maps to: "How would you prevent double-processing of payment webhook events in a horizontally-scaled service?" The answer structure is: distributed lock keyed on the event ID, TTL-bounded to prevent permanent hold on crash, fencing token to reject stale lock holder writes, idempotency key in the database write to handle the remaining race window.

"Build leader election using etcd" maps to: "How does your service ensure only one instance is actively processing at a time?" The answer structure is: etcd campaign/resign lifecycle, term number in leader writes to detect stale leadership, resign before shutdown to minimize failover time.

"Design distributed rate limiters that work across multiple nodes" maps to: "Your API is being hit by a bot at 10,000 RPS. How do you enforce a per-IP limit of 100 RPS across your 50-instance fleet?" The answer structure is: Redis sliding window with a Lua script, key by IP address, fail open on Redis unavailability (allow the request) to preserve availability.

"Implement circuit breakers and retry strategies" maps to: "Your payment service sometimes calls a slow downstream fraud detection API. How do you prevent slow fraud checks from taking down your entire payment flow?" The answer: circuit breaker with bulkhead, fallback to cached fraud decision or fail-open with manual review flag.

The pitfalls objective is the meta-objective: every primitive implementation should be evaluated through the lens of "what happens under clock skew, partition, and crash."

### Senior @ FAANG: Translating Objectives into Team Competency Standards

At L6, reading a learning objectives list is a calibration exercise: which of these objectives does your team currently satisfy with production-grade implementations, and which are handled with inadequate workarounds?

A common pattern in teams that have grown quickly: distributed locking is handled with database-level advisory locks (which do not expire on process crash), leader election is handled with a "cronjob on a single node" (which has no failover), and rate limiting is handled with in-process counters (which allow N times the intended rate across N instances). Each of these is a correctness and reliability debt that compounds as the system scales.

The objectives around observability are often missing from teams' implementations. "Circuit breakers and bulkheads" without "export state change events to monitoring" are black boxes that make incidents harder to diagnose. A circuit breaker that opens and closes in production without anyone seeing a metric spike is not providing its full value.

Using this objectives list as a team audit: for each objective, define what "production grade" means (e.g., for rate limiting: atomic enforcement across all nodes, fail-open on backend unavailability, rate limit headers in HTTP responses, dashboards showing per-key throttle rates) and evaluate your current implementation against that definition. The gaps from this audit become engineering investment priorities.

---
