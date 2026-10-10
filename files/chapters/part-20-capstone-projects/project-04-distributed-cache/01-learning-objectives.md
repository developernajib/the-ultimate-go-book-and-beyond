## Learning Objectives

By completing this project, you will:

1. Implement RESP (Redis Serialization Protocol) parser and writer
2. Build an in-memory key-value store with LRU eviction
3. Implement consistent hashing for distributed clustering
4. Design replication for high availability
5. Build a Go client library with connection pooling
6. Handle concurrent access with optimized locking strategies
7. Implement common cache operations (GET, SET, DEL, EXPIRE, TTL)
8. Build cluster management and failure detection
9. Deploy and benchmark a distributed system
10. Optimize for production performance (sub-millisecond latency)

---

### Junior → FAANG: Mapping Objectives to CAP Theorem

Every objective in this list maps to one of the three CAP theorem dimensions: consistency, availability, and partition tolerance. Understanding which objectives affect which dimension is the foundation for distributed systems reasoning.

Objective 5 (replication) is about availability and consistency: more replicas increase availability but introduce replication lag (brief inconsistency). Objective 6 (client library with failover) is about availability: the client must handle node failures gracefully. Objective 3 (consistent hashing) is about partition tolerance: key assignments remain valid even when nodes join or leave.

For FAANG interviews, explicitly stating which CAP properties your design prioritizes (and which you sacrifice) demonstrates distributed systems maturity. A cache typically prioritizes availability and partition tolerance over strict consistency, accepting brief stale reads during replication lag.

### Senior @ FAANG: Learning Objectives as an Engineering Maturity Arc

At senior level, the ten objectives divide into two groups: implementation objectives (1-7) and operational objectives (8-10). The implementation objectives produce a working cache. The operational objectives produce a production-ready cache. The gap between "working" and "production-ready" is where most of the engineering effort lives at FAANG.

Benchmark-driven optimization (objective 10) is especially important for a cache: sub-millisecond latency is the value proposition. If your cache returns results in 2ms instead of 0.5ms, application engineers will route around it. Establishing latency benchmarks at the beginning of the project and tracking them through each implementation decision (rather than benchmarking at the end) is the correct engineering discipline.

---
