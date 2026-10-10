## Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Cache Stampede

Cache stampede, also called thundering herd, happens when a popular cached key expires and hundreds of concurrent requests all miss the cache simultaneously, each independently querying the database before any of them can repopulate the cache. The result is a sudden spike in database load that can overwhelm the primary store. The correct solution is to use `singleflight` to collapse all concurrent misses for the same key into a single database query, sharing the result with all waiting goroutines.

```go
// BAD: All requests hit database on cache miss
func (c *BadCache) Get(ctx context.Context, key string) ([]byte, error) {
    value, err := c.cache.Get(ctx, key)
    if err == nil {
        return value, nil
    }

    // Cache miss - everyone hits database!
    value, err = c.database.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    c.cache.Set(ctx, key, value, time.Hour)
    return value, nil
}

// GOOD: Single-flight pattern prevents stampede
type GoodCache struct {
    cache    CacheClient
    database DatabaseClient
    group    singleflight.Group
}

func (c *GoodCache) Get(ctx context.Context, key string) ([]byte, error) {
    value, err := c.cache.Get(ctx, key)
    if err == nil {
        return value, nil
    }

    // Use singleflight to coalesce concurrent requests
    result, err, _ := c.group.Do(key, func() (any, error) {
        // Only one goroutine executes this
        value, err := c.database.Get(ctx, key)
        if err != nil {
            return nil, err
        }

        c.cache.Set(ctx, key, value, time.Hour)
        return value, nil
    })

    if err != nil {
        return nil, err
    }
    return result.([]byte), nil
}
```

### Mistake 2: Inconsistent Cache Invalidation

The naive pattern of updating the database then deleting the cache has a race condition: between the write and the delete, another goroutine can read the old value from the database (during a replica lag window) and repopulate the cache with stale data. The "delete before write, delete again after write" double-delete pattern closes this window, the delayed second delete catches any stale value that was cached during the write itself.

```go
// BAD: Update database then delete cache (race condition)
func (s *BadService) UpdateUser(ctx context.Context, user *User) error {
    if err := s.db.Update(ctx, user); err != nil {
        return err
    }

    // Race: Another request might read stale data and cache it
    // between db.Update and cache.Delete
    return s.cache.Delete(ctx, userKey(user.ID))
}

// GOOD: Delete cache first, then update database
type GoodService struct {
    db    Database
    cache Cache
}

func (s *GoodService) UpdateUser(ctx context.Context, user *User) error {
    key := userKey(user.ID)

    // Delete from cache first
    s.cache.Delete(ctx, key)

    // Update database
    if err := s.db.Update(ctx, user); err != nil {
        return err
    }

    // Delete again (double-delete pattern)
    // Handles race where stale read happened during update
    time.AfterFunc(500*time.Millisecond, func() {
        s.cache.Delete(context.Background(), key)
    })

    return nil
}
```

### Mistake 3: Using Cache as Primary Data Store

Treating the cache as the sole storage layer for critical data is dangerous because caches are designed for volatile, evictable storage, a node restart, eviction under memory pressure, or a network partition can cause data loss with no recovery path. The database must remain the authoritative source of truth, and cache writes should be treated as best-effort optimizations. The corrected pattern always persists to the database first, then populates the cache, and falls back transparently to the database on any cache miss.

```go
// BAD: Relying on cache for data persistence
func (s *BadService) SaveSession(ctx context.Context, session *Session) error {
    // Only saving to cache - data loss on cache failure!
    return s.cache.Set(ctx, sessionKey(session.ID), session, 24*time.Hour)
}

// GOOD: Cache is supplementary, database is authoritative
type GoodService struct {
    db    Database
    cache Cache
}

func (s *GoodService) SaveSession(ctx context.Context, session *Session) error {
    // Database is the source of truth
    if err := s.db.SaveSession(ctx, session); err != nil {
        return err
    }

    // Cache for performance (failures are acceptable)
    _ = s.cache.Set(ctx, sessionKey(session.ID), session, 24*time.Hour)

    return nil
}

func (s *GoodService) GetSession(ctx context.Context, id string) (*Session, error) {
    key := sessionKey(id)

    // Try cache first
    if cached, err := s.cache.Get(ctx, key); err == nil {
        return cached.(*Session), nil
    }

    // Fall back to database (source of truth)
    session, err := s.db.GetSession(ctx, id)
    if err != nil {
        return nil, err
    }

    // Populate cache
    s.cache.Set(ctx, key, session, 24*time.Hour)

    return session, nil
}
```

### Mistake 4: Ignoring Cache Key Design

Poorly designed keys lead to namespace collisions between different entity types, accidental cache sharing across environments, and keys that silently become stale when mutable fields like email or name are embedded in them. A well-structured key includes an application prefix, a schema version, and only immutable identifiers, making keys safe to rename during migrations by bumping the version rather than hunting down every call site. The fluent `KeyBuilder` pattern shown below centralizes key construction so that format changes are made in one place and all callers remain consistent.

```go
// BAD: Poor key design causes collisions and inefficiency
func badKey(userID int) string {
    return fmt.Sprintf("%d", userID) // Too short, no namespace
}

func anotherBadKey(user *User) string {
    // Includes mutable data - key changes on updates!
    return fmt.Sprintf("user:%d:%s:%s", user.ID, user.Name, user.Email)
}

// GOOD: Consistent, namespaced, versioned keys
const (
    keyVersion = "v1"
    keyPrefix  = "myapp"
)

func userKey(userID int64) string {
    return fmt.Sprintf("%s:%s:user:%d", keyPrefix, keyVersion, userID)
}

func userProfileKey(userID int64) string {
    return fmt.Sprintf("%s:%s:user:%d:profile", keyPrefix, keyVersion, userID)
}

func userSessionsKey(userID int64) string {
    return fmt.Sprintf("%s:%s:user:%d:sessions", keyPrefix, keyVersion, userID)
}

// Key builder for complex keys
type KeyBuilder struct {
    parts []string
}

func NewKeyBuilder() *KeyBuilder {
    return &KeyBuilder{
        parts: []string{keyPrefix, keyVersion},
    }
}

func (b *KeyBuilder) Entity(entity string) *KeyBuilder {
    b.parts = append(b.parts, entity)
    return b
}

func (b *KeyBuilder) ID(id any) *KeyBuilder {
    b.parts = append(b.parts, fmt.Sprintf("%v", id))
    return b
}

func (b *KeyBuilder) Build() string {
    return strings.Join(b.parts, ":")
}
```

### Mistake 5: Not Setting Appropriate TTLs

Setting no TTL causes the cache to grow unboundedly and serve permanently stale data, while applying the same blanket TTL to every data type means either fast-changing values like inventory levels are served stale, or slow-changing values like product catalogs are evicted too aggressively and the database is over-queried. Each data type should have a TTL calibrated to its expected change rate, and a small random jitter should be added to prevent a cluster of co-expiring keys from triggering a thundering-herd stampede at the same instant.

```go
// BAD: Same TTL for everything or no TTL at all
func (c *BadCache) Set(key string, value []byte) {
    c.client.Set(ctx, key, value, 0) // No expiration!
}

func (c *BadCache) SetWithDefaultTTL(key string, value []byte) {
    c.client.Set(ctx, key, value, 24*time.Hour) // Same TTL for all data types
}

// GOOD: TTL based on data characteristics
type TTLConfig struct {
    UserProfile    time.Duration
    UserSession    time.Duration
    ProductCatalog time.Duration
    Inventory      time.Duration
    SearchResults  time.Duration
}

var DefaultTTLs = TTLConfig{
    UserProfile:    time.Hour,          // Changes infrequently
    UserSession:    30 * time.Minute,   // Active session duration
    ProductCatalog: 24 * time.Hour,     // Daily updates
    Inventory:      30 * time.Second,   // Changes frequently
    SearchResults:  5 * time.Minute,    // Fresh results important
}

type GoodCache struct {
    client *redis.Client
    ttls   TTLConfig
}

func (c *GoodCache) SetUserProfile(ctx context.Context, userID int64, profile *UserProfile) error {
    key := userProfileKey(userID)
    data, _ := json.Marshal(profile)

    // Add jitter to prevent thundering herd on expiration
    jitter := time.Duration(rand.IntN(300)) * time.Second
    ttl := c.ttls.UserProfile + jitter

    return c.client.Set(ctx, key, data, ttl).Err()
}

func (c *GoodCache) SetInventory(ctx context.Context, productID string, qty int) error {
    key := inventoryKey(productID)

    // Short TTL for frequently changing data
    return c.client.Set(ctx, key, qty, c.ttls.Inventory).Err()
}
```

### Junior -> FAANG: Mistakes That Show Up in Every Caching Interview

The five mistakes in this file are not academic edge cases. They are the exact failures that FAANG interviewers probe because they show up repeatedly in production systems built by engineers who understood caching conceptually but not operationally.

Cache stampede is the most commonly missed problem. Junior candidates often say "just retry on miss" without recognizing that 1,000 goroutines all retrying on the same missed key is the stampede. The `singleflight` pattern is the correct answer, and you should be able to write it from memory in an interview: `group.Do(key, func() ...)`. If you cannot recall `singleflight`, the next best answer is a per-key mutex with a "fetch in progress" flag.

Cache invalidation races are the second most common gap. The naive "update database then delete cache" sequence has a window where a reader can fetch old data and cache it after the delete. The double-delete pattern (delete before write, delete again after a short delay) is the standard mitigation. Practice explaining this race condition on a whiteboard: draw the timeline with two concurrent requests and show exactly where the stale value gets cached.

Key design is where many first-job engineers cut corners and pay later. The habit to build: every cache key must include an application prefix, a schema version, and only immutable identifiers. When you include mutable data (username, email) in a key, updates to that data silently orphan the old cache entry, which grows unboundedly until eviction. Use only the primary key (immutable UUID or integer ID) in cache keys.

TTL design is the last gap. Saying "I'll set a 1-hour TTL" in an interview without explaining how you chose that value is a weak answer. The strong answer: "I would measure the update frequency for each data type, set the TTL to roughly half the expected interval between updates, and add 10-20% random jitter to prevent co-expiration."

### Senior @ FAANG: Root Cause Thinking for Cache Failures

Senior engineers do not just know the correct patterns. They can diagnose which mistake caused an incident from indirect signals, and they design systems that make mistakes detectable before they cause user impact.

**ADR: When to choose singleflight vs mutex vs probabilistic early expiration**

The three stampede mitigations have different tradeoffs. `singleflight` collapses concurrent misses to one fetch but blocks all waiters on the single fetch latency: if the fetch takes 500ms, all 1,000 goroutines wait 500ms. A mutex per key has the same blocking behavior. Probabilistic early expiration (XFetch algorithm) pre-emptively refreshes the cache before expiry with a probability that increases as the key ages: some requests pay a slightly early refresh cost, but no request ever blocks waiting for another. The ADR choice depends on fetch latency and concurrency: for cheap fetches (under 50ms), singleflight is correct. For expensive fetches (over 500ms) with very high concurrency, probabilistic early expiration is better because it spreads the refresh cost across time rather than blocking everyone at the expiry instant.

**Cache invalidation at the platform level: why application-level invalidation does not scale**

Each of the five mistakes above involves application code making decisions about cache state. At FAANG, this scales poorly because it requires every team to implement invalidation correctly. The platform approach is change data capture (CDC): the database emits a change stream (Debezium on MySQL, logical replication on Postgres), and the cache platform consumes that stream and invalidates affected keys automatically. Application teams write to the database, and the platform handles cache consistency. This ADR eliminates the update-then-delete race condition entirely, because invalidation is triggered by the committed database state rather than application code.

**Key namespace governance for multi-tenant caches**

At FAANG, multiple services share Redis clusters for cost efficiency. Without namespace governance, teams use conflicting key prefixes, deploy schema changes that break other teams' deserialization, and exhaust the key space with orphaned keys. A staff engineer proposes a key registry: a service that owns the mapping of `{application}:{version}:{entity}:{id}` key patterns, enforces uniqueness at registration time, and provides a deprecation workflow for old key schemas. Without this registry, the "ignore old key design" technical debt compounds until a migration is required, and migrations across a shared cache cluster affect all tenants simultaneously.

**The double-delete pattern's hidden failure mode**

The `time.AfterFunc(500ms, ...)` second delete has a subtle production failure mode: if the service crashes after the first delete but before the second, the stale value is never purged. The correct production implementation registers the deferred delete as a job in a durable queue (Redis itself with a `ZADD` scored by execution time, or a separate task queue) rather than an in-process timer. The in-process timer is correct for development environments but not for services that restart during deployments.

---
