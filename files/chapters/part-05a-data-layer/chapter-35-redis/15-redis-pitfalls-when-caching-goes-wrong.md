## Redis Pitfalls: When Caching Goes Wrong

### The Cache Stampede Disaster

**The Incident**: A popular e-commerce site cached product data with 1-hour expiration. At 3 AM when the cache expired, 50,000 users were browsing the homepage. All 50,000 requests simultaneously hit the database for the same product list. The database collapsed under load, the site went down, and it took 45 minutes to recover. A single cache expiration caused a complete outage.

```go
// WRONG: No stampede protection
func getProducts(ctx context.Context, rdb *redis.Client, db *sql.DB) ([]Product, error) {
    cached, err := rdb.Get(ctx, "products:featured").Bytes()
    if err == nil {
        var products []Product
        json.Unmarshal(cached, &products)
        return products, nil
    }

    // Cache miss - everyone hits the database!
    products, err := loadProductsFromDB(ctx, db)
    if err != nil {
        return nil, err
    }

    // Cache for next time
    data, _ := json.Marshal(products)
    rdb.Set(ctx, "products:featured", data, time.Hour)
    return products, nil
}

// CORRECT: Single-flight pattern prevents stampede
type CacheLoader struct {
    rdb    *redis.Client
    db     *sql.DB
    group  singleflight.Group
}

func (c *CacheLoader) GetProducts(ctx context.Context) ([]Product, error) {
    key := "products:featured"

    // Check cache first
    cached, err := c.rdb.Get(ctx, key).Bytes()
    if err == nil {
        var products []Product
        json.Unmarshal(cached, &products)
        return products, nil
    }

    // Single-flight: only one request loads from DB
    result, err, _ := c.group.Do(key, func() (any, error) {
        // Double-check cache (another request may have populated it)
        cached, err := c.rdb.Get(ctx, key).Bytes()
        if err == nil {
            var products []Product
            json.Unmarshal(cached, &products)
            return products, nil
        }

        // Load from database
        products, err := loadProductsFromDB(ctx, c.db)
        if err != nil {
            return nil, err
        }

        // Cache with jitter to prevent synchronized expiration
        ttl := time.Hour + time.Duration(rand.IntN(300))*time.Second
        data, _ := json.Marshal(products)
        c.rdb.Set(ctx, key, data, ttl)

        return products, nil
    })

    if err != nil {
        return nil, err
    }
    return result.([]Product), nil
}

// Even better: Proactive refresh before expiration
func (c *CacheLoader) startBackgroundRefresh(ctx context.Context) {
    ticker := time.NewTicker(45 * time.Minute) // Refresh before expiry
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            products, err := loadProductsFromDB(ctx, c.db)
            if err != nil {
                log.Printf("background refresh failed: %v", err)
                continue
            }
            data, _ := json.Marshal(products)
            c.rdb.Set(ctx, "products:featured", data, time.Hour)
        }
    }
}
```

### The Redis Memory Explosion

**The Incident**: A session store in Redis worked fine for months. Then marketing launched a viral campaign. User sessions grew from 100,000 to 10 million in a day. Each session was 50KB of user preferences and cart data. Redis ran out of memory, started evicting random keys (including active sessions), and users were randomly logged out mid-checkout. The business lost $2M in abandoned carts.

```go
type CartItem struct {
    ProductID  string
    Quantity   int
    PriceCents int64
}

// WRONG: Storing large objects in Redis
type Session struct {
    UserID          int64
    Cart            []CartItem       // Could be huge
    Preferences     map[string]any   // Unbounded
    BrowsingHistory []Product        // Keeps growing
}

func saveSession(ctx context.Context, rdb *redis.Client, session *Session) error {
    data, _ := json.Marshal(session)
    return rdb.Set(ctx, "session:"+session.UserID, data, 24*time.Hour).Err()
}

// CORRECT: Store minimal data in Redis, large data in DB
type SessionRef struct {
    UserID    int64  `json:"user_id"`
    Token     string `json:"token"`
    ExpiresAt int64  `json:"expires_at"`
}

func saveSession(ctx context.Context, rdb *redis.Client, db *sql.DB, session *Session) error {
    // Store minimal session reference in Redis
    ref := SessionRef{
        UserID:    session.UserID,
        Token:     session.Token,
        ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
    }
    data, _ := json.Marshal(ref)
    if err := rdb.Set(ctx, "session:"+session.Token, data, 24*time.Hour).Err(); err != nil {
        return err
    }

    // Store large data in database
    return saveSessionDataToDB(ctx, db, session)
}

// Better: Use Redis data structures efficiently
func saveCart(ctx context.Context, rdb *redis.Client, userID int64, items []CartItem) error {
    key := fmt.Sprintf("cart:%d", userID)
    pipe := rdb.Pipeline()

    // Clear old cart
    pipe.Del(ctx, key)

    // Store each item as hash field
    for _, item := range items {
        pipe.HSet(ctx, key, item.ProductID,
            fmt.Sprintf("%d|%d", item.Quantity, item.PriceCents))
    }

    // Set expiration
    pipe.Expire(ctx, key, 7*24*time.Hour)

    _, err := pipe.Exec(ctx)
    return err
}

// Monitor memory usage
func checkRedisMemory(ctx context.Context, rdb *redis.Client) error {
    info, err := rdb.Info(ctx, "memory").Result()
    if err != nil {
        return err
    }

    // Parse used_memory from info string
    usedMemory := parseUsedMemory(info)
    maxMemory := parseMaxMemory(info)

    if float64(usedMemory)/float64(maxMemory) > 0.8 {
        alertOps("Redis memory > 80%", usedMemory, maxMemory)
    }

    return nil
}
```

### The Distributed Lock That Wasn't

**The Incident**: A payment processing system used Redis locks to prevent double-processing. The implementation used `SETNX` with a TTL. It worked until a GC pause caused a process to hold the lock past its TTL. The lock expired, another instance acquired it, and both processed the same payment. The customer was charged twice, and the reconciliation team spent weeks fixing the mess.

```go
// WRONG: Naive Redis lock implementation
func processPaymentBad(ctx context.Context, rdb *redis.Client, paymentID string) error {
    lockKey := "lock:payment:" + paymentID

    // Acquire lock
    acquired, _ := rdb.SetNX(ctx, lockKey, "1", 30*time.Second).Result()
    if !acquired {
        return errors.New("payment already being processed")
    }
    defer rdb.Del(ctx, lockKey) // Always release

    // Long running process - what if this takes > 30s?
    return processPayment(paymentID) // GC pause could exceed TTL!
}

// CORRECT: Fencing token with ownership verification
type RedisLock struct {
    rdb     *redis.Client
    key     string
    token   string
    ttl     time.Duration
    stopCh  chan struct{}
}

func AcquireLock(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (*RedisLock, error) {
    // Generate unique token for this lock holder
    token := uuid.New().String()

    // Try to acquire with Lua script for atomicity
    script := redis.NewScript(`
        if redis.call("exists", KEYS[1]) == 0 then
            redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
            return 1
        end
        return 0
    `)

    acquired, err := script.Run(ctx, rdb, []string{key}, token, ttl.Milliseconds()).Int()
    if err != nil {
        return nil, err
    }
    if acquired == 0 {
        return nil, ErrLockNotAcquired
    }

    lock := &RedisLock{
        rdb:    rdb,
        key:    key,
        token:  token,
        ttl:    ttl,
        stopCh: make(chan struct{}),
    }

    // Start renewal goroutine
    go lock.renewPeriodically(ctx)

    return lock, nil
}

func (l *RedisLock) renewPeriodically(ctx context.Context) {
    ticker := time.NewTicker(l.ttl / 3) // Renew at 1/3 TTL
    defer ticker.Stop()

    for {
        select {
        case <-l.stopCh:
            return
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Only renew if we still own the lock
            script := redis.NewScript(`
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    redis.call("pexpire", KEYS[1], ARGV[2])
                    return 1
                end
                return 0
            `)
            renewed, _ := script.Run(ctx, l.rdb, []string{l.key}, l.token, l.ttl.Milliseconds()).Int()
            if renewed == 0 {
                // Lost the lock! Signal to stop processing
                log.Warn("lock renewal failed, may have lost lock")
            }
        }
    }
}

func (l *RedisLock) Release(ctx context.Context) error {
    close(l.stopCh)

    // Only release if we own it
    script := redis.NewScript(`
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        end
        return 0
    `)
    return script.Run(ctx, l.rdb, []string{l.key}, l.token).Err()
}
```

### The Hot Key Meltdown

**The Incident**: A social media platform cached celebrity profile data in Redis. When a major celebrity made a controversial post, millions of users simultaneously requested their profile. All requests hit a single Redis key on a single shard. That Redis node's CPU hit 100%, and the cluster's consistent hashing meant no other nodes could help. The celebrity's profile page was down for 4 hours during peak controversy.

```go
// WRONG: Single key for hot data
func getCelebrityProfile(ctx context.Context, rdb *redis.Client, userID string) (*Profile, error) {
    key := "profile:" + userID // Millions of requests hit this ONE key
    data, err := rdb.Get(ctx, key).Bytes()
    // ...
}

// CORRECT: Shard hot keys across multiple Redis keys
func getCelebrityProfile(ctx context.Context, rdb *redis.Client, userID string) (*Profile, error) {
    // Randomly select from multiple replicated keys
    shardNum := rand.IntN(10)
    key := fmt.Sprintf("profile:%s:shard:%d", userID, shardNum)

    data, err := rdb.Get(ctx, key).Bytes()
    if err == redis.Nil {
        // Fall back to main key
        key = "profile:" + userID
        data, err = rdb.Get(ctx, key).Bytes()
    }
    // ...
}

// When updating, update all shards
func updateCelebrityProfile(ctx context.Context, rdb *redis.Client, userID string, profile *Profile) error {
    data, _ := json.Marshal(profile)
    pipe := rdb.Pipeline()

    // Update main key
    pipe.Set(ctx, "profile:"+userID, data, time.Hour)

    // Update all shards
    for i := 0; i < 10; i++ {
        key := fmt.Sprintf("profile:%s:shard:%d", userID, i)
        pipe.Set(ctx, key, data, time.Hour)
    }

    _, err := pipe.Exec(ctx)
    return err
}

// Even better: Local cache + Redis for extremely hot keys
type HotKeyCache struct {
    rdb    *redis.Client
    local  *lru.Cache
    mu     sync.RWMutex
    hotKeys map[string]bool
}

func (c *HotKeyCache) Get(ctx context.Context, key string) ([]byte, error) {
    // Check local cache first for known hot keys
    c.mu.RLock()
    isHot := c.hotKeys[key]
    c.mu.RUnlock()

    if isHot {
        if data, ok := c.local.Get(key); ok {
            return data.([]byte), nil
        }
    }

    // Fetch from Redis
    data, err := c.rdb.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    // Track access patterns
    go c.trackAccess(key)

    return data, nil
}

func (c *HotKeyCache) trackAccess(key string) {
    // Increment access counter in Redis
    count, _ := c.rdb.Incr(context.Background(), "access:"+key).Result()

    // If accessed > 1000 times/minute, mark as hot
    if count > 1000 {
        c.mu.Lock()
        c.hotKeys[key] = true
        c.mu.Unlock()
    }
}
```

### Quick Reference: Redis Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Cache stampede | DB overload on expiry | Single-flight, background refresh |
| Memory explosion | Evictions, OOM | Store minimal data, monitor usage |
| Lock race conditions | Double processing | Fencing tokens, lock renewal |
| Hot keys | Single node overload | Key sharding, local cache |
| Connection exhaustion | Timeouts, errors | Pool limits, connection reuse |
| Big keys | Slow operations | Split into smaller keys |
| Missing expiration | Memory creep | Always set TTL |
| Lua script complexity | Blocking Redis | Keep scripts simple and fast |

### Junior to FAANG: Pitfalls as Pattern Recognition

Each pitfall in this section has a detection signature. Training your eye to recognize these signatures before they show up in a post-mortem is the single most impactful skill for a junior engineer working with Redis.

Detection signatures:
- Stampede signature: DB p99 spikes by 100x while cache hit rate drops below 50 percent for 30 seconds. If you see those two together, you are in a stampede. The cache is not slow. It is gone.
- Memory explosion signature: evicted_keys in INFO stats is non-zero and growing. If your maxmemory-policy is allkeys-lru or allkeys-lfu, this is normal behavior for a cache. If your maxmemory-policy is volatile-lru and evicted_keys is growing, you have keys without TTL getting selected for eviction, which means your TTL discipline has failed.
- Lock leak signature: duplicate work showing up in application logs. The canonical case is "processed order twice" or "sent email twice" appearing in traces. Any time you see duplicate side effects with a distributed lock in the code path, assume lock leak until proven otherwise.
- Hotkey signature: single shard CPU at 80 percent while other shards sit at 20 percent. If you are running Redis Cluster and one node is much hotter than the others, you have either a bigkey or a hotkey. Run redis-cli --hotkeys against that shard to confirm.

Worked example of debugging a stampede with the signatures. A junior on-call gets paged at 2 AM. They look at the Redis dashboard and see hit rate fine at 99 percent. They see DB errors rising. Junior instinct: "not a Redis problem, escalate to DB team." Senior instinct: look at the previous 10 minutes. Hit rate was 99 percent. Then it dropped to 40 percent for 45 seconds. Then climbed back to 99 percent. That 45-second window is the stampede. By the time you look at the dashboard, the stampede is over but the DB is still catching up. The fix is in the cache layer (single-flight plus jitter), not the DB layer.

First-job context. The most common mistake a junior makes with Redis is treating it as infallible. When a Redis error occurs, the default code path should degrade gracefully to a slower backup (DB query with a bounded concurrency) rather than propagate a 500 error to the user. Every cache function should have three paths: hit (return cached), miss (compute and cache), error (log and fall back to slow path with circuit breaker). Collapsing error into miss is the second most common mistake after discarding errors entirely.

Why did this fail reflex. When a lock fails to prevent double processing, the junior debug asks "why did both workers get the lock." The correct question is "did both workers actually hold the lock simultaneously, or did the first worker's GC pause cause its lock to expire while it was still writing." The answer is almost always the second. The fix is not a better lock. It is a fencing token plus lock renewal plus idempotent writes. Distributed locks do not prevent double work. They reduce the probability of double work. Idempotency is the only correctness guarantee.

Interview entry-point. Pitfalls show up in interviews as "tell me about a time X happened." If you have not lived through a cache stampede, read a published cache-stampede post-mortem and be prepared to describe it as if you were the on-call. An interviewer cares about your reasoning about the failure more than whether the failure happened to you personally. "I have read about a synchronized-TTL stampede outage and the fix was..." is a valid answer if you can explain the fix in detail.

### Senior at FAANG: Pitfall ADRs, Runbooks, and Cost of Recovery

The pitfalls section is the front-line material for a staff engineer writing the runbook library. Each incident type needs a detection threshold, a first-response playbook, a rollback path, and a post-mortem template. Below is the fleet-level view.

Cache stampede runbook. Detection: cache hit rate drops by more than 20 absolute points in less than 60 seconds while backend p99 latency rises more than 2x. First response: engage the circuit breaker that caps concurrent cache-miss lookups per key, forcing all but N requests to serve from last-known-good values or error. Recovery: backfill the cache from a warm snapshot if available, otherwise rely on single-flight to rehydrate. Post-mortem template: was TTL jittered, was single-flight in place, was the key eligible for proactive refresh, did the TTL distribution have a spike at a common value (smoking gun for a batch job writing without jitter). ADR output: update the cache client library to enforce jitter at the write layer if the incident reveals a service-specific bypass.

Memory explosion runbook. Detection: used_memory / maxmemory crosses 75 percent. Alert levels: warn at 75, page at 85, page-sev-1 at 92. First response: identify the top 10 keyspaces by memory usage via `redis-cli --bigkeys` on a replica, identify the top 10 growth rates via sampled MEMORY USAGE over 5 minutes, kill or pause the writer if a specific service is implicated. Recovery: increase maxmemory if the capacity plan allows, otherwise engage aggressive TTL shortening on the identified keyspace. Post-mortem: was the keyspace on a noeviction policy (durable workload) mistakenly mixed with a cache workload, did a library bug write keys without TTL, did a feature flag launch increase key cardinality unexpectedly. ADR output: mandate per-workload Redis deployments when eviction policies diverge.

Lock race runbook. Detection: duplicate side effects detected by the business layer's idempotency auditor (every sensitive operation should have one). First response: disable the affected workflow, audit the last N hours of operations for duplicates, trigger refunds or reversals for affected customers via a reconciliation job. Recovery: fix the lock implementation, redeploy with fencing tokens enabled, replay audit logs to detect any further duplicates. Post-mortem: did the lock use the Lua owner check, was the TTL set longer than the worst-case processing time including GC pauses, was there a fencing token passed through to the protected resource. ADR output: the lock library must enforce fencing tokens and the protected resources must validate them. No exceptions.

Hotkey runbook. Detection: per-shard CPU delta exceeds 40 percent between max and median shard for more than 5 minutes. First response: run redis-cli --hotkeys on the hot shard to identify the top 10 accessed keys. For each hotkey, evaluate: is it a celebrity pattern (mitigate with L1 process-local cache with short TTL and stale-while-revalidate), is it a counter (mitigate with per-shard counter fragments combined at read time), is it a leaderboard (mitigate with range sharding). Recovery: deploy the mitigation, verify CPU rebalances, backfill sharded keys if needed. Post-mortem: was the hotkey predictable from product metadata (celebrity status, trending score) and could proactive sharding have been applied. ADR output: any key tied to an entity with a power-law access pattern requires sharded storage by default.

Bigkey runbook. Detection: SLOWLOG entries above 50 ms with commands on a key larger than 1 MB identified via MEMORY USAGE. First response: do not run DEL on the bigkey (DEL is blocking on bigkeys and can block the event loop for seconds). Use UNLINK which is non-blocking. If the bigkey is actively receiving writes, engage the writer's stop valve. Recovery: rewrite the bigkey as a sharded structure (hash split into multiple hashes by key prefix, list split into time-bucketed lists, set split by hash modulo). Backfill readers to query the new layout with a fanout aggregator. Post-mortem: did the keyspace have a size limit policy, did the writer check size before append, was there a growth rate monitor. ADR output: any collection-type key must have an append-time size check in the library wrapper, with a ceiling set per-keyspace.

Valkey/Redis version migration ADR. Migrating across a major version is not a runbook because it is not an incident. It is a multi-month project. The ADR must include: version compatibility matrix for client libraries in use (go-redis v9 supports Valkey 8 and Redis 8 through the RESP3 protocol), feature parity audit (Valkey 8 does not ship Redis Stack modules upstream, so RediSearch, RedisJSON, RedisBloom, RedisTimeSeries users must plan separate migration paths), performance baseline (run the production traffic replay against both versions for 72 hours and compare p50, p99, p99.9 latency plus memory footprint), cost model (ElastiCache for Valkey is priced approximately 20 percent lower than equivalent Redis deployments as of 2026), rollback path (dual-write and shadow-read for 30 days before cutover, with shadow-read diff tooling catching silent divergences).

Multi-region topology ADR. At L4 and L5 maturity, the Redis deployment spans regions. Three patterns:
- Active-passive with async replication: one region writes, others read. Simpler, lower cost, RPO non-zero (seconds of data loss in a region failover).
- Active-active via Redis Enterprise CRDTs: multi-writer with conflict-free replicated data types. Higher cost, RPO near zero, but CRDT semantics do not match all data types (counters sum, which is often what you want, but LWW-register for strings means concurrent writes lose one).
- Sharded by region with cross-region read-through: each region owns a subset of the key space. Reads route to the owning region, writes go to the owning region. A common fit for region-partitioned idempotency keys (hashed by user region).

Each pattern has an ADR consequence section documenting which operations break. CRDT counters do not support conditional decrement. Cross-region read-through adds 50 to 150 ms to p99. Active-passive loses writes during failover. Choose based on the business tolerance for each failure mode.

Cost of recovery table. The cost of each incident type is not just the outage duration. It is the engineering time to prevent recurrence plus the compliance work for post-incident reviews plus the customer support burden for affected users. Internal estimate at FAANG scale for a sev-1 Redis incident: 40 engineer-hours of response, 80 engineer-hours of post-mortem and remediation, 200 customer support tickets for user-visible incidents, 1 to 4 weeks of calendar time for the full ADR cycle. Multiply that by three recurrences of the same pitfall and you have justified a quarter-long investment in governance tooling. This is why the governance posture (forbidden commands, linters, shared library wrappers) is not optional at scale. It is the cheapest path to fewer incidents.

---
