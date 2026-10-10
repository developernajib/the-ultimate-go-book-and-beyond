## 37I.1 Caching Architecture

### Multi-Layer Cache Stack

A multi-layer cache stack trades latency for capacity at each tier: the in-process L1 (ristretto/v2, otter/v2, or sync.Map) returns data in under 0.1ms with no network round-trip, while the distributed L2 (Redis or Valkey) serves gigabytes of shared state at 0.5-2ms. The L3 origin (database or external API) is only reached on a full miss through both tiers. Cache-aside, write-through, write-behind, and read-through patterns each carry distinct consistency and latency trade-offs that must be matched to the mutability and criticality of the cached data.

**Choosing an L1 library.** `dgraph-io/ristretto/v2` uses TinyLFU admission with BP-Wrapper to reduce lock contention and is widely deployed in production (Dgraph, Badger, many CNCF projects). `maypok86/otter/v2` ships an adaptive W-TinyLFU that tracks Caffeine's Java implementation. independent benchmarks show higher hit rates than ristretto on OLTP-style traces where recency matters as much as frequency, but ristretto is still faster when the workload is dominated by frequency-skewed hotspots. `sync.Map` is only appropriate when the working set is bounded and you don't need eviction. Default to ristretto for throughput-first caches and otter for hit-rate-first caches.

```
Multi-Layer Caching Architecture
═══════════════════════════════════════════════════════════════════

  Request Flow:
  ┌──────────┐     ┌───────────────────────────────────────────┐
  │  Client  │────►│                Application                │
  └──────────┘     │                                           │
                   │  L1 Cache (in-process)                    │
                   │  ┌─────────────────────────────────────┐  │
                   │  │  ristretto/v2 / otter/v2 / sync.Map │  │
                   │  │  Size: 10-100MB  Latency: <0.1ms    │  │
                   │  └─────────────────────────────────────┘  │
                   │                  │ miss                   │
                   │  L2 Cache (distributed)                   │
                   │  ┌─────────────────────────────────────┐  │
                   │  │  Redis/Valkey Cluster / Memcached   │  │
                   │  │  Size: GBs-TBs  Latency: 0.5-2ms    │  │
                   │  └─────────────────────────────────────┘  │
                   │                  │ miss                   │
                   │  L3 / Origin                              │
                   │  ┌─────────────────────────────────────┐  │
                   │  │  Database / External API            │  │
                   │  │  Latency: 5-50ms                    │  │
                   │  └─────────────────────────────────────┘  │
                   └───────────────────────────────────────────┘

  Cache Patterns:
  ┌────────────────┬───────────────────────────────────────────┐
  │ Cache-Aside    │ App checks cache; on miss, fetches + sets │
  │ (Lazy Loading) │ Pros: only caches what's used             │
  │                │ Cons: cache miss latency, stale data      │
  ├────────────────┼───────────────────────────────────────────┤
  │ Write-Through  │ App writes cache + DB synchronously       │
  │                │ Pros: cache always warm                   │
  │                │ Cons: write latency, cached unused data   │
  ├────────────────┼───────────────────────────────────────────┤
  │ Write-Behind   │ App writes cache; async flush to DB       │
  │ (Write-Back)   │ Pros: low write latency                   │
  │                │ Cons: data loss risk, complexity          │
  ├────────────────┼───────────────────────────────────────────┤
  │ Read-Through   │ Cache fetches from DB on miss             │
  │                │ Pros: application logic simplified        │
  │                │ Cons: cold start, specialized libraries   │
  └────────────────┴───────────────────────────────────────────┘
```

### Junior → FAANG: reading the cache stack diagram like an engineer

The diagram above is not an org chart. Each layer is a contract between latency, capacity, and consistency. Read it from the bottom up once: L3 origin has the truth but is slow and expensive per call. L2 has a shared copy but costs a network round-trip. L1 has the fastest copy but is per-process and duplicated across every replica. The capacity halves and the latency drops by an order of magnitude at each step up. Every design decision in the rest of the chapter is about where to put a given piece of data in that hierarchy and for how long.

First-job worked example. Your team's product service runs on eight replicas. Product metadata changes roughly once an hour per product. You decide to cache 10,000 products at L1 (in-process) with a 5 minute TTL, and the full 200,000 product catalog at L2 (Redis) with a 1 hour TTL. A read flows L1, then L2, then Postgres. An edit from the admin panel updates Postgres and publishes a Redis `DEL product:{id}` to purge L2, plus a pub/sub message that each replica consumes to purge its own L1 entry. That is the textbook shape of a tiered cache with invalidation. The junior mistake is to cache at L1 without an invalidation path, which means edits take up to 5 minutes to appear. The senior fix is the pub/sub invalidation bus.

Interview entry points at this layer: explain why L1 is per-process and not shared, explain what happens when one replica publishes an invalidation and another replica is partitioned from Redis, and explain why you would ever pick a larger L1 size over a larger L2 size. Short answers: L1 lives in the process because crossing a network defeats the purpose of L1, network partition leaves the partitioned replica serving stale data until its TTL fires (which is the defensive floor), and L1 growth helps when the per-replica hot set is small and stable, while L2 growth helps when the shared tail is what matters.

### Senior @ FAANG: tiered coherence, admission, and the sizing ADR

Staff-level work on the cache stack is dominated by three questions. First, what is the invalidation topology. Second, what is the admission policy at each layer. Third, how do you write down the sizing decision so the next engineer who touches the code knows why you picked those numbers.

Invalidation topology options form a spectrum. At one end, rely entirely on TTL and accept bounded staleness (the **TTL-only** model). This is what most CDNs do, and it is correct when the staleness window is within the product's tolerance. In the middle, use **pub/sub broadcast** over Redis Keyspace Notifications or a dedicated channel per cache namespace. Every replica subscribes and purges its L1 on message receipt. This is cheap, but lossy under partition. Plan for the partition case with a short L1 TTL (30 to 120 seconds) as a defense in depth. At the strict end, use **version-stamped reads**: every cached entry carries a monotonic version, the writer bumps the version in a central store (Redis or a database row), and readers compare versions on every read. This is closer to linearisable but doubles L2 round-trips, so it is only worth it for entries where staleness is unacceptable (billing counters, authorization rules, feature flags during incident response).

Admission policy at L1 is where ristretto versus otter matters in practice. Ristretto uses **TinyLFU admission** gating the underlying SLRU: a candidate must win a frequency comparison against the would-be victim before entering the main cache. This makes ristretto resistant to scan-heavy workloads where a one-pass read tries to evict the hot set. Otter's **adaptive W-TinyLFU** adds a small dynamic window for recently admitted items, which improves hit rate on workloads with strong recency bursts (user-session data, recent comments, notification feeds). Freecache and bigcache avoid GC pressure by holding bytes in a ring buffer, trading admission sophistication for GC-free behavior. Theine is a newer Go port of Caffeine's adaptive W-TinyLFU with generic support. The staff decision matrix is: frequency-skewed and throughput-critical picks ristretto, recency-mixed and hit-rate-critical picks otter or theine, multi-gigabyte caches with heavy GC pressure pick freecache or bigcache, and only pick sync.Map when eviction is not required.

The sizing ADR should state: the working-set estimate (number of unique keys times average entry size), the target hit rate (usually 90 to 99 percent depending on origin cost), the chosen library and eviction policy with justification, the memory budget per replica, the TTL policy and jitter range, and the invalidation mechanism. Include the fallback plan: what happens when the L1 is cold (cold-start warmer), when the L2 is down (serve stale L1 with a degraded-mode flag), and when both are down (circuit breaker to shed load rather than melt the origin). A good ADR fits on one page and answers the questions the on-call engineer will ask at 3am.

Tiered coherence failure modes deserve named attention. **Negative cache drift** happens when a 404 is cached at L1 for 60 seconds, the entity is then created, and the first requester still sees 404 until the L1 TTL fires. The fix is a shorter TTL for negative entries (10 to 30 seconds) plus an explicit invalidation on create. **Thundering herd at tier boundaries** happens when L1 expires simultaneously across replicas and they all hit L2 at once, or when L2 expires and all replicas hit the database. Singleflight solves the per-replica case. A **distributed singleflight** using a Redis SETNX lock with a fence token solves the cross-replica case. **Stale-while-revalidate** is the pattern where a slightly expired entry is still returned to the caller while a background goroutine refetches: this is strictly a latency optimization and must be disabled for data where staleness is a correctness bug (anything touching money, auth, or safety).

---
