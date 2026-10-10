## 63.1 Requirements Analysis

### Functional Requirements

1. **Basic Operations**: GET, SET, DELETE with TTL support
2. **Data Structures**: Strings, lists, sets, hash maps
3. **Atomic Operations**: INCR, DECR, CAS (Compare-And-Swap)
4. **Expiration**: Key-level TTL with lazy and active expiration
5. **Eviction**: LRU, LFU, random eviction policies

### Non-Functional Requirements

1. **Low Latency**: < 1ms for local, < 5ms for distributed
2. **High Throughput**: 100K+ operations per second per node
3. **Scalability**: Linear scaling with node count
4. **High Availability**: 99.99% uptime
5. **Fault Tolerance**: No data loss on node failures

### Junior -> FAANG: Translating Requirements into Cache Design Decisions

The five functional requirements translate directly into cache design decisions. CAS (Compare-And-Swap) for atomic operations means the cache must support optimistic concurrency: read the current value plus a version token, compute the new value, write it back only if the version token matches. This maps to Redis's `WATCH` + `MULTI/EXEC` transaction or a Lua script for atomicity.

The eviction policy requirement (LRU, LFU, random) has real performance implications. LRU is the most common choice for general workloads and works well when recently accessed data predicts future access. LFU is better when some items are accessed very frequently over long periods (think product catalog for popular items) and should not be evicted even if there was a recent period of low activity. Random eviction is the simplest and cheapest to implement (O(1) without any ordering structure) but has poor hit rates on all but completely uniform access patterns.

For the 100K operations/second/node requirement: at sub-1ms latency, a single Redis instance can handle roughly 100-200K ops/second on a modern VM. If your workload demands more, you need either horizontal scaling (more nodes with consistent hashing) or vertical scaling (larger instance with more cores, though Redis is single-threaded for commands and gains little from more than a few cores). This calculation is the kind of back-of-the-envelope reasoning interviewers expect.

TTL design is the most underspecified requirement here. "Key-level TTL with lazy and active expiration" covers two mechanisms: lazy expiration (check on read, delete if expired) provides low overhead but allows logically expired keys to occupy memory until accessed, and active expiration (background sweep) bounds the maximum stale memory, but at a CPU cost. Redis uses both: a lazy check on every read, plus a background goroutine that samples random keys from each database and deletes expired ones.

### Senior @ FAANG: NFRs as the Design's Hard Constraints

**Sub-1ms local latency is achievable only with in-process caching**

The "< 1ms for local" requirement cannot be met with a network call to Redis. Redis on a local network (same availability zone) delivers roughly 0.5-1ms median latency, with p99 latency of 2-5ms under load. For sub-1ms consistency, the "local" cache must be an in-process data structure (the L1 cache in the multi-tier design). This means the local requirement and the distributed requirement are separate tiers, not alternatives: local serves sub-1ms, distributed serves sub-5ms, and the backing store serves everything else.

**99.99% uptime requires a specific cluster configuration**

99.99% uptime is 52 minutes of downtime per year. Achieving this with a cache cluster requires: automatic leader election with failover under 30 seconds (Redis Sentinel or Redis Cluster), multi-AZ replication so a single AZ failure does not cause unavailability, and health checks with configurable thresholds (do not trigger failover on a 100ms latency spike). The requirement also means your application must have a graceful degradation path for when the cache is unavailable, because no cluster achieves 100% uptime and a system that cannot function without its cache inherits the cache's availability as its own maximum availability.

**Linear scaling with node count is a claim that needs validation**

"Linear scaling" with consistent hashing is approximately true for read-heavy workloads (more nodes = more read capacity, since each node serves 1/N of the keyspace). For write-heavy workloads, it is not true in the same way: writes that fan out to multiple replicas grow in cost as the replication factor increases. For workloads with hot keys (one key receiving a disproportionate share of traffic), adding more nodes does not help because all traffic to that key still goes to the same node. A senior candidate qualifies "linear scaling" with these conditions rather than stating it as a universal property.

---
