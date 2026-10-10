# Chapter 64F: Distributed Primitives

> *"A mutex protects shared memory between threads. A distributed lock attempts to protect shared state between processes on different machines, across a network that can lose messages, delay them arbitrarily, or partition silently - and that distinction changes everything about how you reason about correctness."*

Single-process concurrency primitives - mutexes, semaphores, condition variables - are well understood and backed by decades of theory and hardware support. Distributed primitives solve structurally similar problems but in an environment where the failure model is radically different: nodes crash and restart with stale state, clocks drift, and network messages can be delayed, reordered, or lost entirely. A distributed lock that expires based on a wall-clock timeout can be held simultaneously by two processes if one pauses due to garbage collection or a kernel scheduler preemption - a scenario that would be impossible with a kernel mutex. These are not theoretical edge cases. This exact scenario, a client whose lease expires during a GC pause writing with a stale lock, is the centerpiece of Martin Kleppmann's well-known Redlock critique, and HBase documented precisely this class of bug with ZooKeeper leases before adopting fencing.

The primitives covered in this chapter - distributed locks, leader election, distributed counters, barriers, semaphores, rate limiters, and service registries - are the load-bearing components of distributed application logic. Redis is the most common substrate for implementing them at moderate scale: its single-threaded execution model and atomic Lua scripting make it straightforward to implement correct locking semantics, and the Redlock algorithm extends this to multi-node Redis clusters. etcd provides a more rigorous alternative based on Raft consensus, with first-class support for leases, watches, and transactional compare-and-swap operations that make leader election and service discovery reliable even under network partitions. Knowing when to use Redis versus etcd versus a custom Raft-backed implementation - and what guarantees each actually provides - is one of the most practically valuable skills in distributed systems engineering.

Rate limiting across a distributed fleet introduces additional complexity because request counts are inherently local until synchronized. A token bucket implemented with local memory silently allows each instance to consume its full quota, multiplying the effective rate by the fleet size. Correct distributed rate limiting requires shared state and a synchronization protocol - typically a Redis Lua script implementing a sliding window or token bucket with atomic increment and expiry operations. This chapter implements and stress-tests each of these primitives, demonstrates their failure modes under partition and clock skew, and shows how fencing tokens, leases, and compare-and-swap provide the safety guarantees that naive locking approaches lack.

**What you'll learn in this chapter:**

- Implementing distributed locks with Redis SET NX/EX and Lua scripts, and understanding why Redlock is controversial
- Building correct distributed locks with etcd leases and compare-and-swap for fencing-token-based mutual exclusion
- Leader election patterns with etcd: campaign/resign lifecycle, session-based leases, and watch-based failover notification
- Distributed counters and rate limiters: Redis sliding-window and token-bucket implementations with atomic Lua scripts
- Distributed barriers and semaphores: coordinating multi-process workflows with bounded concurrency guarantees
- Service registry with health checking: etcd-backed registration, TTL-based expiry, and watch-driven client-side discovery
- Distributed task queues: at-least-once delivery with Redis Lists, exactly-once processing with idempotency keys and transactions
- Circuit breakers, bulkheads, and retry strategies: implementing resilience patterns that compose correctly under partial failure

**Why this matters at scale:**

Kubernetes uses etcd as its single source of truth for all cluster state, and the leader election primitives in `k8s.io/client-go/tools/leaderelection` are used by every Kubernetes controller to ensure only one instance of each controller is active at a time. Redis-based distributed locks are used at Airbnb, Twitter, and GitHub to prevent double-processing of payments, notifications, and webhook deliveries. Stripe's idempotency key system - which ensures that retried payment requests never result in duplicate charges - is a distributed primitive that combines exactly-once semantics with a content-addressed key-value store. Uber's rate limiting infrastructure, handling millions of requests per second across hundreds of microservices, is built on the sliding-window Redis primitives described in this chapter.

**Prerequisites:** Familiarity with Go concurrency (goroutines, channels, mutexes), basic Redis and etcd usage, understanding of the distributed systems failure model from Chapter 64E. No prior distributed systems implementation experience is required.

### Junior → FAANG: Understanding Why "Works Locally" Is Not Enough

The introduction makes a crucial point in its opening paragraph: a distributed lock that expires based on wall-clock time can be held simultaneously by two processes if one pauses due to garbage collection. This is the central insight that separates engineers who understand distributed primitives from those who merely use them.

In single-threaded or even multi-threaded code, you can reason about mutual exclusion from first principles: the OS guarantees that only one thread holds a mutex at a time, and the mutex is held until explicitly released. In distributed systems, neither guarantee holds. A process can pause for longer than the lock TTL without releasing it. A network partition can cause two nodes to believe they each hold the lock. A clock jump can expire a lock before the holder believes it has expired. Every one of these failure modes has caused a production data corruption incident at a major company.

For interview preparation, the key habit is to ask "what is the failure mode of this primitive under partition, crash, and clock skew" for every distributed primitive you use. The introduction's list of primitives (locks, leader election, counters, barriers, semaphores, rate limiters, service registries) maps to a set of interview scenarios where these failure questions are standard.

Redis vs etcd selection framing: Redis provides low-latency atomic operations with probabilistic durability (asynchronous replication). etcd provides linearizable operations with strong durability (synchronous Raft replication). The tradeoff is latency and throughput (Redis wins) vs correctness under failure (etcd wins). Use Redis for rate limiting and best-effort locks. Use etcd for leader election and correctness-critical coordination.

### Senior @ FAANG: Distributed Primitives as Platform Infrastructure

At the staff level, distributed primitives are not things you implement per-service: they are platform-level infrastructure that all services consume through a standard API. The introduction's framing around Redis vs etcd is a starting point for a platform decision about which primitives belong in the platform layer and which are acceptable to implement at the service layer.

Platform primitives (owned by the infrastructure team, standard API, SLA-backed): distributed locking with fencing tokens, leader election, service registry, rate limiting. These are building blocks that every service needs and where correctness failures are catastrophic. They should be implemented once correctly, maintained by a team with distributed systems expertise, and consumed via a library with a well-defined contract.

Service-level primitives (acceptable to implement per-service, lower stakes): circuit breakers, bulkheads, retry policies. These have service-specific configuration (what error rate triggers the circuit, what timeout to use) and failure in one service's implementation does not affect other services.

The Kubernetes use of etcd as described in the introduction is the reference architecture: a single, strongly consistent coordination store that all controllers use for leader election and state storage. Distributing this across multiple backends (Redis for locks, etcd for leader election, Consul for service discovery) creates a coordination problem between the coordination systems, which is exactly what you want to avoid.

Governance question for platform architects: when should a service team be allowed to implement their own distributed lock vs being required to use the platform lock? The answer depends on the consequence of a bug: if a buggy lock causes data corruption (double-processing payments, inventory double-decrement), it should be the platform implementation. If a buggy lock causes a brief availability degradation (two instances of a batch job running simultaneously), per-service implementation may be acceptable. Encoding this distinction in a tiered approval process is more maintainable than reviewing every lock implementation individually.

---
