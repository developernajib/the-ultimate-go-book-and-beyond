## 57.9 Caching Strategies

BFFs are well-positioned to cache aggregated responses because they know the client's access pattern and can apply cache invalidation rules that span multiple downstream services. An in-process cache with a short TTL absorbs request spikes from re-renders and tab switches without overwhelming downstream services, while a shared Redis cache coordinates cache warming across BFF instances behind a load balancer. The implementation below applies cache-aside with a per-route TTL strategy that differentiates between user-specific and shared responses.

```go
// services/web-bff/internal/cache/cache.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

type BFFCache struct {
    client *redis.Client
    prefix string
}

func NewBFFCache(client *redis.Client, bffName string) *BFFCache {
    return &BFFCache{
        client: client,
        prefix: fmt.Sprintf("bff:%s:", bffName),
    }
}

// CacheConfig for different data types
type CacheConfig struct {
    // Static content (hero images, categories)
    StaticTTL time.Duration // 10 minutes

    // Semi-static (featured products)
    SemiStaticTTL time.Duration // 2 minutes

    // User-specific (cart, recommendations)
    UserDataTTL time.Duration // 30 seconds

    // Real-time (stock levels)
    RealtimeTTL time.Duration // 5 seconds
}

var DefaultCacheConfig = CacheConfig{
    StaticTTL:     10 * time.Minute,
    SemiStaticTTL: 2 * time.Minute,
    UserDataTTL:   30 * time.Second,
    RealtimeTTL:   5 * time.Second,
}

func (c *BFFCache) Get(ctx context.Context, key string, dest any) error {
    data, err := c.client.Get(ctx, c.prefix+key).Bytes()
    if err != nil {
        return err
    }
    return json.Unmarshal(data, dest)
}

func (c *BFFCache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    data, err := json.Marshal(value)
    if err != nil {
        return err
    }
    return c.client.Set(ctx, c.prefix+key, data, ttl).Err()
}

func (c *BFFCache) Delete(ctx context.Context, key string) error {
    return c.client.Del(ctx, c.prefix+key).Err()
}

// InvalidatePattern deletes all keys matching a pattern
func (c *BFFCache) InvalidatePattern(ctx context.Context, pattern string) error {
    iter := c.client.Scan(ctx, 0, c.prefix+pattern, 100).Iterator()
    var keys []string
    for iter.Next(ctx) {
        keys = append(keys, iter.Val())
    }
    if len(keys) > 0 {
        return c.client.Del(ctx, keys...).Err()
    }
    return nil
}

// GetOrSet with cache-aside pattern
func (c *BFFCache) GetOrSet(
    ctx context.Context,
    key string,
    dest any,
    ttl time.Duration,
    loader func() (any, error),
) error {
    // Try cache first
    if err := c.Get(ctx, key, dest); err == nil {
        return nil
    }

    // Cache miss - load data
    value, err := loader()
    if err != nil {
        return err
    }

    // Store in cache (async to not block response)
    go func() {
        ctx := context.Background() // Use background context for async cache write
        c.Set(ctx, key, value, ttl)
    }()

    // Copy value to dest
    data, _ := json.Marshal(value)
    return json.Unmarshal(data, dest)
}

// UserCache creates a user-scoped cache key
func (c *BFFCache) UserKey(userID, key string) string {
    return fmt.Sprintf("user:%s:%s", userID, key)
}
```

### Junior -> FAANG: Thinking in Cache TTL Tiers

The four-tier TTL classification in `CacheConfig` (static, semi-static, user data, realtime) is the practical mental model for BFF caching decisions. When you add a new endpoint, the first question is: which tier does this data belong to?

Static data (categories, country lists, configuration flags) changes at most once per deploy and is safe to cache for ten minutes or more. Semi-static data (featured products, promotions) changes on a business schedule (usually hourly or daily) and is safe to cache for one to five minutes with a stale-while-revalidate extension. User data (cart counts, wishlist flags, preferences) changes frequently and is specific to one user, so cache it with a short TTL (30-60 seconds) per user, not shared. Realtime data (stock levels, live prices) must not be cached or must use TTLs of five seconds or less.

A first-job mistake is caching realtime data at the same TTL as semi-static data. Users who see "In Stock" on a product that is actually out of stock, or a price that changed seconds ago, have a degraded experience that can cause order failures and customer support escalations. When in doubt, cache more conservatively (shorter TTL) and relax after verifying the downstream service can handle the load.

The async cache write in `GetOrSet` (`go func() { c.Set(...) }()`) is a correct pattern for non-critical cache population but requires careful handling. The goroutine uses `context.Background()` to avoid cancellation when the request context is done, which is correct. But it also means if the Redis write fails, the error is silently discarded. Add error logging inside the goroutine.

### Senior @ FAANG: Cache Architecture Decisions at Scale

At senior level, caching is an architectural decision with reliability, consistency, and cost trade-offs that must be documented and owned.

The two-tier cache (local in-process plus Redis) shown in the `getShared` method is the right production architecture for hot-path BFF data. Local cache reduces Redis traffic by absorbing repeated reads within the same BFF instance (think of a product page that fetches the same category data in the hero, breadcrumb, and related products sections all within one request). Redis serves as the shared truth across all BFF instances, preventing cold-start amplification when a new BFF instance is spun up.

Cache key namespacing with `bff:{name}:` prefix is a production requirement, not optional. Without namespacing, two BFFs sharing a Redis cluster can inadvertently read each other's cached data, which could serve a mobile-optimized response structure to a web client or vice versa. The prefix also enables pattern-based invalidation (`bff:web:*`) without affecting other BFFs.

Cache stampede (thundering herd) deserves explicit mitigation at the BFF layer. When a cached item expires, all concurrent requests that miss the cache simultaneously call the downstream service. Under high traffic this can send hundreds of concurrent requests to a downstream service in the milliseconds after expiry. The `singleflight.Group` (visible in the resilience layer in `11-5610`) is the standard mitigation: only one goroutine fetches the data, and all concurrent misses wait for that one fetch. Integrating singleflight into `GetOrSet` is a senior-level improvement over the implementation shown.

At staff level, the cache design also intersects with regulatory compliance. GDPR's right to erasure requires that when a user requests deletion of their data, all cached copies are also deleted. For user-scoped cache keys (the `user:{id}:*` namespace), implement a `PurgeUserData(userID string)` method that deletes all keys matching that pattern and wire it to the account deletion event handler. This is not optional in EU markets and is increasingly required in other jurisdictions.

---
