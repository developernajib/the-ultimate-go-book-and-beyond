## 52I.8 Event-Driven Data Sync Patterns

### CDC-Driven Cache Invalidation

CDC-driven cache invalidation provides a reliable, low-latency alternative to TTL-based expiration: the cache is updated or evicted precisely when the underlying data changes, without polling. The following implementation subscribes to a Debezium topic for a given table and invalidates or refreshes the corresponding Redis cache entries on each change event.

```go
package sync

import (
    "context"
    "fmt"
    "log/slog"

    "github.com/redis/go-redis/v9"
)

// CacheInvalidator invalidates Redis cache entries on DB changes
type CacheInvalidator struct {
    redis  *redis.Client
    logger *slog.Logger
}

func (c *CacheInvalidator) OnOrderChange(ctx context.Context, envelope DebeziumEnvelope[Order]) error {
    var orderID int64
    switch envelope.Op {
    case "c", "u", "r":
        if envelope.After != nil {
            orderID = envelope.After.ID
        }
    case "d":
        if envelope.Before != nil {
            orderID = envelope.Before.ID
        }
    }

    if orderID == 0 {
        return nil
    }

    // Invalidate all cache keys related to this order
    keys := []string{
        fmt.Sprintf("order:%d", orderID),
        fmt.Sprintf("user:%d:orders", getCustomerID(envelope)),
        fmt.Sprintf("order:%d:items", orderID),
    }

    if err := c.redis.Del(ctx, keys...).Err(); err != nil {
        return fmt.Errorf("redis del: %w", err)
    }

    c.logger.Info("cache invalidated", "order_id", orderID, "keys_deleted", len(keys))
    return nil
}

func getCustomerID(envelope DebeziumEnvelope[Order]) int64 {
    if envelope.After != nil {
        return envelope.After.CustomerID
    }
    if envelope.Before != nil {
        return envelope.Before.CustomerID
    }
    return 0
}
```

### Junior -> FAANG: CDC-Driven Cache Invalidation vs TTL-Based Expiry

The two standard approaches to cache freshness are TTL-based expiry and event-driven invalidation. Understanding when to use each is a practical skill for any junior engineer working on a service with a cache layer.

TTL-based expiry is simpler: set a key's lifetime when you write it, and let it expire automatically. The downside is that the cache may serve stale data for up to TTL seconds after the underlying data changes. For most read-heavy, low-write scenarios, this is acceptable.

CDC-driven invalidation eliminates that staleness window. When the database changes, the CDC event arrives at the consumer within milliseconds, and the consumer deletes the affected cache keys. The next read on those keys hits the database and repopulates the cache with fresh data. The tradeoff: the cache invalidation consumer is a new operational dependency. If it falls behind (consumer lag), cache staleness can exceed what a simple TTL would have provided.

The `CacheInvalidator` implementation above deletes cache keys by constructing a list of all keys related to the changed order. This is the correct approach for small, well-known key sets. For pattern-based invalidation (`search:*`), the implementation should use `SCAN` with a match pattern, not `KEYS *`, because `KEYS *` blocks the Redis server while it iterates the entire keyspace.

A first-job mistake to avoid: invalidating the cache before confirming the Kafka offset commit. If the process crashes after invalidating the cache but before committing the offset, the CDC event is redelivered. The cache key is already gone (no-op on re-deletion), but if you re-warm the cache during invalidation (instead of just deleting and letting the next read populate it), you might write stale data into the cache from an intermediate state. The safer pattern is delete-on-change, populate-on-miss, never pre-warm during invalidation.

### Senior @ FAANG: Cache Invalidation as a Platform Problem

At scale, cache invalidation is not a single-service concern. It is a platform pattern that must be applied consistently across dozens of services, each with its own cache topology.

**The cache invalidation fanout problem.** A single order change event may need to invalidate cache keys in multiple services: the order service cache, the user account summary cache, the analytics pre-computation cache, and the search index cache. Each service is a separate Kafka consumer group. If each service maintains its own cache invalidation consumer, the operational overhead scales linearly with the number of services. A platform-level approach is a centralized cache invalidation service that subscribes to CDC topics, maps change events to affected cache keys via a configuration registry, and performs the invalidations. This centralizes the operational burden but creates a single point of failure for all cache freshness.

**Cache invalidation and the thundering herd.** When a popular cached resource is invalidated (for example, a product that 10,000 users have in their carts), the next request from each of those users simultaneously hits the database. If the database cannot absorb this spike, the cache invalidation event causes a worse availability problem than the stale cache it was replacing. Mitigations include: probabilistic early expiration (invalidate keys before they expire, stagger the timing), a single-flight pattern (the first request populates the cache while all concurrent requests wait for that population rather than all hitting the database independently), and a short TTL alongside event-driven invalidation (so the thundering herd is bounded by the TTL even if event-driven invalidation is aggressive).

**Idempotency in cache invalidation.** Deleting a Redis key is inherently idempotent: deleting a key that does not exist is a no-op. This means CDC-driven cache invalidation is naturally idempotent for simple key deletion. The non-idempotent case is cache warming: if the invalidation event also pre-populates the cache with fresh data from the database, and the event is redelivered, the pre-population may overwrite data that a concurrent request has already correctly populated. A senior engineer evaluates whether the cache warming logic is safe for redelivery before adding it to the invalidation path.

**The monitoring gap for cache invalidation.** Most cache monitoring focuses on hit rate and miss rate. For CDC-driven invalidation, the critical metric is staleness: for how long after a database change is the cache serving the old value? This is measured by comparing `source.ts_ms` from the CDC event to the timestamp of the last cache population for the affected key. A rising staleness P99 indicates that the invalidation consumer is falling behind. This metric is rarely implemented by teams building their first CDC-driven cache, and its absence means that SLO violations on cache freshness are discovered by users, not by monitoring.

---
