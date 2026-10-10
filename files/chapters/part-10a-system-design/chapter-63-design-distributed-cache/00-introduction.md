# Chapter 63: Design Distributed Cache

*"There are only two hard things in computer science: cache invalidation and naming things."* - Phil Karlton

Caching is the single most powerful lever for improving the performance of a distributed system, and also among the most dangerous if implemented carelessly. A well-designed cache can reduce database load by 99%, cut API response latency from 50ms to under 1ms, and allow a system to absorb traffic spikes that would otherwise overwhelm its storage tier. But a misconfigured cache can silently serve stale data for hours, collapse under a cache stampede when a popular key expires simultaneously for thousands of concurrent requesters, or amplify a failure cascade when the cache cluster itself becomes unavailable and every request falls through to a database that is not sized to handle the raw load.

Consistent hashing is the foundational algorithm that makes distributed cache clusters practical. Without it, adding or removing a cache node would invalidate nearly all cached keys - mapping key to node by `hash(key) % N` means changing N reshuffles everything. With consistent hashing and a virtual node ring, only `1/N` of keys need to migrate when the cluster grows, making elastic scaling a routine operation rather than a cache-warming emergency. Redis Cluster implements this principle with 16,384 hash slots distributed across nodes, and understanding the slot-assignment model is essential for diagnosing key distribution imbalances and hot-shard problems.

This chapter builds a distributed cache system in Go, starting with in-process LRU and LFU eviction implementations - understanding their time complexity and hit-rate characteristics before reaching for Redis. You will implement consistent hashing with virtual nodes from scratch, build a cache client that routes keys to the correct shard, and design write-through, write-back, and cache-aside invalidation strategies with clear consistency semantics. Special attention is given to the cache stampede problem and its solutions - probabilistic early expiry, single-flight request coalescing using Go's `golang.org/x/sync/singleflight`, and mutex-guarded refresh - because stampede handling is the difference between a cache that helps during traffic spikes and one that fails precisely when you need it most.

**What you'll learn in this chapter:**

- Implementing LRU and LFU eviction policies in Go with O(1) get and put operations using doubly-linked lists and hash maps
- Building consistent hashing with virtual nodes from scratch and understanding its key distribution properties
- Designing and comparing write-through, write-back, and cache-aside invalidation strategies with their consistency trade-offs
- Solving the cache stampede problem using `singleflight`, probabilistic early expiry, and distributed mutex patterns
- Configuring Redis Cluster hash slots and diagnosing hot-shard and data skew issues in production
- Implementing cache warming strategies to avoid cold-start degradation after deployments or node replacements
- Building a multi-tier cache hierarchy - in-process L1 plus distributed L2 - with coordinated invalidation
- Handling cache unavailability gracefully with fallback policies that protect the downstream storage layer

**Why this matters at scale:**

Twitter's Twemcache and later Pelikan cache systems were built because vanilla Memcached could not meet their memory efficiency and connection-management requirements at the scale of hundreds of millions of daily active users - the engineering investment in a custom cache daemon paid for itself many times over in hardware costs. Pinterest's engineering team documented a cache stampede incident where a single expired key for a trending board caused 40,000 simultaneous database queries within one second. Their fix using request coalescing became a standard pattern. Facebook's Memcache paper, published at NSDI 2013, remains one of the most influential documents in distributed caching, describing how they evolved from a single pool to a regionally replicated, lease-based invalidation system handling billions of requests per second.

**Prerequisites:** Chapters 1-62. Familiarity with Redis data structures and basic cluster concepts. Understanding of Go's `sync` package and concurrency primitives.

### Junior -> FAANG: Building the Mental Model for Caching

Many candidates arrive at a distributed cache interview knowing the definition of a cache but not the failure modes. The introduction surfaces three of them: cache stampede, hot-shard imbalance, and cascading failure when the cache cluster goes down. Understanding these failure modes before the interviewer asks about them is what separates a prepared candidate from an unprepared one.

The most important conceptual prerequisite is the difference between what a cache does (reduce latency by serving frequently accessed data from fast storage) and what a cache cannot guarantee (consistency with the backing store, durability, or availability independent of the backing store). Treating the cache as a primary data store is the single most dangerous mistake in distributed systems, and it is common precisely because developers who build successfully with a cache forget these limitations.

Consistent hashing is the algorithm behind every distributed cache you will use in production. Understanding it at the level of "adding a node only remaps 1/N of keys" is sufficient for interviews. Being able to derive why (the node joins the ring and takes over only the keys that hash between its predecessor and itself) shows deeper understanding. The Virtual nodes refinement (150 virtual nodes per physical node in this chapter's implementation) is the production-grade version that prevents uneven key distribution when the ring has few nodes.

The Go `singleflight` package is the mechanism you reach for when explaining stampede prevention in an interview. Know the exact behavior: all concurrent calls with the same key share a single in-flight call, and the result is returned to all waiters when it completes. Know the caveat: if the in-flight call returns an error, all waiters receive that error, so a transient database failure affects all concurrent requesters rather than just the one that caused the miss.

### Senior @ FAANG: Caching as an Infrastructure Decision with Long-Term Consequences

**ADR: Managed service vs self-hosted cache cluster**

The decision to use Redis Cluster (self-hosted), ElastiCache (AWS managed Redis), or Memorystore (GCP managed Memcached) is an ADR with multi-year implications. Self-hosted gives you full control over instance types, configuration, and upgrade timing, but requires operational expertise to run safely. Managed services abstract this operational burden but limit configuration options (for example, ElastiCache does not support Redis modules), constrain upgrade timing, and add vendor dependency. A staff-level candidate can articulate this trade-off in terms of the team's operational maturity and the business's risk tolerance, not just technical features.

**Cache tier design affects application architecture**

A cache is not a component you add to an existing system. It changes the architecture of the system. Once you add a cache, your application code must handle three distinct states for any data item: in-cache (fresh), cache-miss (must fetch from source), and in-cache-but-stale (TTL has not expired but data has changed). Each state requires a different code path. The complexity of managing these states is the hidden cost of caching, and it scales with the number of data types you cache. A principal-level candidate proposes a caching abstraction layer that handles these state transitions transparently for application code, reducing the surface area of cache-related bugs.

**Phil Karlton's quote is not a joke: it is a design principle**

Cache invalidation is hard precisely because it is a distributed coordination problem. When data changes in the source of truth, every cache instance that holds a copy of that data must be updated or invalidated before the next read. In a system with 100 application instances each holding a local cache, "update or invalidate" means sending 100 messages, each of which must be delivered reliably, in order, and idempotently. The solution (Redis Pub/Sub invalidation, as shown in the cache coherence section) works well at moderate scale but has limitations: Redis Pub/Sub does not guarantee delivery (if a subscriber disconnects and reconnects, it misses events published during the outage). A production-grade solution uses Redis 6.0 Client-side Caching (server-assisted invalidation via the RESP3 protocol) or a dedicated invalidation event stream with explicit acknowledgments.

---
