## Summary

This chapter built a distributed cache system from single-node eviction policies to a multi-node cluster with replication:

- **Eviction policies**: LRU gives O(1) eviction using a doubly-linked list. LFU tracks access frequency with a min-heap and a timestamp tie-breaker. The choice depends on whether recency or popularity is the better predictor of future access in your workload
- **Consistent hashing**: Virtual nodes (150 per physical node in the implementation) distribute keys evenly across the ring so adding or removing a node remaps only 1/N of keys rather than reshuffling the entire dataset
- **Cache coherence trade-offs**: Write-through gives immediate consistency at higher write latency. Write-behind batches writes for throughput at the risk of data loss during crashes. Redis Pub/Sub invalidation collapses multi-instance coherence windows to under 1ms
- **Stampede prevention**: `singleflight` collapses concurrent cache misses for the same key into a single database query, and jittered TTLs prevent co-expiration of keys set at the same time
- **Binary protocol**: Fixed-length headers with `bufio` buffered I/O minimize syscall overhead for the many small values typical of cache traffic
- **Replication**: A monotonically increasing replication log lets replicas request only entries they have not yet applied, enabling catch-up after network partitions without full data transfer

The recurring theme across all these components: a cache that works during normal operation but fails during traffic spikes is worse than no cache at all, because the system is sized to depend on the cache hit rate. Every design decision, stampede protection, jittered TTLs, graceful fallback to the database, is about ensuring the cache degrades smoothly rather than catastrophically.

### Junior -> FAANG: Consolidating What You Know Before an Interview

The summary above gives the six core concepts of this chapter. Use it as a pre-interview checklist and make sure you can explain each concept without looking at the text.

For consistent hashing, practice the explanation: "Virtual nodes ensure even key distribution when nodes are added or removed. Without virtual nodes, adding one node remaps roughly half the keys. With 150 virtual nodes per physical node, adding a node remaps only 1/N of keys." This explanation, delivered confidently, satisfies the hashing question in most FAANG interviews.

For stampede prevention, practice explaining both mechanisms: `singleflight` collapses concurrent misses to one fetch, and jittered TTLs prevent co-expiring keys. These are complementary: `singleflight` handles concurrent misses at one instant, jitter prevents many keys from expiring at the same instant. An interviewer who asks about thundering herd expects both mechanisms.

For cache coherence, be prepared to choose between write-through, write-behind, and cache-aside based on a stated requirement. If the interviewer says "strong consistency required," choose write-through and explain the latency cost. If the interviewer says "high write throughput required," choose write-behind and explain the durability risk. If the interviewer says "reads are 100x more frequent than writes," choose cache-aside and explain the invalidation pattern.

A first-job habit: after finishing a chapter summary, write down the three questions you expect an interviewer to ask based on that chapter. Then write out your answers. The act of articulating answers exposes gaps that re-reading does not.

### Senior @ FAANG: Synthesis as an L6 Signal

The summary presents each component as if it were independent. At L6, the interview question is about how the components interact under failure conditions, and whether you have thought through the failure scenarios that span multiple components.

**The interaction between consistent hashing and stampede prevention**

When a cache node is removed from the ring (whether by failure or by intentional removal), all keys previously assigned to that node now map to a different node. Those keys are all misses on the new node simultaneously. This is a topology-change-induced stampede. `singleflight` partially mitigates it (collapses concurrent misses for the same key), but if 10,000 different keys suddenly miss at once, `singleflight` does not help because each key is a distinct call. The correct mitigation is a warming strategy: before decommissioning a node, pre-populate its successor with the evicted key set, or use a staged removal that reduces the node's virtual node count gradually over minutes rather than removing it instantly.

**The interaction between replication and cache coherence**

The replication log described in the summary enables catch-up after network partitions. During the partition, the replica serves reads with potentially stale data. The cache coherence model during partition depends on whether you choose AP (availability and partition tolerance, serve stale reads) or CP (consistency and partition tolerance, return errors on reads during partition). Most caches choose AP because a stale cache read degrades to a database fallback, while a cache error causes a potentially uncatchable application error. The choice must be explicit and documented: cache clients must handle both the "stale read" case and the "cache unavailable" case, and the behavior in each case must be specified in the platform SLA.

**The maturity progression for distributed cache platforms at FAANG**

1. Single node, LRU eviction, no monitoring (prototype)
2. Redis Cluster with consistent hashing, basic hit rate metrics (production v1)
3. Stampede protection, jittered TTLs, L1 in-process cache (production v2)
4. Multi-tier with per-tier SLA tracking, cache warming for deployments (scale)
5. Multi-tenant with namespace quotas, CDC-based invalidation, regional topology (FAANG-grade)

A bar-raiser question: "You are joining a team whose cache system is at stage 3. What is the most important step toward stage 4, and what is the risk of not taking it?" The answer requires understanding that cache warming is the reliability risk (cold-start incidents during deployments), not performance. The performance problems (hit rate, latency) are already solved at stage 3. The operational risk (deployment-induced cache misses causing database overload) is the gap to stage 4. Identifying the reliability gap rather than the performance gap is L6 thinking.
