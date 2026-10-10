# Capstone Project 4: Distributed Cache (GoCache)

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Production-ready Redis-like distributed cache
**Tech Stack**: Go 1.27+, RESP Protocol, Consistent Hashing, Docker, Prometheus

---

### Junior → FAANG: Why Building a Cache Is a FAANG Interview Staple

"Design a distributed cache" is a top-3 system design interview question because it exercises consistent hashing, replication, eviction policies, and CAP theorem tradeoffs in a compact problem scope. Building one makes you capable of discussing the internals from first principles rather than from memory.

The RESP protocol implementation shows you understand binary protocol design, which is relevant beyond caching: database wire protocols, message broker protocols, and custom service communication all follow similar patterns. Knowing how to write a protocol parser and encoder is a differentiator.

For entry-level interviews, knowing the LRU eviction algorithm and why it is appropriate for a cache (most recently accessed items are most likely to be accessed again) is sufficient. For senior interviews, know the full spectrum of eviction policies: LRU, LFU (least frequently used), FIFO, and TTL-based expiry.

### Senior @ FAANG: Distributed Cache as a Systems Fundamentals Benchmark

At senior level, the distributed cache project is a fundamentals benchmark. The decisions in this project (consistent hashing for key distribution, replication factor for durability, eviction policy for memory management) are the same decisions made by the Redis and Memcached teams, and by every FAANG team that has built a custom cache layer.

Consistent hashing is worth understanding in depth: the virtual node technique (each physical node maps to multiple virtual nodes on the hash ring) ensures even load distribution even when physical nodes differ in capacity. The rebalancing behavior when a node joins or leaves (only the keys in the adjacent segment move, rather than all keys) is the key correctness property. Being able to draw the hash ring and explain key movement during node addition is a core distributed systems interview skill.

---
