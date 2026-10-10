## 35.3 Caching Patterns

### Cache-Aside Pattern

The cache-aside pattern implemented here reads from Redis first using `rdb.Get`, falls back to `getUserFromDB` on a cache miss, then writes the fetched value back to Redis with a configurable TTL before returning. The error from `rdb.Get` is checked only for the nil case (cache hit). Other errors (e.g., Redis unavailable) fall through to the database silently, keeping the cache a performance optimization rather than a hard dependency. `InvalidateUser` deletes the cache key immediately on mutation so subsequent reads fetch fresh data rather than serving a stale cached version.

Cache-aside is the most common of four patterns engineers should know:

- **Cache-aside (lazy loading):** application reads cache, falls back to DB on miss, populates cache. Simple, resilient to cache outages, but the first request after a miss pays full DB latency.
- **Read-through:** the cache library itself loads from the source of truth on miss. Same failure modes as cache-aside but hides the load path from callers. Common in library-backed caches (e.g., Caffeine-style loaders).
- **Write-through:** every write updates DB and cache synchronously. Strong consistency at the cost of write latency and a hard cache dependency.
- **Write-behind (write-back):** writes go to the cache and are flushed to DB asynchronously. Highest write throughput, but data loss is possible if the cache dies before flush - only acceptable for non-durable state (session data, metrics).

**TTL with jitter.** When many keys share the same base TTL and expire in the same second, a cache stampede hits the database at once. Add per-key random jitter to the TTL so expirations spread out - typically 10-20% of the base TTL. In the `Set` below, replace `c.ttl` with `c.ttl + time.Duration(rand.Int63n(int64(c.ttl/5)))` to spread expirations across a 20% window.

```go
type CacheService struct {
    rdb *redis.Client
    db  *sql.DB
    ttl time.Duration
}

func (c *CacheService) GetUser(ctx context.Context, id string) (*User, error) {
    // Try cache first
    cached, err := c.rdb.Get(ctx, "user:"+id).Result()
    if err == nil {
        var user User
        if err := json.Unmarshal([]byte(cached), &user); err == nil {
            return &user, nil
        }
    }

    // Cache miss - get from database
    user, err := c.getUserFromDB(ctx, id)
    if err != nil {
        return nil, err
    }

    // Store in cache
    data, _ := json.Marshal(user)
    c.rdb.Set(ctx, "user:"+id, data, c.ttl)

    return user, nil
}

func (c *CacheService) InvalidateUser(ctx context.Context, id string) error {
    return c.rdb.Del(ctx, "user:"+id).Err()
}
```

### Write-Through Cache

Write-through caching updates the database and the cache in the same `UpdateUser` call, ensuring the cache is never stale immediately after a write. The database write happens first: if it fails, the cache is not updated and the old cached value remains valid. If the cache write fails after a successful database write, the cache key becomes stale until it expires, which is acceptable, since a subsequent `GetUser` call will re-populate it from the database on the next miss.

```go
func (c *CacheService) UpdateUser(ctx context.Context, user *User) error {
    // Update database first
    if err := c.updateUserInDB(ctx, user); err != nil {
        return err
    }

    // Update cache
    data, _ := json.Marshal(user)
    return c.rdb.Set(ctx, "user:"+user.ID, data, c.ttl).Err()
}
```

### Cache with Tags

Tag-based cache invalidation tracks which cache keys belong to each logical group by storing key names in a Redis Set per tag, enabling bulk invalidation of all keys associated with a tag (e.g., all product pages for a category) with a single `SMEMBERS` + `DEL` sequence. The `Set` call uses a pipeline to atomically write the value and update all tag sets in a single round trip, avoiding partial updates where the value is stored but the tag membership is not. Tags are stored without a TTL on the set itself, so the tag set is cleaned up only when `InvalidateByTag` explicitly deletes it alongside the member keys.

```go
type TaggedCache struct {
    rdb *redis.Client
}

func (c *TaggedCache) Set(ctx context.Context, key string, value any, ttl time.Duration, tags ...string) error {
    data, _ := json.Marshal(value)

    pipe := c.rdb.Pipeline()
    pipe.Set(ctx, key, data, ttl)

    // Add key to each tag set
    for _, tag := range tags {
        pipe.SAdd(ctx, "tag:"+tag, key)
    }

    _, err := pipe.Exec(ctx)
    return err
}

func (c *TaggedCache) InvalidateByTag(ctx context.Context, tag string) error {
    // Get all keys with this tag
    keys, err := c.rdb.SMembers(ctx, "tag:"+tag).Result()
    if err != nil {
        return err
    }

    if len(keys) == 0 {
        return nil
    }

    pipe := c.rdb.Pipeline()
    pipe.Del(ctx, keys...)
    pipe.Del(ctx, "tag:"+tag)
    _, err = pipe.Exec(ctx)
    return err
}

// Usage
func example(ctx context.Context, cache *TaggedCache) {
    // Cache user with tags
    cache.Set(ctx, "user:1", user, time.Hour, "users", "team:engineering")

    // Invalidate all users
    cache.InvalidateByTag(ctx, "users")

    // Invalidate team cache
    cache.InvalidateByTag(ctx, "team:engineering")
}
```

### Junior → FAANG: caching bugs that look fine in review and fail in production

The cache-aside code above is correct at a glance and wrong in four specific ways that every junior discovers under load.

**The stampede.** When a popular key expires, every concurrent request misses the cache at once, and every one of them hits the database. For a key serving 10000 QPS with a database that handles 500 QPS, this is an outage. The fix is singleflight: use `golang.org/x/sync/singleflight` to collapse concurrent loads of the same key into one database call that fans out the result to all waiters. Wrap `c.getUserFromDB` in `sfGroup.Do(key, func() (...))` and you have just prevented the most common Redis-backed database outage in the industry. The second fix is probabilistic early expiration (XFetch algorithm): instead of waiting for the TTL to hit zero, each reader computes `now + beta * delta * ln(rand())` and proactively refreshes if that time has passed, so refreshes are spread out rather than clustered at expiry.

**The negative-cache hole.** The code returns an error on DB failure but does not cache the "not found" result. A request for a non-existent user hits the database every time, which is a denial-of-service vector if an attacker hits `/user/random-uuid` in a loop. Cache negatives too: on "not found" store a sentinel value (empty string, or a JSON null) with a short TTL (30-60 seconds is typical) and check for it on read. Balance TTL against the risk of hiding a newly created user from view.

**The stale read after write.** `UpdateUser` in the write-through section writes the DB then writes the cache. If a concurrent `GetUser` reads the cache between those two writes, it sees the old value, caches it (if the cache was empty), and serves stale data for the full TTL. A safer pattern is delete-on-write instead of update-on-write: write the DB, then `DEL` the cache key. The next reader misses and repopulates from fresh DB state. This avoids the double-write inconsistency entirely. Facebook's TAO paper documents this as the standard pattern at scale.

**The thundering herd of invalidation.** `InvalidateByTag` calls `DEL key1 key2 ... keyN`. For a tag with 100000 keys this is one massive O(N) DEL that blocks Redis. Use `UNLINK` instead of `DEL` (lazy free in a background thread, Redis 4.0+). And batch the unlink in chunks of 1000 keys with a pipeline, sleeping briefly between batches, so the invalidation does not starve other commands.

Worked example for a phone-screen. "Cache the homepage for 5 minutes. What goes wrong?" The junior answer is `SET homepage <html> EX 300`. The FAANG answer adds: TTL jitter so a million clients do not all miss at 300 seconds exactly, singleflight so only one render hits the backend on miss, stale-while-revalidate semantics so the expired cache is served for up to 60 more seconds while a background refresh runs, a negative cache for personalized variants that return no content, and a circuit breaker that serves last-known-good from a longer-TTL fallback key when the render service is down. Five bullet points, five outages avoided.

### Senior @ FAANG: the cache-invalidation ADR, stampede math, and the 2026 patterns

Phil Karlton's line about the two hard things in computer science was a joke that became a design discipline. At staff level, "cache invalidation" is an ADR you write before you write the code.

**The invalidation mechanism matrix.** Five real mechanisms, each with a failure mode.

1. **TTL-only.** Simplest, always works, always stale for up to TTL. Correct for data where staleness is bounded and acceptable (product descriptions, user profiles at one-hour staleness). TTL jitter mandatory.
2. **Application-level delete on write.** The service that writes the DB also deletes the cache key. Works until a second writer bypasses the service (batch job, admin console, another microservice). Then the cache diverges silently.
3. **PubSub fanout on invalidation.** The writer publishes an invalidation event to a Redis channel, all cache nodes subscribe and delete their local L1 copy. Fast but lossy: subscribers that are disconnected miss messages. Use as a fast-path supplement, not a correctness mechanism.
4. **Database CDC (Debezium, Postgres logical replication, DynamoDB Streams).** Every commit to the source of truth emits an event that drives cache invalidation. This is the only mechanism that catches all writers, including batch jobs and human DBAs. It is also the highest operational cost. This is what Shopify, Airbnb, and Netflix converged on for customer-visible caches.
5. **Server-assisted client-side caching (Redis 6+ with RESP3).** `CLIENT TRACKING ON BCAST PREFIX user:` makes Redis push invalidation messages to all clients that have recently read a key. rueidis wires this into its L1 automatically. This handles Redis-to-client invalidation correctly, but does not handle DB-to-Redis invalidation, which is still mechanism 4.

Write the ADR by enumerating each keyspace, naming the durability class (cache, ephemeral, durable, authoritative), and stating which mechanism applies. Homepage HTML uses TTL-only with 5-minute jitter. User profiles use TTL plus application-level delete on write. Product prices use CDC from Postgres. Feature flags use PubSub fanout with a 10-minute TTL fallback. Each line is defensible. A cache layer without this document is a cache layer that will have a six-hour incident within the year.

**Stampede math that belongs in the ADR.** For a key with QPS `q`, TTL `T`, and database capacity `C`, the probability of stampede at expiry scales with `q * recomputation_time / 1`. If your computation takes 100ms and `q = 1000 QPS`, then 100 requests arrive during recomputation and all miss the cache. Without singleflight you issue 100 parallel DB queries. With singleflight you issue 1. The math is unforgiving. Any cache serving more than `C / recomputation_time` QPS must use singleflight or probabilistic early expiration or both. The Vattani et al. XFetch paper (`delta * beta * ln(rand())`) gives you the beta to tune: beta=1 (default) is sensible, beta<1 refreshes later, beta>1 refreshes earlier. Combine with lock-based stampede protection (set a `refresh:key` lock with a short TTL so only one refresh runs) when probabilistic refresh is not enough.

**Cache-aside vs read-through vs write-through vs write-behind, chosen by SLO.** Cache-aside is the default. Read-through (library loads from DB on miss) is cache-aside with the DB-load logic moved into the cache library, useful when multiple call sites would otherwise duplicate the load code and the library-level consistency is easier to reason about. Write-through doubles write latency but gives strong read-after-write consistency, correct for high-visibility paths (profile edits, settings that the user expects to see immediately). Write-behind is correct only for state that is already non-durable (telemetry, metrics, session last-seen) and even then requires a durable buffer (Kafka topic) between cache and DB so a cache crash does not lose writes. Write-behind to Redis without a durable buffer is an anti-pattern in 2026.

**TTL as a function of access pattern.** The correct TTL is not "whatever feels right." It is a function of the cost of staleness, the cost of recomputation, and the hit-rate curve. For read-heavy data with slow change, longer TTL saves DB load. For fast-changing data with strict freshness, short TTL plus event-driven invalidation. A specific heuristic: TTL should be short enough that in the window between invalidations being missed (mechanism 3 or 4 failing) the cached staleness is acceptable. If your invalidation stream SLO is 99.9 percent delivery with 5-minute recovery, your TTL should be at most 5 minutes for any data where staleness-beyond-the-invalidation-SLO is not tolerable.

**Client-side caching with RESP3 (the 2026 default).** `CLIENT TRACKING ON REDIRECT <clientid> BCAST PREFIX user:` tells Redis that this client has an L1 cache tracking all keys under `user:` and wants invalidation pushes. When any writer changes a tracked key, Redis emits a push message on a dedicated invalidation connection. rueidis wraps this as `CacheCall`: you call `client.DoCache(ctx, cmd, 30*time.Second).ToString()` and rueidis returns the locally-cached value if fresh, or fetches and caches on miss, and evicts on invalidation. Measured wins: 80-95 percent L1 hit rate on user-profile workloads, 3-10x reduction in Redis QPS, p99 latency dropped from 1ms to under 50 microseconds for cached reads. The tradeoff is that every writer must go through Redis (direct DB writes do not invalidate the L1), which forces the architectural discipline of "Redis is the invalidation bus, even when Redis is not the source of truth." That discipline is a feature, not a bug.

**Negative caching and authorization caching.** Cache "not found" with a short TTL (30-60s) to protect against scan attacks. Cache "user X may not view resource Y" only with extreme care: permission caches that outlive the revocation window are security bugs. The conservative rule is: never cache deny decisions beyond 60 seconds, and always invalidate the permission cache on any RBAC mutation. When revocation is critical (fired employees, compromised accounts), do not cache allow decisions either. Pay the latency for correctness.

**The fallback hierarchy.** Production caches have three layers, not one. L1 is in-process (ristretto, otter) with microsecond latency and per-pod capacity. L2 is Redis or Valkey with sub-millisecond latency and shared capacity. L3 is the source of truth. Reads try L1, then L2, then L3, populating upward. Writes invalidate L2 (which triggers L1 invalidation via CLIENT TRACKING) and update L3. This three-layer model is what Google, Meta, and Netflix run. The book's two-layer model (Redis and DB) is the starting point. The three-layer model is the destination.

**The observability that catches invalidation storms.** Track hit rate per prefix in a histogram. Alert on a drop of more than 10 percent over 5 minutes. An invalidation-storm signature (mass DELETE from a runaway CDC consumer or a tag explosion) shows as a hit-rate cliff followed by a DB-load spike. Track invalidation-message rate per prefix and alert on sudden rises. Track L1 hit rate separately from L2 hit rate so you can distinguish "L2 is healthy, L1 is cold" from "L2 is dying, everything falls through." This telemetry is what lets you detect cache pathologies in minutes rather than during the post-incident review.

---
