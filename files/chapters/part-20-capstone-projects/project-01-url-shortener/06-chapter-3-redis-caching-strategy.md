## Chapter 3: Redis Caching Strategy

Caching is what makes a URL shortener fast enough for production use. Without a cache, every redirect would require a database query, adding latency and putting heavy load on PostgreSQL. In this chapter, we build a two-tier caching system: a fast in-memory LRU cache for the hottest URLs on each server instance, backed by a shared Redis cache that all instances can access. This combination gives us sub-millisecond lookups for popular links while keeping memory usage under control.

### 3.1 Two-Tier Caching Architecture

We implement a two-tier cache:
1. **L1 Cache**: In-memory LRU (per instance, ~10K hot URLs)
2. **L2 Cache**: Redis cluster (distributed, ~1M URLs)

```go
// internal/cache/redis.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/yourusername/goshort/internal/models"
)

// RedisCache implements CacheService with Redis
type RedisCache struct {
	client *redis.Client
	prefix string
	defaultTTL time.Duration
}

// NewRedisCache creates a new Redis cache
func NewRedisCache(client *redis.Client, prefix string) *RedisCache {
	return &RedisCache{
		client:     client,
		prefix:     prefix,
		defaultTTL: 1 * time.Hour,
	}
}

// Get retrieves a URL from cache
func (c *RedisCache) Get(ctx context.Context, key string) (*models.URL, error) {
	fullKey := c.makeKey(key)

	data, err := c.client.Get(ctx, fullKey).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, nil // Cache miss
		}
		return nil, fmt.Errorf("redis get: %w", err)
	}

	var url models.URL
	if err := json.Unmarshal(data, &url); err != nil {
		return nil, fmt.Errorf("unmarshaling cached URL: %w", err)
	}

	return &url, nil
}

// Set stores a URL in cache
func (c *RedisCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	fullKey := c.makeKey(key)

	data, err := json.Marshal(url)
	if err != nil {
		return fmt.Errorf("marshaling URL: %w", err)
	}

	if ttl == 0 {
		ttl = c.defaultTTL
	}

	if err := c.client.Set(ctx, fullKey, data, ttl).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}

	return nil
}

// Delete removes a URL from cache
func (c *RedisCache) Delete(ctx context.Context, key string) error {
	fullKey := c.makeKey(key)

	if err := c.client.Del(ctx, fullKey).Err(); err != nil {
		return fmt.Errorf("redis delete: %w", err)
	}

	return nil
}

// makeKey creates a prefixed cache key
func (c *RedisCache) makeKey(key string) string {
	return fmt.Sprintf("%s:url:%s", c.prefix, key)
}

// Ping checks Redis connectivity
func (c *RedisCache) Ping(ctx context.Context) error {
	return c.client.Ping(ctx).Err()
}
```

### 3.2 In-Memory LRU Cache

An LRU (Least Recently Used) cache keeps the most frequently accessed URLs in memory on each server instance. When the cache reaches its capacity limit, it automatically evicts the entry that has not been accessed for the longest time. This implementation uses Go's `container/list` for O(1) insertion and removal, a map for O(1) lookups, and a `sync.RWMutex` to make it safe for concurrent use by multiple goroutines.

```go
// internal/cache/lru.go
package cache

import (
	"container/list"
	"context"
	"sync"
	"time"

	"github.com/yourusername/goshort/internal/models"
)

// LRUCache is an in-memory LRU cache
type LRUCache struct {
	capacity   int
	cache      map[string]*list.Element
	lruList    *list.List
	mu         sync.RWMutex
	defaultTTL time.Duration
}

// cacheEntry represents a cache entry
type cacheEntry struct {
	key       string
	url       *models.URL
	expiresAt time.Time
}

// NewLRUCache creates a new LRU cache
func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity:   capacity,
		cache:      make(map[string]*list.Element),
		lruList:    list.New(),
		defaultTTL: 1 * time.Hour,
	}
}

// Get retrieves a value from cache
func (c *LRUCache) Get(ctx context.Context, key string) (*models.URL, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	element, exists := c.cache[key]
	if !exists {
		return nil, nil // Cache miss
	}

	entry := element.Value.(*cacheEntry)

	// Check expiration
	if time.Now().After(entry.expiresAt) {
		c.removeElement(element)
		return nil, nil
	}

	// Move to front (most recently used)
	c.lruList.MoveToFront(element)

	return entry.url, nil
}

// Set stores a value in cache
func (c *LRUCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if ttl == 0 {
		ttl = c.defaultTTL
	}

	// If key exists, update it
	if element, exists := c.cache[key]; exists {
		c.lruList.MoveToFront(element)
		entry := element.Value.(*cacheEntry)
		entry.url = url
		entry.expiresAt = time.Now().Add(ttl)
		return nil
	}

	// Add new entry
	entry := &cacheEntry{
		key:       key,
		url:       url,
		expiresAt: time.Now().Add(ttl),
	}

	element := c.lruList.PushFront(entry)
	c.cache[key] = element

	// Evict if over capacity
	if c.lruList.Len() > c.capacity {
		c.removeOldest()
	}

	return nil
}

// Delete removes a value from cache
func (c *LRUCache) Delete(ctx context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if element, exists := c.cache[key]; exists {
		c.removeElement(element)
	}

	return nil
}

// removeOldest removes the least recently used item
func (c *LRUCache) removeOldest() {
	element := c.lruList.Back()
	if element != nil {
		c.removeElement(element)
	}
}

// removeElement removes a specific element
func (c *LRUCache) removeElement(element *list.Element) {
	entry := element.Value.(*cacheEntry)
	delete(c.cache, entry.key)
	c.lruList.Remove(element)
}

// Size returns the current cache size
func (c *LRUCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.cache)
}
```

### 3.3 Layered Cache Implementation

The layered cache combines the LRU and Redis caches into a single unified interface. When a lookup request arrives, it first checks the fast L1 in-memory cache, then falls back to the L2 Redis cache, and only hits the database as a last resort. If the L2 cache returns a result, the layered cache automatically promotes it into L1 so that subsequent requests for the same URL are even faster.

```go
// internal/cache/layered.go
package cache

import (
	"context"
	"time"

	"github.com/yourusername/goshort/internal/models"
)

// LayeredCache implements a two-tier cache (L1: LRU, L2: Redis)
type LayeredCache struct {
	l1 *LRUCache
	l2 *RedisCache
}

// NewLayeredCache creates a new layered cache
func NewLayeredCache(l1 *LRUCache, l2 *RedisCache) *LayeredCache {
	return &LayeredCache{
		l1: l1,
		l2: l2,
	}
}

// Get retrieves from L1, then L2, then returns nil
func (c *LayeredCache) Get(ctx context.Context, key string) (*models.URL, error) {
	// Try L1 first
	url, err := c.l1.Get(ctx, key)
	if err == nil && url != nil {
		return url, nil
	}

	// L1 miss, try L2
	url, err = c.l2.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	if url != nil {
		// Populate L1 with L2 data
		_ = c.l1.Set(ctx, key, url, 1*time.Hour)
	}

	return url, nil
}

// Set stores in both L1 and L2
func (c *LayeredCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	// Set in L1
	_ = c.l1.Set(ctx, key, url, ttl)

	// Set in L2
	return c.l2.Set(ctx, key, url, ttl)
}

// Delete removes from both layers
func (c *LayeredCache) Delete(ctx context.Context, key string) error {
	_ = c.l1.Delete(ctx, key)
	return c.l2.Delete(ctx, key)
}
```

---

### Junior → FAANG: Cache Design as an Interview Story

Two-tier caching is a strong interview talking point because it shows you understand both the performance and the operational dimensions of caching. When asked "how does your redirect service achieve sub-millisecond latency," walk through L1 hit (in-process, nanosecond range), L1 miss falling to L2 (Redis, sub-millisecond), and L2 miss falling to database. Each layer has a different latency profile and a different failure mode.

Cache invalidation is where most junior candidates get stuck. For a URL shortener, a URL update must invalidate both the L1 cache on every instance and the L2 Redis key. L2 invalidation is straightforward with a `DEL` command. L1 invalidation across multiple instances requires either a TTL-based approach (accept brief staleness) or a pub/sub notification (Redis pub/sub to signal all instances to evict). Know this problem and have an answer ready.

### Senior @ FAANG: Cache Tier as a Platform Concern

At senior level, the L1/L2 cache architecture is not just a latency optimization. It is a data consistency contract. Each layer introduces a consistency window: L1 may serve stale data for up to its TTL after an update. L2 may serve stale data between the `DEL` command and the next cache population. The product must accept these windows or the cache tier must be re-architected.

Memory sizing is an operational decision that requires measurement, not estimation. An LRU cache of 10k URLs per instance sounds reasonable, but the actual working set depends on traffic distribution. If 80% of traffic hits 1% of URLs (typical Zipf distribution for popular links), a smaller L1 may achieve the same hit rate with less memory. Instrument your L1 hit rate as a metric and tune the cache size based on observed data.

Redis cluster topology deserves an ADR. A single Redis primary works for development but fails as a single point of failure. Redis Sentinel provides automatic failover but adds operational complexity. Redis Cluster provides horizontal scaling but changes the client programming model significantly (key slot constraints, cross-slot operations disallowed). The decision depends on your RPS requirements and your team's operational experience with each mode. Document the chosen topology, the failover behavior, and the client reconnection strategy.

Cache warming after deployment is a production concern that does not appear in most design documents. On initial deploy or after a Redis flush, the cache is empty and every request falls through to the database. Under high traffic, this thundering herd can overwhelm the database. Mitigations include proactive cache warming from a precomputed list of hot URLs, request coalescing (only one backend request per cache miss, with others waiting), and circuit breakers that shed load if the database is overwhelmed. Each mitigation has a cost and should be part of the deployment runbook.

---
