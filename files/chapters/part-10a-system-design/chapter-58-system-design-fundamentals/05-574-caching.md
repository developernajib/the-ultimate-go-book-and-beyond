## 58.4 Caching

### Cache Tiers

A multi-tier caching architecture places caches at multiple levels between the user and the origin data store, with each tier serving a different scope and latency budget. Browser and CDN caches handle static content and reduce origin load by orders of magnitude. Application-level caches like Redis serve dynamic data with sub-millisecond latency. And in-process caches eliminate network round trips entirely for the hottest data. Understanding which tier to use for each data type, considering cache invalidation complexity, consistency requirements, and memory cost, is as important as implementing the cache itself.

```
Multi-Tier Caching Architecture:
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   ┌─────────┐                                           │
│   │ Browser │ ← L1: Browser Cache (localStorage, etc.)  │
│   └────┬────┘                                           │
│        │                                                │
│        ▼                                                │
│   ┌─────────┐                                           │
│   │   CDN   │ ← L2: CDN Cache (CloudFlare, CloudFront)  │
│   └────┬────┘                                           │
│        │                                                │
│        ▼                                                │
│   ┌─────────┐                                           │
│   │ Gateway │ ← L3: API Gateway Cache                   │
│   └────┬────┘                                           │
│        │                                                │
│        ▼                                                │
│   ┌─────────┐                                           │
│   │  App    │ ← L4: Application Cache (In-memory)       │
│   │ Server  │                                           │
│   └────┬────┘                                           │
│        │                                                │
│        ▼                                                │
│   ┌─────────┐                                           │
│   │  Redis  │ ← L5: Distributed Cache                   │
│   │Memcached│                                           │
│   └────┬────┘                                           │
│        │                                                │
│        ▼                                                │
│   ┌─────────┐                                           │
│   │Database │ ← L6: Database Query Cache                │
│   └─────────┘                                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Cache Invalidation Strategies

The hardest problem in caching is not storing data, it is deciding when stored data is no longer valid. TTL-based expiration is the simplest approach: data is considered good for a fixed duration, after which a cache miss triggers a fresh database read. Write-through keeps the cache always consistent by writing to the database and cache together, at the cost of write latency. Write-behind (write-back) sacrifices durability for write speed by acknowledging the write immediately after updating the cache and flushing to the database asynchronously via a goroutine-driven queue, a crash between the two writes causes data loss. Event-based invalidation is the most precise: a publish/subscribe channel delivers invalidation messages whenever the source data changes, enabling cache coherence without relying on TTL expiry.

```go
// Cache invalidation patterns

// 1. Time-Based Expiration (TTL)
type TTLCache struct {
    data sync.Map
}

type cacheEntry struct {
    value     any
    expiresAt time.Time
}

func (c *TTLCache) Set(key string, value any, ttl time.Duration) {
    c.data.Store(key, cacheEntry{
        value:     value,
        expiresAt: time.Now().Add(ttl),
    })
}

func (c *TTLCache) Get(key string) (any, bool) {
    entry, ok := c.data.Load(key)
    if !ok {
        return nil, false
    }
    e := entry.(cacheEntry)
    if time.Now().After(e.expiresAt) {
        c.data.Delete(key)
        return nil, false
    }
    return e.value, true
}

// 2. Write-Through Cache
// Writes go to cache AND database simultaneously
type WriteThroughCache struct {
    cache Cache
    db    Database
}

func (w *WriteThroughCache) Set(ctx context.Context, key string, value any) error {
    // Write to database first
    if err := w.db.Set(ctx, key, value); err != nil {
        return err
    }
    // Then update cache
    return w.cache.Set(ctx, key, value)
}

// 3. Write-Behind (Write-Back) Cache
// Writes go to cache first, database later (async)
type WriteBehindCache struct {
    cache     Cache
    db        Database
    writeQueue chan writeRequest
}

type writeRequest struct {
    key   string
    value any
}

func (w *WriteBehindCache) Set(ctx context.Context, key string, value any) error {
    // Write to cache immediately
    if err := w.cache.Set(ctx, key, value); err != nil {
        return err
    }
    // Queue database write
    w.writeQueue <- writeRequest{key, value}
    return nil
}

func (w *WriteBehindCache) flushWorker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case req := <-w.writeQueue:
            w.db.Set(ctx, req.key, req.value)
        }
    }
}

// 4. Cache-Aside (Lazy Loading)
// Application manages cache explicitly
type CacheAside struct {
    cache Cache
    db    Database
}

func (c *CacheAside) Get(ctx context.Context, key string) (any, error) {
    // Try cache first
    value, err := c.cache.Get(ctx, key)
    if err == nil {
        return value, nil
    }

    // Cache miss - load from database
    value, err = c.db.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Populate cache
    c.cache.Set(ctx, key, value)

    return value, nil
}

// 5. Event-Based Invalidation
type EventBasedCache struct {
    cache   Cache
    pubsub  PubSub
}

func (e *EventBasedCache) StartInvalidationListener(ctx context.Context) {
    sub := e.pubsub.Subscribe("cache:invalidate")
    for {
        select {
        case <-ctx.Done():
            return
        case msg := <-sub:
            e.cache.Delete(ctx, msg.Key)
        }
    }
}
```

### Cache Consistency Patterns

Read-through and cache-aside both implement lazy loading, data enters the cache only on a miss, but they differ in where the database fetch logic lives. In read-through, the cache layer itself is responsible for loading from the database on a miss, so the application always talks only to the cache. This simplifies application code but requires the cache to understand your data access layer. Cache-aside puts the application in control: on a miss the application fetches from the database and populates the cache explicitly, which is more transparent and lets you tune TTL and serialization per use case, at the cost of needing to handle the cache and database calls in every read path.

```
Read-Through vs Cache-Aside:

READ-THROUGH:
┌─────────┐    ┌─────────┐    ┌─────────┐
│   App   │───►│  Cache  │───►│   DB    │
└─────────┘    └─────────┘    └─────────┘
                    │
                    └── Cache handles DB reads automatically

CACHE-ASIDE:
┌─────────┐    ┌─────────┐
│   App   │◄──►│  Cache  │
└────┬────┘    └─────────┘
     │
     │         ┌─────────┐
     └────────►│   DB    │
               └─────────┘
                    │
                    └── App manages cache explicitly
```

### Junior → FAANG: Caching Patterns You Must Know Cold

Caching questions appear in almost every FAANG system design interview. The minimum vocabulary required: cache-aside (lazy loading), write-through, write-behind, and read-through. Know which layer is responsible for loading the database in each pattern, and know the consistency trade-off for each.

Cache-aside is the most common pattern in practice and the one most likely to appear in an interview. The key detail interviewers probe: what happens between the moment a key expires and the moment it is repopulated? That window is where cache stampedes happen. Being able to name `singleflight` as a Go-specific mitigation, or describe a distributed lock approach, demonstrates practical awareness beyond the textbook pattern.

TTL selection is a prerequisite gap for many junior candidates. The intuition is simple: shorter TTLs mean fresher data but more database load. Longer TTLs reduce database load but risk serving stale data for longer. The interview question is always: how would you choose the TTL for this specific data type? Practice giving answers with specific numbers and reasoning, not just "it depends." For user profile data: "I would use 5 minutes because profile changes are low-frequency and a 5-minute delay is acceptable to the user." For inventory counts: "I would use 30 seconds at most, because an oversold item is a direct customer and financial impact."

The multi-tier caching diagram in this section is worth memorizing. Interviewers frequently ask about it explicitly. Know which tier is appropriate for static assets (CDN), dynamic but user-agnostic data (shared Redis), and user-specific data (application-level cache with user-scoped keys).

### Senior @ FAANG: Cache Architecture at Organizational Scale

At staff level, caching is a platform concern. The decisions you make about caching infrastructure affect every team, and getting them wrong creates organization-wide reliability and consistency problems that are expensive to fix.

**Cache invalidation as a first-class design problem.** The write-behind pattern has a durability gap: if the application crashes between the cache write and the deferred database write, data is lost. At FAANG scale this is not a theoretical concern. It is a failure mode that must be documented, with an explicit answer to: what data is acceptable to lose, what is not, and how do you detect and recover from a write-behind failure? The answer often involves a write-ahead log or a durable queue (Kafka, SQS) as the intermediary between the cache write and the database write, rather than a simple goroutine channel.

**Cache key design as an API contract.** Cache key design is often treated as an implementation detail but it is actually a contract. If two teams cache the same entity with different key schemes (`user:{id}` versus `u:{id}:{version}`), they will have inconsistent invalidation behavior and subtle bugs when one team updates the entity without knowing the other team's cache is now stale. At the staff level, you define a cache key standard for your platform (namespace, entity type, version, ID) and enforce it through code review or tooling.

**Cache warming and cold-start reliability.** A cold cache after a deployment or a cache cluster failure is a reliability event. If 100% of requests suddenly reach the database because the cache is empty, you get a latency spike that can look like an outage. At Netflix, EVCache warming is a first-class deployment step: before cutting over to a new cache cluster, a warming job preloads the most frequently accessed keys. At the staff level, you design the warming strategy as part of the caching architecture, not as an afterthought. This includes knowing which keys to warm (top-N by access frequency from the previous 24 hours), how fast to warm (throttled to avoid overloading the database), and what hit-rate threshold must be reached before the cluster is considered production-ready.

**Cache observability as a reliability signal.** Cache hit rate is a lagging indicator: by the time it drops, users are already experiencing latency spikes. Leading indicators include key expiry rate (are more keys expiring than expected, possibly indicating a deployment that changed key naming), eviction rate (is the cache out of memory and starting to drop keys before their TTL), and write-behind queue depth (is the async flush to the database keeping up). At L6, you define the alert thresholds for these metrics and the runbook for each. At L7, you define the organization-wide observability standards that make these metrics visible by default for every team using the shared caching platform.

**Multi-tier consistency and invalidation propagation.** In a multi-tier cache, a write to the database must propagate invalidations through every tier: the in-process cache on every application instance, the shared Redis cluster, and potentially CDN edge nodes. A write that only invalidates the Redis layer leaves in-process caches serving stale data for up to their TTL. Pub/sub channels (Redis keyspace notifications, or a dedicated invalidation bus) can propagate invalidations to all application instances, but they add latency and complexity. The decision of which tiers to invalidate synchronously versus asynchronously is a trade-off between write latency and consistency, and it should be documented per data type, not decided per feature.

---
