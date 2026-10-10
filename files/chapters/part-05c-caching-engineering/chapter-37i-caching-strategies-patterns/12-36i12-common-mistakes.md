## 37I.12 Common Mistakes

### 1. Cache-Aside Race Condition

When two goroutines miss the cache simultaneously, both fetch from the database and both write to the cache. The last write wins, which is harmless for immutable data but dangerous for mutable values like inventory counts or prices where the two fetches might return different results. Using singleflight collapses concurrent fetches into one, eliminating the race.

```go
// BAD: two goroutines can both miss and populate with different values
func GetProduct(ctx context.Context, id string) (*Product, error) {
    p, err := cache.Get(ctx, "product:"+id)
    if err == ErrCacheMiss {
        p, _ = db.GetProduct(ctx, id) // goroutine A and B both reach here
        cache.Set(ctx, "product:"+id, p, 5*time.Minute) // both write, last wins
    }
    return p, nil
}
// Problem: fine for immutable data - dangerous for inventory counts or prices

// GOOD: use single-flight to deduplicate concurrent fills
func GetProduct(ctx context.Context, id string) (*Product, error) {
    return productCache.GetWithSingleFlight(ctx, "product:"+id, 5*time.Minute, func(ctx context.Context) (*Product, error) {
        return db.GetProduct(ctx, id)
    })
}
```

### 2. Not Handling Cache Errors Gracefully

Cache errors should be treated as soft failures: returning the error directly makes every Redis hiccup an outage, whereas falling through to the database on any non-miss error keeps the service degraded but alive. The `errors.Is(err, ErrCacheMiss)` check distinguishes an expected miss from a genuine network or timeout error, letting the latter be logged without blocking the request.

```go
// BAD: cache error = request failure
func GetUser(ctx context.Context, id string) (*User, error) {
    var user User
    if err := cache.Get(ctx, "user:"+id, &user); err != nil {
        return nil, err // Redis down = request fails
    }
    return &user, nil
}

// GOOD: cache failure falls through to DB
func GetUser(ctx context.Context, id string) (*User, error) {
    var user User
    err := cache.Get(ctx, "user:"+id, &user)
    if err == nil {
        return &user, nil
    }
    if !errors.Is(err, ErrCacheMiss) {
        log.Warn("cache error, falling through to DB", "err", err)
    }
    // Fall through to DB regardless of error type
    return db.GetUser(ctx, id)
}
```

### 3. Caching Mutable Aggregates

Caching a derived value (like a count or a total) with a long TTL means the cache will be wrong for the entire TTL duration after any mutation. For values that change frequently, use a short TTL or update the cached value atomically (e.g., Redis `INCR`) on each mutation rather than recomputing from the database.

```go
// BAD: caching a user's "total orders" count with long TTL
cache.Set(ctx, "user:"+id+":order_count", count, 24*time.Hour)
// If user places an order, the count is stale for up to 24 hours

// GOOD: use short TTL for mutable aggregates, or compute from events
cache.Set(ctx, "user:"+id+":order_count", count, 30*time.Second)
// Or: use Redis INCR on each order creation
redis.Incr(ctx, "user:"+id+":order_count")
```

### 4. Using Cache as Primary Data Store

Redis without persistence is volatile memory: a restart or OOM event silently destroys every key, so using it as the sole write target converts a cache into an unreliable primary store. The correct pattern writes to the durable database first, then populates the cache in a best-effort call. If the cache write fails the data is still safe, and the next read will repopulate from the database.

```go
// BAD: writing to Redis without a durable DB
func SaveSession(ctx context.Context, session Session) error {
    return cache.Set(ctx, "session:"+session.ID, session, 24*time.Hour)
}
// If Redis fails or restarts, all sessions are lost → users logged out

// GOOD: persist to DB, cache for fast access
func SaveSession(ctx context.Context, session Session) error {
    if err := db.SaveSession(ctx, session); err != nil {
        return err
    }
    cache.Set(ctx, "session:"+session.ID, session, 24*time.Hour) // best-effort
    return nil
}
```

### 5. Synchronized TTL Expiry (No Jitter)

Populating a batch of keys with the same fixed TTL - for example during a warm-up, after a deploy, or after a tag-based invalidation sweep - guarantees they will all expire in the same millisecond. Under load, the resulting wave of concurrent misses collapses into a coordinated stampede that can take the origin database down even with singleflight in place (because each key is a distinct singleflight group). Adding a small random jitter to every TTL prevents the cliff.

```go
// BAD: every product in this warm-up has the same expiry instant.
for _, p := range products {
    cache.Set(ctx, "product:"+p.ID, p, 5*time.Minute)
}

// GOOD: spread expiry over a 20% window.
const base = 5 * time.Minute
for _, p := range products {
    jitter := time.Duration(rand.Int64N(int64(base) / 5))
    cache.Set(ctx, "product:"+p.ID, p, base+jitter)
}
```

### 6. No Negative Caching for Not-Found Results

When the origin returns "no such key", cache-aside without a negative entry hits the database on every subsequent lookup for that key - forever. A scraper enumerating IDs, or a malformed client loop, turns this into a sustained database scan. Cache a short-lived sentinel (30-60s) so repeat misses return instantly.

```go
// BAD: every miss for a non-existent user hits the DB.
func GetUser(ctx context.Context, id string) (*User, error) {
    var u User
    if err := cache.Get(ctx, "user:"+id, &u); err == nil { return &u, nil }
    u2, err := db.GetUser(ctx, id) // DB scan every time for unknown IDs
    if err != nil { return nil, err }
    cache.Set(ctx, "user:"+id, u2, 5*time.Minute)
    return u2, nil
}

// GOOD: cache the "not found" outcome with a short TTL.
func GetUser(ctx context.Context, id string) (*User, error) {
    raw, err := cache.GetRaw(ctx, "user:"+id)
    if err == nil {
        if IsNegative(raw) { return nil, ErrNotFound }
        var u User; json.Unmarshal(raw, &u); return &u, nil
    }
    u, err := db.GetUser(ctx, id)
    if errors.Is(err, ErrNotFound) {
        cache.SetNegative(ctx, "user:"+id, 60*time.Second)
        return nil, ErrNotFound
    }
    if err != nil { return nil, err }
    cache.Set(ctx, "user:"+id, u, 5*time.Minute)
    return u, nil
}
```

### 7. Not Considering Cache Size

Unbounded caching of user-generated queries creates a memory amplification problem: one million unique search strings multiplied by even modest result sizes quickly exhausts Redis memory, triggering aggressive eviction that reduces hit rates below the break-even point. Normalizing the query before building the cache key deduplicates permutations (e.g., case and whitespace variants), and capping the cached slice to the top 20 results bounds per-entry storage while still serving the most-viewed page of results at cache speed.

```go
// BAD: caching unlimited search results
func Search(ctx context.Context, query string) ([]Product, error) {
    cacheKey := "search:" + query
    // 1M unique queries × average 10KB results = 10GB cached
    // Redis runs OOM → eviction thrashing → worse hit rate than no cache

    var results []Product
    if err := cache.Get(ctx, cacheKey, &results); err == nil {
        return results, nil
    }
    // ...
}

// GOOD: only cache popular/repeated queries, limit size
func Search(ctx context.Context, query string) ([]Product, error) {
    // Only cache normalized, common queries
    normalized := normalizeQuery(query)
    cacheKey := "search:" + normalized

    // Limit result set size in cache
    var results []Product
    if err := cache.Get(ctx, cacheKey, &results); err == nil {
        return results, nil
    }

    fullResults, err := db.Search(ctx, query)
    if err != nil {
        return nil, err
    }

    // Cache only top 20 results with short TTL
    if len(fullResults) > 20 {
        cache.Set(ctx, cacheKey, fullResults[:20], 60*time.Second)
    }
    return fullResults, nil
}
```

### Junior to FAANG: The "Why Did This Fail" Reflex

Every mistake above is a past outage someone wrote a postmortem for. Develop the reflex to ask "what class of mistake is this?" when you hit a cache-related incident. The taxonomy is short enough to memorize. Race on fill (solve with singleflight). Hard coupling to cache availability (solve with fallthrough plus circuit breaker). Stale mutable aggregate (solve with short TTL or event-driven update). Cache as source of truth (solve by writing to durable store first). Synchronized TTL (solve with jitter). No negative cache (solve with short-lived sentinel). Unbounded key space (solve with normalization plus size cap).

Worked example. Production alert at 2 a.m.: database CPU at 100 percent. Junior reflex: restart the database. Correct reflex: look at the cache hit rate for the namespace whose backing table is hot. If hit rate dropped, look at miss reason. If `expired` spiked, the mistake is synchronized TTL. Add jitter and write a postmortem. If `absent` spiked on known-bad IDs, the mistake is missing negative cache. Add sentinels and a rate limiter at the edge. If `evicted` spiked, the mistake is unbounded key space. Cap or normalize.

Second worked example. Users report intermittent stale prices. Junior reflex: clear the cache. Correct reflex: identify the mutation path. If the code writes to DB and then sets the cache, there is a race where another reader fills the cache between the DB write and the cache set, and the old value wins. Fix: invalidate after DB write, do not re-set. Pattern: "write to DB, delete from cache, let next read repopulate." Memorize this.

First-job context. In code review, scan every new cache call for these seven mistakes. When you see `cache.Set(ctx, key, v, fixedTTL)` with no jitter, leave a comment with the Airbnb reference. When you see `cache.Set` on the write path of a mutable aggregate, leave a comment about short TTL or event-driven update. This is how juniors earn trust on cache-heavy teams.

Interview entry point. "Tell me about a cache bug you debugged." Pick one from this list, narrate the symptom, the diagnostic steps, the fix, and the test you added to prevent regression. The test matters. Bar-raisers score candidates on whether they wrote a test or just shipped the fix.

### Senior at FAANG: Governing Mistakes Through Linters and Reviews

At staff level, you do not debug the same mistake twice. You encode it in a linter, a code-review checklist, or a platform guardrail so it cannot ship again. Below is how a principal engineer operationalizes the mistake taxonomy.

Linters and static analysis. Write or adopt custom linters that flag: cache `Set` without jitter on the TTL (banned unless annotated with `//nolint:cachejitter` and a justification), cache errors swallowed without fallthrough, cache as the only persistence for a value (detect by data-flow from HTTP handler to cache without passing through the DB layer), hardcoded TTLs greater than 1 hour (require an ADR). These linters run in CI and block PRs. They are cheaper than postmortems.

Platform guardrails. The shared cache platform rejects: writes to keys without a registered namespace, values larger than 1 MB (big-key protection), namespaces without a declared TTL policy, namespaces with declared key cardinality lower than observed cardinality (detect unbounded key space). The platform emits structured errors with a link to the fix. Teams cannot bypass by filing a ticket. They must submit an ADR.

ADR: when to violate each rule. There are cases where these rules do not fit. A session cache where the session token is keyed by a hash over an unbounded input needs a different size cap strategy. A feature flag cache where staleness is acceptable for 5 minutes has a longer TTL than the guideline. Record the violation in an ADR so the next engineer does not revert the fix accidentally. The ADR is the memory of the team.

Sync write-behind failure pattern. Write-behind (write to cache, async write to DB) is a pattern that looks fast and is always wrong unless the system is explicitly tolerant of data loss on cache-node failure. Staff engineers refuse write-behind proposals unless the author produces an explicit loss-budget ADR. The typical resolution is "we do not need write-behind, we need pipelined async writes to the DB with back-pressure." The performance difference is negligible and the correctness guarantee is dramatically different.

Negative cache poisoning. A negative cache that is too long becomes a bug of its own: a user signs up, the negative cache still says "no such user" for 60 seconds, and the first post-signup request fails. The fix is either shorter TTL or explicit invalidation on signup. Staff engineers scan every negative-cache implementation for a paired invalidation on the creation path. Without that invalidation, the negative cache is a race condition factory.

Hot key remediation playbook. When a hot key is detected (one key over 10 percent of namespace traffic), the mitigation ladder is: add L1 in-process cache (ristretto) to absorb reads, replicate the key across shards (consistent hashing with N replicas), or partition the key into subkeys (e.g., `counter:{id}:shard:0..15`) with client-side aggregation. Each rung has a cost. L1 adds memory and staleness. Replication adds write amplification. Partitioning adds client complexity. Staff engineers pick the rung that matches the read-write ratio.

Maturity model for mistake governance. L1: mistakes happen and are debugged in production. L2: mistakes are documented in team wikis. L3: mistakes are encoded in code-review checklists. L4: mistakes are encoded in linters and platform guardrails that block the PR or the deploy. L5: mistakes are encoded in automated remediation that detects the anti-pattern in production and rolls back or routes around it. Most FAANG teams are at L3 or L4. L5 is rare and expensive.

Bar-raiser signal. When a candidate says "we added a cache to speed up this endpoint," follow up with "how did you prevent stampede on cold start, TTL synchronization, and unbounded key growth?" If they cannot list those three failure modes off the top of their head, they are not yet ready for staff work on a cache-heavy system.

---
