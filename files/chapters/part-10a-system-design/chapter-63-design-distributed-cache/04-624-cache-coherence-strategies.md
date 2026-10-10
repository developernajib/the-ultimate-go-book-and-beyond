## 63.4 Cache Coherence Strategies

### Write-Through Cache

Write-through caching updates both the cache and the backing store synchronously on every write, ensuring the cache is always consistent with the database at the cost of higher write latency. This strategy eliminates cache misses for recently written data and simplifies failure recovery because the database is always the authoritative source. The trade-off is that every write incurs both a cache update and a database write, making write-through appropriate for read-heavy workloads where the cache hit rate justifies the write overhead.

```go
// coherence/write_through.go
package coherence

import (
    "context"
    "time"
)

// CacheClient defines interface for cache operations
type CacheClient interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

// DatabaseClient defines interface for underlying persistent storage
type DatabaseClient interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte) error
    Delete(ctx context.Context, key string) error
    BatchSet(ctx context.Context, items map[string][]byte) error
    BatchDelete(ctx context.Context, keys []string) error
}

// WriteThroughCache writes to both cache and database
type WriteThroughCache struct {
    cache    CacheClient
    database DatabaseClient
}

// Get retrieves from cache, falls back to database
func (c *WriteThroughCache) Get(ctx context.Context, key string) ([]byte, error) {
    // Try cache first
    value, err := c.cache.Get(ctx, key)
    if err == nil {
        return value, nil
    }

    // Cache miss - read from database
    value, err = c.database.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Populate cache
    c.cache.Set(ctx, key, value, time.Hour)

    return value, nil
}

// Set writes to database first, then cache
func (c *WriteThroughCache) Set(ctx context.Context, key string, value []byte) error {
    // Write to database first
    if err := c.database.Set(ctx, key, value); err != nil {
        return err
    }

    // Then write to cache
    return c.cache.Set(ctx, key, value, time.Hour)
}

// Delete removes from both database and cache
func (c *WriteThroughCache) Delete(ctx context.Context, key string) error {
    // Delete from database first
    if err := c.database.Delete(ctx, key); err != nil {
        return err
    }

    // Then delete from cache
    return c.cache.Delete(ctx, key)
}
```

### Write-Behind (Write-Back) Cache

Write-behind caching reduces write latency by acknowledging the write to the caller as soon as the cache is updated, then asynchronously flushing dirty data to the database in batches. This is valuable for workloads with high write throughput, such as view counters or session data, where the overhead of a synchronous database round trip on every write would be prohibitive. The `batchWriter` goroutine accumulates operations in a slice and flushes either when the batch reaches `batchSize` or when the `flushInterval` ticker fires, whichever comes first. The full-queue fallback ensures no writes are silently dropped if the channel backs up.

```go
// coherence/write_behind.go
package coherence

import (
    "context"
    "sync"
    "time"
)

// WriteBehindCache batches writes to the database
type WriteBehindCache struct {
    cache      CacheClient
    database   DatabaseClient
    writeQueue chan writeOp
    batchSize  int
    flushInterval time.Duration
    wg         sync.WaitGroup
    quit       chan struct{}
}

type writeOp struct {
    key   string
    value []byte
    op    string // "set" or "delete"
}

// NewWriteBehindCache creates a write-behind cache
func NewWriteBehindCache(cache CacheClient, db DatabaseClient, batchSize int, flushInterval time.Duration) *WriteBehindCache {
    wbc := &WriteBehindCache{
        cache:         cache,
        database:      db,
        writeQueue:    make(chan writeOp, 10000),
        batchSize:     batchSize,
        flushInterval: flushInterval,
        quit:          make(chan struct{}),
    }

    wbc.wg.Add(1)
    go wbc.batchWriter()

    return wbc
}

// Set writes to cache immediately, queues database write
func (c *WriteBehindCache) Set(ctx context.Context, key string, value []byte) error {
    // Write to cache immediately
    if err := c.cache.Set(ctx, key, value, time.Hour); err != nil {
        return err
    }

    // Queue database write
    select {
    case c.writeQueue <- writeOp{key: key, value: value, op: "set"}:
    default:
        // Queue full - flush synchronously
        c.database.Set(ctx, key, value)
    }

    return nil
}

func (c *WriteBehindCache) batchWriter() {
    defer c.wg.Done()

    batch := make([]writeOp, 0, c.batchSize)
    ticker := time.NewTicker(c.flushInterval)
    defer ticker.Stop()

    for {
        select {
        case op := <-c.writeQueue:
            batch = append(batch, op)
            if len(batch) >= c.batchSize {
                c.flushBatch(batch)
                batch = batch[:0]
            }

        case <-ticker.C:
            if len(batch) > 0 {
                c.flushBatch(batch)
                batch = batch[:0]
            }

        case <-c.quit:
            // Drain the queue before the final flush. Flushing only
            // the in-memory batch would silently drop every write
            // still sitting in the channel.
            for {
                select {
                case op := <-c.writeQueue:
                    batch = append(batch, op)
                default:
                    c.flushBatch(batch)
                    return
                }
            }
        }
    }
}

func (c *WriteBehindCache) flushBatch(batch []writeOp) {
    ctx := context.Background()

    // Group by operation type
    sets := make(map[string][]byte)
    deletes := make([]string, 0)

    for _, op := range batch {
        switch op.op {
        case "set":
            sets[op.key] = op.value
        case "delete":
            deletes = append(deletes, op.key)
        }
    }

    // Batch write
    if len(sets) > 0 {
        c.database.BatchSet(ctx, sets)
    }
    if len(deletes) > 0 {
        c.database.BatchDelete(ctx, deletes)
    }
}

// Close stops the write-behind process
func (c *WriteBehindCache) Close() {
    close(c.quit)
    c.wg.Wait()
}
```

### Cache Invalidation

When multiple service instances each maintain their own local cache, a write on one node leaves stale data in every other node's cache until TTL expiry, a coherence window that can be minutes long. The `InvalidationManager` solves this by publishing an `InvalidationEvent` to a Redis Pub/Sub channel when data changes. Every subscribed instance receives the event and immediately deletes the affected keys from its local cache, collapsing the coherence window to the Pub/Sub delivery latency (typically under 1ms on a local network). Pattern-based invalidation handles bulk scenarios such as invalidating all cache entries for a specific user or resource group without requiring the publisher to enumerate every key individually.

```go
// coherence/invalidation.go
package coherence

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
)

// InvalidationEvent represents a cache invalidation event
type InvalidationEvent struct {
    Keys      []string  `json:"keys"`
    Pattern   string    `json:"pattern,omitempty"`
    Timestamp time.Time `json:"timestamp"`
    Source    string    `json:"source"`
}

// InvalidationManager handles cache invalidation
type InvalidationManager struct {
    pubsub  *redis.PubSub
    cache   CacheClient
    channel string
}

// NewInvalidationManager creates an invalidation manager
func NewInvalidationManager(rdb *redis.Client, cache CacheClient, channel string) *InvalidationManager {
    im := &InvalidationManager{
        pubsub:  rdb.Subscribe(context.Background(), channel),
        cache:   cache,
        channel: channel,
    }

    go im.listen()

    return im
}

// Invalidate broadcasts an invalidation event
func (m *InvalidationManager) Invalidate(ctx context.Context, rdb *redis.Client, keys ...string) error {
    event := InvalidationEvent{
        Keys:      keys,
        Timestamp: time.Now(),
        Source:    "api",
    }

    data, err := json.Marshal(event)
    if err != nil {
        return err
    }

    return rdb.Publish(ctx, m.channel, data).Err()
}

// InvalidatePattern invalidates keys matching a pattern
func (m *InvalidationManager) InvalidatePattern(ctx context.Context, rdb *redis.Client, pattern string) error {
    event := InvalidationEvent{
        Pattern:   pattern,
        Timestamp: time.Now(),
        Source:    "api",
    }

    data, err := json.Marshal(event)
    if err != nil {
        return err
    }

    return rdb.Publish(ctx, m.channel, data).Err()
}

func (m *InvalidationManager) listen() {
    ch := m.pubsub.Channel()

    for msg := range ch {
        var event InvalidationEvent
        if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
            continue
        }

        ctx := context.Background()

        // Invalidate specific keys
        for _, key := range event.Keys {
            m.cache.Delete(ctx, key)
        }

        // Invalidate by pattern (more expensive)
        if event.Pattern != "" {
            m.invalidateByPattern(ctx, event.Pattern)
        }
    }
}

func (m *InvalidationManager) invalidateByPattern(ctx context.Context, pattern string) {
    // Implementation depends on cache type
    // For local cache, iterate and match
    // For Redis, use SCAN
}

// Close closes the invalidation manager
func (m *InvalidationManager) Close() error {
    return m.pubsub.Close()
}
```

### Junior -> FAANG: Choosing the Right Coherence Strategy

These three strategies are the canonical cache coherence patterns, and FAANG interviewers expect you to know when to choose each one.

Write-through: choose when reads are much more frequent than writes, and when you need strong consistency (every read sees the latest write). The cost is that every write pays a database round trip. This is the right choice for user profile data, product catalog, and other workloads where reads outnumber writes 10:1 or more.

Write-behind: choose when writes are frequent and some data loss on crash is acceptable. The classic use case is view counters and session activity tracking: if the process crashes, you lose the last second of view counts, which is acceptable. The dangerous mistake is using write-behind for data that must not be lost (orders, payments, user-generated content). Know this constraint and state it unprompted.

Cache-aside (not implemented explicitly above but implied by `WriteThroughCache.Get`): the application reads from cache, falls back to database on miss, and populates the cache. Writes go directly to the database and invalidate the cache. This is the most common pattern in practice because it is the simplest to reason about: the database is always authoritative, and the cache is a read optimization.

The `InvalidationManager` using Redis Pub/Sub is the mechanism for propagating cache invalidations across multiple application instances. Understand the limitation: Redis Pub/Sub is fire-and-forget. If a subscriber is disconnected when the invalidation is published, it misses the event and continues serving stale data until its TTL expires. The mitigation is short TTLs (so the maximum staleness window is bounded) plus event-driven invalidation (so normal invalidation is fast).

### Senior @ FAANG: Cache Coherence as a Consistency Model Decision

**Each coherence strategy maps to a consistency level in the CAP theorem**

Write-through provides read-after-write consistency within the same process (reads after a write see the new value) but not across processes (another process that had the key cached before the write will still see the old value until its TTL expires or it receives an invalidation). Write-behind provides eventual consistency for writes: the write is acknowledged to the caller before the database is updated, so another process reading from the database immediately after the write may see the old value. The invalidation-based approach provides eventual consistency across instances with a propagation delay bounded by the Pub/Sub delivery latency.

A senior candidate is explicit about which consistency model each strategy provides, not just "it's consistent" or "it might be stale." The vocabulary of distributed systems consistency (strong, sequential, causal, eventual, read-your-writes) is the prerequisite for this conversation.

**The double-delete pattern for cache-aside**

The `WriteThroughCache.Set` pattern (write to database, then set in cache) has a race condition with cache-aside: a reader can read the old value from the database between the write and the cache update, and cache that stale value. The double-delete pattern (delete cache, write database, delete cache again after a delay) closes this window. The delayed second delete is the key: it removes any stale value that a concurrent reader may have cached during the write. The delay must be longer than the database replication lag plus the maximum query execution time to be effective.

**CDC as a coherence mechanism**

Change Data Capture (CDC) using Debezium or Maxwell is an alternative to application-level invalidation. Instead of having the application publish invalidation events, the database's replication log is tailed, and invalidation events are derived from the database changes directly. This approach ensures that every write to the database (including direct SQL queries not going through the application layer) triggers an invalidation. The trade-off is operational complexity (running a CDC pipeline) and additional latency (CDC adds 100-500ms of propagation delay vs the near-zero latency of synchronous invalidation). For systems where the database is written from multiple sources (migrations, admin tools, other services), CDC is the more reliable coherence mechanism.

**Invalidation scope design**

The `InvalidatePattern` method (invalidating all keys matching a pattern) is a practical tool for bulk invalidation (e.g., all cached data for a user when the user's profile changes). But in Redis Cluster, patterns span multiple hash slots, and `SCAN` over a pattern must be issued to every node. At scale, pattern-based invalidation can be expensive. The production alternative is key tagging: store all keys associated with a user under a tagged namespace (`user:{userID}:*`), and use Redis Cluster's hash tags to ensure all keys for a user are on the same slot. Then invalidate by slot scan rather than global pattern scan.

---
