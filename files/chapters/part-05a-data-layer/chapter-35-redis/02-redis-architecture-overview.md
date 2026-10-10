## Redis Architecture Overview

The architecture overview below shows Redis as a multi-role infrastructure component: primary cache, pub/sub broker, rate-limiting store, and distributed lock manager. Each role uses different Redis data structures and eviction policies tuned for the specific access pattern. The same diagram applies to Valkey deployments - the wire protocol, command set, and client behavior are identical. The difference is the license of the server binary and the vendor backing (BSD-3-Clause/Linux Foundation for Valkey, RSALv2/SSPL/AGPLv3 for Redis 8+).

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         Redis Architecture in Go                              │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │                        Go Application                                  │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐            │   │
│  │  │  Caching  │  │  Session  │  │Rate Limit │  │  Pub/Sub  │            │   │
│  │  │  Service  │  │   Store   │  │  Service  │  │  Handler  │            │   │
│  │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘            │   │
│  │        │              │              │              │                  │   │
│  │        └──────────────┴──────────────┴──────────────┘                  │   │
│  │                              │                                         │   │
│  │  ┌───────────────────────────┴───────────────────────────────────────┐ │   │
│  │  │                     go-redis/v9 Client                            │ │   │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │ │   │
│  │  │  │ Connection   │  │   Command    │  │   Pipeline   │             │ │   │
│  │  │  │    Pool      │  │   Executor   │  │   Handler    │             │ │   │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘             │ │   │
│  │  └───────────────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│  ┌─────────────────────────────────┴─────────────────────────────────────┐    │
│  │                         Deployment Options                            │    │
│  │                                                                       │    │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │    │
│  │  │    Standalone    │  │     Sentinel     │  │     Cluster      │     │    │
│  │  │    (Single)      │  │  (High Avail)    │  │   (Horizontal)   │     │    │
│  │  │                  │  │                  │  │                  │     │    │
│  │  │  ┌────────────┐  │  │  ┌──────────┐    │  │  ┌───┐ ┌───┐     │     │    │
│  │  │  │   Redis    │  │  │  │ Sentinel │    │  │  │ M │ │ S │     │     │    │
│  │  │  │   Master   │  │  │  └──────────┘    │  │  └───┘ └───┘     │     │    │
│  │  │  └────────────┘  │  │       │          │  │  ┌───┐ ┌───┐     │     │    │
│  │  │                  │  │  ┌────┴────┐     │  │  │ M │ │ S │     │     │    │
│  │  │                  │  │  │ Master  │     │  │  └───┘ └───┘     │     │    │
│  │  │                  │  │  └────┬────┘     │  │  ┌───┐ ┌───┐     │     │    │
│  │  │                  │  │  ┌────┴────┐     │  │  │ M │ │ S │     │     │    │
│  │  │                  │  │  │ Replica │     │  │  └───┘ └───┘     │     │    │
│  │  │                  │  │  └─────────┘     │  │                  │     │    │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘     │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘

Redis Data Structures:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  String              Hash                 List                               │
│  ┌─────────────┐     ┌─────────────┐     ┌───┬───┬───┬───┬───┐               │
│  │ "value"     │     │ field: val  │     │ A │ B │ C │ D │ E │               │
│  └─────────────┘     │ field2: val │     └───┴───┴───┴───┴───┘               │
│                      └─────────────┘     LPUSH/RPUSH  LPOP/RPOP              │
│  SET/GET/INCR        HSET/HGET/HGETALL                                       │
│                                                                              │
│  Set                 Sorted Set          Stream                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐             │
│  │ {A, B, C}   │     │ A: 10       │     │ ID: 1234-0          │             │
│  │ unordered   │     │ B: 20       │     │ {field: value, ...} │             │
│  │ unique      │     │ C: 30       │     │ ID: 1234-1          │             │
│  └─────────────┘     └─────────────┘     │ {field: value, ...} │             │
│  SADD/SMEMBERS       ZADD/ZRANGE         └─────────────────────┘             │
│  SINTER/SUNION       ZRANK/ZSCORE        XADD/XREAD/XGROUP                   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Caching Patterns:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Cache-Aside (Lazy Loading)                                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │   App ──► Cache ──► HIT ──► Return Data                                │  │
│  │            │                                                           │  │
│  │            ▼                                                           │  │
│  │          MISS ──► Database ──► Store in Cache ──► Return Data          │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Write-Through                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │   App ──► Write to Database ──► Write to Cache ──► Return Success      │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Write-Behind (Write-Back)                                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │   App ──► Write to Cache ──► Return Success                            │  │
│  │                    │                                                   │  │
│  │                    ▼ (async)                                           │  │
│  │              Write to Database                                         │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Distributed Lock:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   Worker 1                    Redis                     Worker 2             │
│   ┌───────┐                ┌─────────┐                 ┌───────┐             │
│   │       │ SETNX lock:x   │         │   SETNX lock:x │       │              │
│   │       │────────────────►│  lock:x │◄───────────────│       │             │
│   │       │   OK (first)   │  = uuid1│    FAIL        │       │              │
│   │       │                │         │   (already set)│       │              │
│   │       │                │         │                │       │              │
│   │  Work │                │         │                │ Wait/ │              │
│   │       │                │         │                │ Retry │              │
│   │       │                │         │                │       │              │
│   │       │ DEL lock:x     │         │                │       │              │
│   │       │ (if uuid match)│  (nil)  │                │       │              │
│   │       │────────────────►│         │   SETNX lock:x│       │              │
│   │       │                │  lock:x │◄───────────────│       │              │
│   │       │                │  = uuid2│    OK          │       │              │
│   └───────┘                └─────────┘                └───────┘              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: reading the architecture diagram without hand-waving

The diagram looks simple. Read it like a production engineer and it reveals the first dozen questions you will be asked in an interview. The box labeled "go-redis/v9 Client" is not a single object. It is a pool of persistent TCP connections (default 10 per `GOMAXPROCS`), a command serializer that writes RESP frames, a pipeline handler that batches when asked, and a reconnection state machine that handles MOVED/ASK redirections in cluster mode. Every one of those subcomponents has a failure mode that becomes an interview question. "What happens if all connections in the pool are checked out?" (new requests block on pool acquisition up to `PoolTimeout`, then error.) "What happens if the primary fails over mid-request?" (the in-flight command returns a connection error, the pool closes the stale connection, and retry behavior depends on whether you enabled `MaxRetries` and whether the command is idempotent.)

The three deployment options are not interchangeable. Standalone is fine for dev, demo, and single-tenant small services, and has exactly one operational property that matters: when it dies, everything that depends on it dies with it. Sentinel is the minimum production posture for any service that cares about availability but does not need to scale writes horizontally. At least three Sentinel processes (odd number, for quorum) watch the primary, elect a new primary on failure, and publish the new address via a Pub/Sub channel that clients subscribe to. go-redis `FailoverClient` and rueidis both understand this protocol out of the box. Cluster is for horizontal scaling and comes with the CROSSSLOT tax described in objective seven above.

The data-structure box maps directly to first-job tickets. "Cache the user profile" is a hash. "Store the session" is a string or hash with TTL. "Maintain the leaderboard" is a sorted set. "Queue background jobs" is a list (for simple FIFO) or a stream (for durable, ack-able consumer groups). "Track unique visitors for the day" is a set (exact) or a HyperLogLog (approximate, 12 KB regardless of cardinality). Knowing which data type to reach for, and knowing why a HyperLogLog is not in the six-type summary but still matters, is a common interview signal.

The caching-patterns box is where juniors are most often wrong. Cache-aside is the correct default for read-heavy workloads with occasional writes. Write-through is correct when you need the cache to reflect writes immediately and can pay the double-write latency. Write-behind is almost always wrong, because an unacknowledged write sitting in Redis that has not been persisted to the database is a data-loss bomb waiting for the next failover. If you describe write-behind in an interview, follow it with "and I would only use it for metrics or non-critical telemetry where losing the last minute of data is acceptable."

The distributed-lock diagram shows `SETNX` (set-if-not-exists) and a UUID match on release. What the diagram omits is the most important line of code: the release must be a Lua script that atomically checks `GET key == uuid` and then `DEL key`, because a naive "GET then DEL in two round trips" will delete someone else's lock if your process stalled past the lock's TTL. This is the Redlock-lite that every senior engineer writes from memory.

### Senior @ FAANG: the architecture overview your juniors never see

The diagram is pedagogical. The real architecture your team is running has another dozen boxes, and as a staff engineer you are responsible for every one of them.

**The client tier is deeper than one box.** In front of go-redis or rueidis you will almost always have an in-process L1 cache (freecache, ristretto, or otter). L1 absorbs hotkey traffic that would otherwise concentrate on one Redis shard, and in the RESP3 era it can be kept coherent via server-assisted client-side caching. `CLIENT TRACKING ON REDIRECT <clientid> BCAST PREFIX user:` tells Redis to push an invalidation message on a dedicated connection whenever any key under `user:` changes. rueidis wires this to its L1 automatically via `CacheCall`. go-redis v9 exposes `ClientTracking` and lets you wire it to your own L1. The performance difference is measurable: a high L1 hit rate on a hot keyspace with sub-10ms broadcast-invalidation latency can cut Redis QPS by several fold, because the shard only sees the misses and the invalidations.

**The transport tier is not just TCP.** Redis 8.0 and Valkey 8.0 both support TLS 1.3 with mutual auth, and any FAANG-grade deployment mandates mTLS between services and the cache tier. The TLS handshake cost is the reason connection pools and keepalives matter more than they do on plain TCP. Redis 8 also added optional RDMA transport for same-datacenter deployments, which is experimental in 2026 and not yet supported by Go clients.

**The sharding tier has four realistic options, not one.** Redis Cluster with 16384 slots is the native answer and what most teams run. Twemproxy (nutcracker) and Envoy's Redis filter are client-agnostic proxy shards that predate Cluster and are still in use at places that cannot migrate. Application-level consistent hashing (the Facebook mcrouter approach) gives you the most control and the most operational burden. The fourth option is "run many small Redis instances each owned by a single service" and let the service mesh handle the routing. Some large shops deliberately reject Cluster for its operational complexity and instead run a fleet of many small single-domain Redis instances. The right answer depends on your org's operational muscle and the team topology.

**The replication and failover ADR has more dimensions than Sentinel vs Cluster.** Sentinel gives you HA within a region. Cluster gives you HA and horizontal scaling within a region. Neither gives you multi-region. For multi-region reads you can run a chain of replicas across regions (async replication, eventually consistent, risk of split-brain on network partition) or use Redis Enterprise Active-Active CRDT (commercial, last-writer-wins for strings, observed-remove for sets, counter-merge for INCR). For multi-region writes on open source there is no good answer today. AWS MemoryDB sidesteps the question by making Redis-compatible writes durably multi-AZ via a transaction log, but it is single-region-write with global-replica-read. When designing a global product, write the consistency model into the ADR explicitly: "user sessions are region-pinned, product catalog is region-replicated with 5s staleness tolerance, pricing is never cached across regions." The architecture that does not name its consistency class is the architecture that surprises you at quarter-end.

**The persistence tier is an ADR, not a checkbox.** A correct production Redis runs AOF with `appendfsync everysec` plus RDB snapshots every 6 hours, on a dedicated volume separate from the working-set memory-mapped region, with `no-appendfsync-on-rewrite yes` to avoid latency spikes during BGREWRITEAOF. Valkey 8.0 adds incremental AOF rewrite which reduces the latency cliff. For cache-only Redis the correct configuration is `save ""` (no RDB), no AOF, `maxmemory-policy allkeys-lfu`, and a documented warmup procedure after restart. Conflating these two configurations in the same cluster is a common and painful mistake.

**The observability tier must include slowlog, latency-monitor, and keyspace notifications.** `SLOWLOG GET 128` shows the last 128 commands that exceeded `slowlog-log-slower-than` microseconds (default 10000, set to 1000 in production to catch 1ms outliers). `LATENCY HISTORY event` tracks latency spikes by category (fork, aof-write, expire-cycle). `notify-keyspace-events Kx` enables keyspace notifications for expirations, which you can consume via Pub/Sub to drive invalidation logic. All three should feed into the same Prometheus/OpenTelemetry pipeline as the client-side metrics, so that a p99 regression on the client immediately correlates to a SLOWLOG entry on the server.

**The security tier is not optional in 2026.** Redis 6 added ACLs (`ACL SETUSER ...`) which let you restrict commands and keyspaces per user. Production deployments must: disable `CONFIG`, `DEBUG`, `FLUSHDB`, `FLUSHALL`, `KEYS`, and `SHUTDOWN` for application users, scope each service to its own key prefix via ACL categories and patterns, rotate passwords or use IAM auth (AWS ElastiCache supports IAM auth for Valkey as of late 2024), require TLS 1.3 with mutual auth, and run on a private subnet with no public endpoint. The prefix-governance document mentioned earlier is also the ACL source of truth: prefix owner becomes ACL user, prefix pattern becomes the ACL key pattern. This is the architecture that survives a pentest.

---
