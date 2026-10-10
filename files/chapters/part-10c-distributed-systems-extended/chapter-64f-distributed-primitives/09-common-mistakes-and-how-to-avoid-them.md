## Common Mistakes and How to Avoid Them

| Mistake | Impact | Fix |
|---------|--------|-----|
| Distributed lock without TTL | Lock held forever if holder dies | Always set TTL. use leases |
| Lock without fencing tokens | Split-brain writes after network partition | Include monotonic token in all protected writes |
| Redlock with < 3 Redis nodes | No majority possible | Use odd number of Redis nodes ≥ 3 |
| Leader election without term number | Stale leader writes after split-brain | Include epoch/term in all leader writes |
| Rate limiter per-node | Different limits seen by different nodes | Centralize in Redis with Lua script |
| Circuit breaker without metrics | Can't detect abnormal open rates | Export state change events to monitoring |
| No bulkhead on downstream calls | Thread exhaustion from slow downstream | Limit concurrent calls to each dependency |
| Retry without exponential backoff | Thundering herd on recovery | Add jitter + exponential backoff |
| Service registry without health checks | Dead instances receive traffic | Periodic health check, deregister on failure |
| etcd without compaction | etcd disk fills up | Enable periodic compaction (etcd --auto-compaction-retention) |

### Junior → FAANG: Using the Mistakes Table as a Checklist for Every Distributed Primitive You Write

Each row in this table represents a failure mode that has caused a production incident at a company operating distributed systems. For a junior engineer, the most valuable use of this table is treating it as a mandatory checklist for any code you write that uses a distributed primitive.

The most operationally dangerous mistake on the list is "distributed lock without TTL." Without a TTL, a process that acquires a lock and then crashes holds the lock forever. No other process can acquire it. The resource becomes permanently unavailable. This is a liveness failure that requires a manual operator intervention (deleting the lock key) to resolve. The fix is always present in well-written lock implementations, but it is easy to omit when building a quick prototype that then gets promoted to production.

"Retry without exponential backoff" is the mistake that converts an isolated failure into a widespread outage. When a downstream service becomes slow and many callers start retrying at a fixed rate, the downstream receives a flood of retries on top of normal traffic, overwhelming its capacity further. Exponential backoff with jitter ensures that retrying callers spread their retries over time, giving the downstream a chance to recover. The jitter component (randomizing the retry interval within a range) prevents synchronized retry waves where all callers back off to the same interval and then retry simultaneously.

"Service registry without health checks" is the mistake that sends traffic to instances that are running but not healthy (process is up, but the database connection is broken, or the worker threads are deadlocked). Lease-based registration only detects crashes. Health checks detect application-level failures. Every production service registry should have both.

For interview preparation: when describing a distributed primitive design, proactively mention the mistakes it avoids. "The lock has a TTL bounded by the expected critical section duration, includes a fencing token, and uses an odd number of backend nodes for quorum" demonstrates that you have thought through the failure space.

### Senior @ FAANG: Converting the Mistakes Table into Enforced Policy

The gap between knowing these mistakes and preventing them in production is the organizational challenge. Senior engineers and platform architects solve this by encoding the required properties as enforced constraints rather than documentation.

For the TTL and fencing token mistakes: build a distributed lock library that makes TTL mandatory (no default, must be specified) and automatically generates fencing tokens on acquisition. A lock library that returns a `FencingToken` alongside the lock acquisition makes the correct pattern the obvious pattern. Engineers who use the library correctly by default are less likely to omit the fencing token than engineers who must remember to add it.

For the Redlock minimum-node mistake: encode the minimum node count as a validation in the Redlock constructor that panics on startup if fewer than 3 Redis instances are provided. A runtime validation that fails fast prevents the misconfiguration from reaching production.

For the leader election term number mistake: require the term number (etcd revision or epoch counter) to be propagated through the service's write path. If the write path accepts arbitrary writes without checking the term, it is incorrect by construction. A code review checklist item ("all leader writes include the current term number in a conditional write") is better than documentation alone.

For the "etcd without compaction" mistake: encode the compaction configuration as a required field in the etcd cluster provisioning template (Terraform/Helm). An IaC template that does not include `--auto-compaction-retention` should fail validation. The Kubernetes community discovered this mistake on large clusters where etcd disk filled up under high write rates, causing the cluster control plane to stop functioning. The fix is trivially easy to enforce through IaC validation.

Bar-raiser signal: a senior candidate discussing distributed primitives can describe how they would prevent each of the top five mistakes from reaching their production system, naming specific technical mechanisms (required fields, library defaults, IaC validation, CI policies) rather than relying on code review and documentation.

---
