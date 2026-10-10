## 37J.1 Cache Invalidation Fundamentals

### The Two Hard Problems

The four major invalidation strategies each occupy a different point in the consistency-complexity trade-off space: TTL is operationally simple but tolerates bounded staleness. Event-driven invalidation is precise but requires reliable message delivery. Version/ETag embedding is safe but can cause key explosion at scale. And surrogate/cache-tag purging offers the best precision at the cost of CDN-vendor support. Choosing the wrong strategy (such as using long TTLs on mutable pricing data) is a common source of correctness bugs that only surface under production load.

```
Cache Invalidation Architecture
═══════════════════════════════════════════════════════════════════

  "There are only two hard problems in computer science:
   cache invalidation, naming things, and off-by-one errors."
                                             - Phil Karlton

  Invalidation Strategies:
  ┌──────────────────────────────────────────────────────────┐
  │  1. TTL (Time-to-Live)                                   │
  │     Simple, predictable, allows bounded staleness        │
  │     Problem: data stale until TTL expires                │
  │                                                          │
  │  2. Event-Driven (Active Invalidation)                   │
  │     Publish invalidation event when data changes         │
  │     Problem: distributed consistency, missed events      │
  │                                                          │
  │  3. Version/ETag                                         │
  │     Embed version in cache key or conditional headers    │
  │     Problem: version management, key proliferation       │
  │                                                          │
  │  4. Surrogate Keys / Cache Tags                          │
  │     Tag cache entries, purge by tag                      │
  │     Problem: CDN must support surrogate keys             │
  │                                                          │
  │  5. Write-Invalidate vs Write-Update                     │
  │     Write-invalidate: delete cache on write              │
  │     Write-update: update cache with new value            │
  └──────────────────────────────────────────────────────────┘

  Invalidation Latency Budget:
  Change in DB
       │ t=0
       ▼
  Event published to message bus
       │ t=50ms (typical Kafka latency)
       ▼
  Cache service processes event
       │ t=100ms (processing + network)
       ▼
  CDN purge API called
       │ t=100-500ms (CDN propagation)
       ▼
  All edge nodes purged
       │ t=1-10s (global CDN propagation)
       ▼
  Users see fresh content
```

### Junior → FAANG: the mental model to build before you touch code

A useful worked example to run yourself in Go. Build a tiny HTTP service with one endpoint `GET /product/:id` backed by a Postgres table and a Redis cache. Implement the same endpoint three ways in three separate handlers. Handler A uses `SET key value EX 300` on cache miss and accepts 5 minutes of staleness. Handler B deletes the key inside the UPDATE transaction (actually after the commit, and notice why that ordering matters). Handler C reads a version integer from a metadata row and builds the cache key as `product:42:v7`, so an UPDATE that bumps the version causes the old key to be orphaned and the new read to miss cleanly. Run a small loop that does concurrent reads and writes against each handler and count how many reads see stale data. You will discover on your own that Handler B has a race: reader loads row, writer commits and issues DEL, reader writes its now-stale snapshot back to Redis. The fix (double-delete pattern, or read-after-write token, or versioned keys) is not a trick to memorize, it is something you derive once you have seen the race. For interviews, the entry-point question is always "walk me through what happens from the moment a user hits Save." Your answer must include: transaction commit point, cache invalidation ordering, reader races, staleness bound, and what a second request in the same session should see. If you can draw that timeline on a whiteboard with the race window shaded, you pass the caching portion of a system-design loop.

### Senior @ FAANG: invalidation as a consistency contract, not a cache operation

At staff level you stop thinking about invalidation as "clear the cache" and start thinking about it as the consistency contract between writers and readers, with the cache as one of several enforcement points. Phil Karlton's line is a warning about the surface area of that contract. Each strategy in the diagram above commits to a different contract and you must be able to articulate it. TTL-only commits to "eventual consistency with a bound of T seconds, readers may see arbitrarily old values within T." This is acceptable for feeds, trending lists, and analytic rollups. It is unacceptable for anything an authenticated user just edited themselves, because it violates read-your-writes. Active invalidation commits to "eventual consistency with bound measured by the propagation latency of the invalidation pipeline," typically p99 of 100ms to 2s depending on topology. Versioned keys commit to "monotonic reads, a reader never sees an older version after seeing a newer one, at the cost of memory for orphaned keys until their TTL fires." Surrogate-key (tag) invalidation commits to "atomic fanout across a set of logically related entries with a single API call," crucial when one DB write affects a product page, a category listing, a search result, and a sitemap entry that all cache independently. The operational discipline that separates senior engineers is coupling the strategy to the data's consistency requirement and writing that requirement down in an ADR. A request like "cache the dashboard" should be rejected until the author specifies the acceptable staleness, the invalidation triggers, the fallback on cache outage, and the blast radius of a bad purge. You also own the failure modes. What happens when the Kafka consumer falls behind by an hour? You need a lag alert and a "soft" fallback that shortens TTL when lag exceeds threshold. What happens when the CDN purge API is down? You need Cache-Control max-age short enough that the world heals without the purge, and you need synthetic probes that detect a failed purge by comparing origin and edge responses. What happens when a bug causes you to purge everything? You need rate limits on `purge_everything`, audit logs, and a playbook that pre-warms critical URLs from origin before the thundering herd takes the origin down. None of this is in the Redis docs. It is the operational envelope around invalidation, and it is what staff engineers are hired to design.

---
