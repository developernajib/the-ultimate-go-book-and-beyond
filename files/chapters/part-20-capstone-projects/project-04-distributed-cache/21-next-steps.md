## Next Steps

If you want to continue improving GoCache beyond the scope of this project, the following features are natural extensions that will deepen your understanding of distributed systems and database internals. Each one is a substantial project on its own, so tackle them one at a time.

1. Implement AOF (Append-Only File) persistence
2. Add RDB snapshot support
3. Implement Lua scripting support (EVAL command)
4. Add pub/sub functionality
5. Implement Redis Cluster protocol
6. Add sorted sets (ZADD, ZRANGE)
7. Implement transactions (MULTI/EXEC)
8. Add stream support (XADD, XREAD)

---

## FAANG Interview Questions

**Q: How would you design a distributed cache to handle 100M requests per second?**

A: Partition the keyspace with consistent hashing across 1000 cache nodes. Each node holds 64 GB of memory and serves 100K RPS. Clients use a smart routing library that maintains the hash ring locally and talks directly to the right shard, avoiding a proxy hop. Replicate hot keys to secondary nodes (read replica fan-out). Use a gossip protocol (SWIM) for cluster membership. Batch requests to reduce network overhead. Reserve 20% memory headroom for failover redistribution.

**Q: What consistency model should a distributed cache provide?**

A: Eventual consistency is standard because strong consistency kills throughput. Use last-write-wins with millisecond-resolution timestamps for conflict resolution. For writes that must invalidate, use an async invalidation fanout via pub/sub. Read-your-writes consistency is achievable if the client pins to the primary replica for its session. Never promise linearizability; applications that need it should use a CP datastore (etcd, Zookeeper) not a cache.

**Q: How do you handle cache stampedes?**

A: Three layered defenses. (1) Probabilistic early expiration: refresh the cache entry before TTL with probability increasing as the entry ages. Spreads regeneration load. (2) Request coalescing: a single-flight lock (Go's singleflight or Redis SETNX) ensures only one thread regenerates a missing key while others wait. (3) Stale-while-revalidate: serve the expired value for up to N seconds while a background job refreshes. Combine all three in production. For catastrophic misses (cold cache restart), use a progressive warmup that replays the last hour's traffic.

**Q: How do you implement eviction when memory is full?**

A: LRU is the baseline, but W-TinyLFU (used by Caffeine) outperforms LRU for skewed workloads by admitting new keys only if their estimated frequency exceeds the victim's. Implement via Count-Min Sketch for frequency estimation plus a small admission window. For time-series workloads, TTL-based eviction (Redis EXPIRE) is simpler and more predictable. Measure hit rate versus eviction policy via shadow replay before deploying a policy change.

**Q: How would you scale a cache cluster without full re-sharding?**

A: Consistent hashing with virtual nodes (200-plus vnodes per physical node) ensures only 1/N of keys move when adding a node. For safer migration, use double-read during migration: the client reads from the old and new owner, writes to both until cutover. For cross-region clusters, use CRDTs (G-Set, PN-Counter) for mergeable state, or accept per-region cache locality and rely on the origin for consistency. Facebook's approach: regional caches are independent, origin database is the source of truth.

### Junior → FAANG: Next Steps as a Learning Roadmap

The extensions listed in this chapter (AOF persistence, CRDT-based conflict resolution, raft consensus) are each substantial engineering projects in their own right. Pick the one that aligns with your target role: storage engineers benefit from AOF persistence, distributed systems roles benefit from Raft consensus, database engineers benefit from MVCC implementation.

AOF (Append-Only File) persistence is the most immediately impactful extension: it transforms GoCache from a volatile cache to a durable store, opening use cases that currently require a database. The implementation requires a sequential write log, background compaction, and crash recovery. Go's `os.OpenFile` with `O_APPEND` and periodic `Sync()` calls is the starting point.

For interview preparation, knowing what you would build next (and why) shows product thinking. "I would add AOF persistence next because several of my use cases require durability guarantees that an in-memory-only cache cannot provide" demonstrates you understand the product implications of technical choices.

### Senior @ FAANG: Next Steps as a Platform Roadmap

At senior level, the next steps for GoCache are a platform roadmap that requires prioritization based on organizational impact. Raft consensus (enabling true distributed coordination without an external etcd/ZooKeeper dependency) is high-impact for platform teams that want a self-contained distributed system but requires significant implementation complexity and ongoing maintenance.

CRDT-based conflict resolution enables multi-master writes across geographic regions without coordinator consensus, which is valuable for globally distributed applications that cannot tolerate write latency from a cross-region leader. The complexity is that application developers must use CRDT-appropriate data types and cannot rely on strong consistency. Educating application teams about eventual consistency semantics is as important as implementing the CRDTs themselves.

The Raft consensus implementation is particularly instructive as a next step because it forces you to implement leader election, log replication, and safe consensus under network partitions, the same problems that distributed databases like CockroachDB and TiKV solve. Working through Raft implementation deepens your understanding of every distributed system you will design or review for the rest of your career.

---

## Navigation & Cross-References

| [Project 3: E-Commerce Platform](../project-03-ecommerce-platform/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Project 5: Search Engine](../project-05-search-engine/00-introduction.md) |
| :--- | :---: | ---: |
| ◀ Previous Project | Table of Contents | Next Project ▶ |
