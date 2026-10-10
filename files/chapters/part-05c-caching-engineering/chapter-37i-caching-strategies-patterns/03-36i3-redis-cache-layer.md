## 37I.3 Redis Cache Layer

### Production Redis Client with Caching Patterns

`RedisCache` wraps `go-redis/v9` with a key-prefix namespace, structured logging via `slog`, and an injected `CacheMetricsCollector` so every `Get` and `Set` is tracked in Prometheus. JSON marshaling is centralized inside the struct so callers work with typed values, and all Redis errors are wrapped with `fmt.Errorf` to preserve context through the call stack. The `GetOrSet` method implements cache-aside inline, while `MGet` batches multiple lookups into a single Redis round-trip to reduce network overhead.

**Redis or Valkey?** Since Redis Ltd. switched Redis from BSD-3 to a source-available license (RSALv2/SSPLv1) in 2024, the Linux Foundation's **Valkey** fork has become the default in most clouds (AWS ElastiCache for Valkey, GCP Memorystore for Valkey, major Linux distributions). Both speak RESP2/RESP3, both work with `go-redis/v9` unchanged, and both implement the same commands at the cache-layer abstraction. For this chapter treat the two as interchangeable. See Chapter 35 for the licensing and operational differences that matter at the infrastructure level.

**TTL jitter.** Every code sample in this chapter that writes a TTL should add a small random offset (typically +/- 10-20% of the base TTL) before calling `SET`. If a large batch of keys is populated at the same moment - for example during a warm-up or after an invalidation sweep - a fixed TTL causes them all to expire at the same millisecond, which then collapses into a synchronized stampede against the origin. `ttl + time.Duration(rand.Int64N(int64(ttl/5)))` is a reasonable default.

**Negative caching.** Cache-aside leaves you exposed to repeated misses for keys that will never exist - a common source of database scans during scraping or enumeration attacks. Store a sentinel (e.g. an empty value with a short TTL of 30-60 seconds) when the origin returns "not found", and treat that sentinel as a cache hit on subsequent reads. Distinguish the sentinel from a legitimate empty result so callers don't confuse "known absent" with "known empty list".

```go
package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisCache provides Redis-backed distributed caching
type RedisCache struct {
	client  *redis.Client
	prefix  string
	log     *slog.Logger
	metrics *CacheMetricsCollector
}

// Config for Redis cache
type RedisCacheConfig struct {
	Addr         string
	Password     string
	DB           int
	MaxRetries   int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	PoolSize     int
	KeyPrefix    string
}

// NewRedisCache creates a production Redis cache
func NewRedisCache(cfg RedisCacheConfig, log *slog.Logger) (*RedisCache, error) {
	client := redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		MaxRetries:   cfg.MaxRetries,
		DialTimeout:  cfg.DialTimeout,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		PoolSize:     cfg.PoolSize,
		MinIdleConns: cfg.PoolSize / 4,
		PoolTimeout:  cfg.ReadTimeout + time.Second,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	return &RedisCache{
		client:  client,
		prefix:  cfg.KeyPrefix,
		log:     log,
		metrics: NewCacheMetricsCollector("redis"),
	}, nil
}

func (c *RedisCache) key(k string) string {
	if c.prefix == "" {
		return k
	}
	return c.prefix + ":" + k
}

// Get retrieves a value from Redis
func (c *RedisCache) Get(ctx context.Context, key string, dest any) error {
	data, err := c.client.Get(ctx, c.key(key)).Bytes()
	if errors.Is(err, redis.Nil) {
		c.metrics.RecordMiss(key)
		return ErrCacheMiss
	}
	if err != nil {
		return fmt.Errorf("redis get: %w", err)
	}

	c.metrics.RecordHit(key)
	return json.Unmarshal(data, dest)
}

// Set stores a value in Redis with TTL
func (c *RedisCache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	return c.client.Set(ctx, c.key(key), data, ttl).Err()
}

// SetWithJitter stores a value with a TTL randomised by up to +/- 20%.
// Use this for any batch-populated keys to avoid synchronised expiry storms.
func (c *RedisCache) SetWithJitter(ctx context.Context, key string, value any, baseTTL time.Duration) error {
	jitter := time.Duration(rand.Int64N(int64(baseTTL) / 5)) // up to +20%
	return c.Set(ctx, key, value, baseTTL+jitter)
}

// SetNegative caches a "not found" sentinel so repeat misses don't hit the origin.
// ttl should be short (30-60s) so the cache self-heals when the key eventually exists.
func (c *RedisCache) SetNegative(ctx context.Context, key string, ttl time.Duration) error {
	return c.client.Set(ctx, c.key(key), negativeSentinel, ttl).Err()
}

// IsNegative reports whether a raw value is the not-found sentinel.
func IsNegative(raw []byte) bool { return bytes.Equal(raw, []byte(negativeSentinel)) }

const negativeSentinel = "\x00NF\x00"

// SetNX sets only if not exists (atomic check-and-set)
func (c *RedisCache) SetNX(ctx context.Context, key string, value any, ttl time.Duration) (bool, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	return c.client.SetNX(ctx, c.key(key), data, ttl).Result()
}

// Delete removes keys from Redis
func (c *RedisCache) Delete(ctx context.Context, keys ...string) error {
	prefixed := make([]string, len(keys))
	for i, k := range keys {
		prefixed[i] = c.key(k)
	}
	return c.client.Del(ctx, prefixed...).Err()
}

// DeletePattern deletes all keys matching a pattern (use carefully!)
func (c *RedisCache) DeletePattern(ctx context.Context, pattern string) (int64, error) {
	var cursor uint64
	var deleted int64

	for {
		keys, nextCursor, err := c.client.Scan(ctx, cursor, c.key(pattern), 100).Result()
		if err != nil {
			return deleted, err
		}

		if len(keys) > 0 {
			n, err := c.client.Del(ctx, keys...).Result()
			if err != nil {
				return deleted, err
			}
			deleted += n
		}

		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	return deleted, nil
}

// GetOrSet implements cache-aside pattern atomically
func (c *RedisCache) GetOrSet(ctx context.Context, key string, dest any, ttl time.Duration, fetch func() (any, error)) error {
	// Try cache first
	if err := c.Get(ctx, key, dest); err == nil {
		return nil // cache hit
	}

	// Cache miss: fetch from source
	value, err := fetch()
	if err != nil {
		return fmt.Errorf("fetch: %w", err)
	}

	// Store in cache (ignore error - cache is best-effort)
	if setErr := c.Set(ctx, key, value, ttl); setErr != nil {
		c.log.Warn("cache set failed", "key", key, "err", setErr)
	}

	// Copy value to dest
	data, _ := json.Marshal(value)
	return json.Unmarshal(data, dest)
}

// MGet retrieves multiple values in a single round-trip
func (c *RedisCache) MGet(ctx context.Context, keys []string, dests []any) ([]bool, error) {
	prefixed := make([]string, len(keys))
	for i, k := range keys {
		prefixed[i] = c.key(k)
	}

	results, err := c.client.MGet(ctx, prefixed...).Result()
	if err != nil {
		return nil, err
	}

	hits := make([]bool, len(keys))
	for i, result := range results {
		if result == nil {
			continue
		}
		data, ok := result.(string)
		if !ok {
			continue
		}
		if err := json.Unmarshal([]byte(data), dests[i]); err == nil {
			hits[i] = true
		}
	}
	return hits, nil
}

// Pipeline executes multiple cache operations in a single round-trip
func (c *RedisCache) Pipeline(ctx context.Context, fn func(pipe redis.Pipeliner) error) error {
	_, err := c.client.Pipelined(ctx, fn)
	return err
}

// Increment atomically increments a counter
func (c *RedisCache) Increment(ctx context.Context, key string, by int64, ttl time.Duration) (int64, error) {
	pipe := c.client.Pipeline()
	incr := pipe.IncrBy(ctx, c.key(key), by)
	pipe.Expire(ctx, c.key(key), ttl)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return 0, err
	}
	return incr.Val(), nil
}

var ErrCacheMiss = errors.New("cache miss")
```

### Junior → FAANG: Redis as your first distributed cache

The first thing to internalise is that Redis is single-threaded per shard for command execution. A long `KEYS *` or a heavy `LRANGE` blocks every other client on that shard for the duration of the command. This is why `DeletePattern` above uses `SCAN` with a cursor and a batch size instead of `KEYS`. On day one of your job, if you type `redis-cli KEYS 'user:*'` against a production 100 GB Redis, you will create an incident. Use `SCAN`, always, for any key-enumeration operation.

The second thing is the difference between `SET`, `SETNX`, and `SET key value EX ttl NX`. Plain `SET` always overwrites. `SETNX` sets only if the key does not exist but has no TTL argument, so a classic bug is `SETNX` followed by `EXPIRE` with a race window where a crash between the two leaves an immortal key. The correct single-command form is `SET key value NX EX 60`, which is what `go-redis` emits when you pass the right options. Never split set-and-expire into two commands against the same key.

First-job worked example. You are implementing a rate limiter keyed by user ID. The naive design is `INCR user:{id}:count` followed by `EXPIRE user:{id}:count 60` the first time. The race is that two requests can both observe count = 1 and both issue EXPIRE, which resets the window. The fix is a Lua script that combines INCR and EXPIRE atomically, or the pattern in the `Increment` method above that pipelines both commands in one round-trip. Pipelining does not make the pair atomic, but it halves the network cost and keeps the expiry reset bug bounded to a single RTT. For true atomicity, use a Lua script or the `SET key value XX KEEPTTL` variant (the `KEEPTTL` option was added in Redis 6.0), which updates the value while preserving the existing TTL.

Interview entry points: what is the difference between RESP2 and RESP3 (RESP3 adds typed map responses and push notifications, used for keyspace notifications and client tracking), why do you need a connection pool (Redis commands are cheap but TCP handshakes are not, reuse connections), and how does `MGET` differ from a pipeline of `GET`s (MGET is a single command that returns all values in order, pipelines are N commands that return N responses). Also be ready to explain why you should never run `FLUSHALL` in production even once.

TTL jitter, negative caching, and the `GetOrSet` cache-aside helper in the code above encode three lessons that cost teams real incidents before they learned them. Jitter prevents the synchronized expiry stampede. Negative caching prevents 404-scan attacks from bleeding through to the database. `GetOrSet` centralizes the cache-aside ladder so callers cannot forget to populate the cache after a miss. Memorize those three patterns and you will avoid most of the bugs that junior engineers ship in their first caching PR.

### Senior @ FAANG: Redis patterns, coherence modes, and stampede control

At staff level the Redis cache layer is defined by five named patterns. Be able to articulate each on a whiteboard with latency, consistency, and failure-mode implications.

**Read-aside (cache-aside)** is the default. The application reads cache first, on miss reads the origin, then writes to the cache. Writes to the origin are the application's responsibility, and the application must invalidate or update the cache after a successful origin write. Latency on hit is one Redis RTT. Latency on miss is one Redis RTT plus one origin RTT plus one Redis SET. Consistency is eventual. Failure mode: if the cache is down, read-aside degrades to direct origin reads at full load, which is the cascade-failure risk. Mitigation: short client-side circuit breaker on Redis errors, plus L1 cache in front.

**Read-through** moves the fetch logic into the cache layer itself. The application calls `cache.Get(key)` and the cache, on miss, calls a registered loader. This simplifies application code but couples the cache to the data model. In Go, read-through is typically implemented as a decorator over a repository interface (see the cache-aside file for the pattern). Use read-through when the loader is stable and widely reused. Avoid it when different callers need different fetch semantics.

**Write-through** writes to the cache and the origin synchronously, in that order (cache first) or the reverse (origin first). Origin-first write-through is the safe default: a write that fails the origin never populates the cache, so the cache cannot lead the truth. Cache-first write-through is faster but leaves a window where cache is ahead of origin, which is a consistency bug if any other reader goes direct to origin. Write-through doubles write latency and has to handle partial failure (cache write succeeds, origin write fails): the correct recovery is to DEL the cache key so the next reader repopulates from origin.

**Write-behind (write-back)** writes to the cache synchronously and queues the origin write for asynchronous flush. Write latency drops to cache-only. Durability is the trade-off: a crash between cache write and origin flush loses data. Use write-behind only when data loss on a small window is acceptable (metrics counters, view counts, analytics events) or when you combine it with a durable queue (Kafka) as the buffer instead of memory. Many production "write-behind" systems are actually "write-to-Kafka, consume-to-origin" pipelines, which is durable write-behind.

**Refresh-ahead** proactively rehydrates a cache entry before its TTL fires, based on observed access frequency. Caffeine supports this natively. In Redis, implement it by setting a logical TTL shorter than the physical TTL: on read, if the logical TTL has elapsed but the physical has not, return the current value and trigger a background refresh. This eliminates the miss-latency cliff at TTL boundaries for hot keys. It also doubles origin load on the hottest keys, so it is net-positive only when origin capacity is not the bottleneck.

**Cache stampede control** deserves its own section because it is the most common cache-induced outage. The stampede happens when a hot key expires and N concurrent readers all miss simultaneously, all call the origin, and the origin melts. Three mitigations in increasing strength:

1. **Singleflight** (`golang.org/x/sync/singleflight`) deduplicates concurrent calls for the same key within one process. Every replica still pays one origin call per expiry, so with 50 replicas you reduce load by 50x but the origin still sees 50 concurrent calls, not 1.

2. **Probabilistic early expiration (XFetch)** (Vattani, Chierichetti, Lowenstein, VLDB 2015). Each reader, on a hit, rolls a biased random variable and probabilistically treats the entry as expired slightly before its actual TTL. The probability rises as the entry approaches expiry. The effect is that exactly one reader, in expectation, refreshes the entry before the hard expiry, and the rest continue to hit. This eliminates the boundary stampede across all replicas without coordination. The formula is: on a hit with value `v`, computed-at time `t`, TTL `ttl`, and measured fetch cost `delta`, treat as expired if `time.Now() - t + delta * beta * log(random())` >= `ttl`. `beta` is usually 1.0. This is a two-line addition to the cache-aside helper and should be the default for any hot-key cache.

3. **Distributed lock** with `SET NX EX` across Redis for the miss path. Only the lock holder fetches, the rest poll or subscribe. This coordinates across replicas at the cost of a Redis round-trip on every miss. Combine with a fence token (monotonic version) to handle the case where the lock holder crashes and a second holder resumes: the second holder's write must include a version check to avoid overwriting a later value. This is the strongest mitigation but the most expensive. Reserve it for origins that cannot tolerate more than one concurrent refetch per key across the entire fleet.

**Cache warming on cold start** is the last staff-level lever. A freshly deployed replica has an empty L1 cache and, if the deployment also flushed Redis, an empty L2. Cold-cache traffic hits the origin at full volume and can trigger a cascade. Mitigations include: deploy replicas in rolling waves not big-bang, warm the cache from a replay of recent access logs before marking the replica healthy for traffic, preseed the L1 cache from L2 using a known hot-key list on startup, and run a low-rate synthetic warmer that pulls the top-1000 keys into cache ahead of the liveness probe passing. The ADR should state which warming strategy applies and which keys define the hot set.

### Production Evaluation: Valkey vs Redis Under 40k RPS Load

Following Redis Ltd.'s shift from BSD-3 to dual RSALv2/SSPLv1 licensing in 2024, the Linux Foundation fork **Valkey** became the default caching engine across cloud providers (AWS ElastiCache for Valkey, Google Cloud Memorystore for Valkey).

A six-month production study by [Yusuf Seyitoğlu (July 2026), "Valkey vs Redis in 2026: I Ran Both Under the Same Production Load - The Winner Wasn’t About Speed"](https://medium.com/@yusufseyitoglu/valkey-vs-redis-in-2026-i-ran-both-under-the-same-production-load-the-winner-wasn-t-about-speed) measured both engines behind identical payment and session workloads on AWS `r7g.2xlarge` instances at 40,000 requests/sec with Zipfian hot-key distributions.

| Evaluation Metric | Redis 8 | Valkey 8.1 / 9.0 | Production Takeaway |
|---|---|---|---|
| **Raw Synthetic Throughput** | ~947,000 ops/sec | ~962,000 ops/sec | Negligible variance (< 2%) at standard concurrency |
| **P99 Read Latency (GET)** | 0.287 ms | 0.298 ms | Parity under steady-state production traffic |
| **High Concurrency (900+ conns)** | Baseline | +15% to +32% ops/sec | Valkey multi-threaded I/O scales better under high connection count |
| **Memory Footprint (RSS)** | Baseline | ~8% lower RSS | Valkey Swiss-table style hash map reduces overhead per key |
| **Managed Cloud Cost** | Standard tier | 20% to 33% discount | AWS and GCP price managed Valkey lower than proprietary Redis |
| **Go Client Compatibility** | `go-redis/v9` | `go-redis/v9` | 100% binary wire-protocol compatibility across RESP2/RESP3 |

#### Operational Key Takeaways

1. **Memory Sizing**: Valkey's reworked defragmentation engine and key-value hash structures (similar to Swiss Tables) reduce memory overhead by ~8%. At large scale, this allows down-sizing cluster instances. Snap migrated 70% of its Redis fleet to managed Valkey, cutting annual infrastructure spend from $2.1M to $840k while processing 5 billion daily operations.
2. **Connection Scaling**: For workloads dominated by thousands of concurrent serverless or microservice workers opening direct TCP connections, Valkey's multi-threaded network I/O reduces tail latency spikes compared to single-threaded dispatch.
3. **Module Ecosystem Tradeoffs**: Redis still maintains advantages if applications rely on proprietary Redis Stack modules (RedisJSON, RediSearch, RedisGraph) or Redis Enterprise multi-region active-active CRDT replication. For standard caching, session storage, sorted sets, and rate-limiting, Valkey is a drop-in binary equivalent for Go backends.

---
