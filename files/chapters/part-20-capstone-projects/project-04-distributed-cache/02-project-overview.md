## Project Overview

We'll build **GoCache** - a Redis-compatible distributed cache that supports:

- **RESP Protocol** for Redis client compatibility
- **Clustering** with consistent hashing (3-1000+ nodes)
- **Replication** (master-replica with async replication)
- **LRU Eviction** when memory limits are reached
- **TTL Support** for automatic key expiration
- **High Performance** (100k+ ops/sec per node)
- **Client Library** with connection pooling
- **Persistence** (optional AOF and RDB snapshots)

### Why This Project Matters

Distributed caches power every major tech company:

- **Google**: Memcached at massive scale
- **Meta**: TAO (distributed data cache), Memcache
- **Amazon**: ElastiCache (Redis/Memcached)
- **Netflix**: EVCache (distributed cache for recommendation systems)
- **Uber**: Redis clusters for session management
- **Twitter**: Cache layer for timeline generation

This project teaches:
- **Distributed systems**: Sharding, replication, consistency
- **Protocol design**: Binary protocols, serialization
- **Performance optimization**: Lock-free structures, memory pooling
- **System design**: CAP theorem, eventual consistency
- **Production operations**: Monitoring, deployment, scaling

---

### Junior → FAANG: Redis Compatibility as a Design Constraint

Building GoCache to be Redis-compatible (speaking RESP protocol) means existing Redis clients can connect to GoCache without modification. This is the value of implementing a standard protocol rather than inventing your own. For interviews, this design choice demonstrates pragmatic engineering: reuse client ecosystem rather than forcing all client teams to change their code.

The RESP protocol specification is public and well-documented. Implementing a protocol parser tests your understanding of binary protocols, buffered I/O, and error handling at the byte level. These are skills that apply beyond caching: database wire protocols (PostgreSQL protocol, MySQL protocol) follow the same patterns.

The features list (LRU, TTL, clustering, replication, Pub/Sub) maps directly to the Redis command set. Know what each command does and what its time complexity is. `GET` and `SET` are O(1). `LRANGE` (list range) is O(n). Interviewer probes often include "what is the time complexity of this operation on your cache?" knowing the answer for common operations shows implementation depth.

### Senior @ FAANG: Custom Cache as a Build-vs-Buy Decision

At senior level, the decision to build a custom cache rather than use Redis or Memcached requires explicit justification. Redis is battle-tested, widely understood, and has a rich ecosystem. Building a custom cache adds maintenance burden without guaranteed performance benefits unless the specific workload requirements cannot be satisfied by Redis.

Valid reasons to build a custom cache at FAANG: specific eviction policy not supported by Redis, custom serialization format for significant memory savings, integration with a proprietary observability system, or per-key access control requirements. Each reason should be documented as a build-vs-buy ADR with evidence that Redis cannot satisfy the requirement.

The RESP protocol compatibility is itself a build-vs-buy consideration: implementing RESP correctly means no surprises for teams already using Redis clients. But RESP has quirks (inline commands, pipelining, multi-bulk arrays) that require careful parser implementation and comprehensive testing. Quantify the implementation cost before committing to protocol compatibility.

---
