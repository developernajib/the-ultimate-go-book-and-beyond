## 37I.5 Cache Stampede Prevention

### Single-Flight and Probabilistic Early Refresh

`StampedeProtectedCache` combines `singleflight.Group` with probabilistic early refresh to address two distinct failure modes: a hard stampede (many goroutines miss simultaneously) is flattened by `singleflight` so only one origin fetch runs and all waiters receive the same result. An expiry stampede (a popular key expires under load) is pre-empted by the probabilistic refresh, which stochastically triggers a background refill before the TTL actually expires. The `singleflight` key is the cache key itself, so deduplication is scoped per cache entry rather than per endpoint.

```go
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"time"

	"golang.org/x/sync/singleflight"
)

// StampedeProtectedCache wraps a cache with stampede prevention
type StampedeProtectedCache[T any] struct {
	cache  *RedisCache
	group  singleflight.Group
	log    *slog.Logger
}

// GetWithSingleFlight: only one goroutine fetches on cache miss
// All other concurrent requests wait for the single fetch
func (c *StampedeProtectedCache[T]) Get(ctx context.Context, key string, ttl time.Duration, fetch func(ctx context.Context) (T, error)) (T, error) {
	var value T

	// Try cache first
	if err := c.cache.Get(ctx, key, &value); err == nil {
		return value, nil
	}

	// Single-flight: deduplicate concurrent fetches for same key
	result, err, shared := c.group.Do(key, func() (any, error) {
		// Re-check cache after acquiring lock (double-check locking)
		var v T
		if err := c.cache.Get(ctx, key, &v); err == nil {
			return v, nil
		}

		// Fetch from source
		fetched, err := fetch(ctx)
		if err != nil {
			return nil, err
		}

		// Populate cache
		if setErr := c.cache.Set(ctx, key, fetched, ttl); setErr != nil {
			c.log.Warn("cache set after fetch failed", "key", key, "err", setErr)
		}

		return fetched, nil
	})

	if err != nil {
		return value, err
	}

	if shared {
		c.log.Debug("singleflight result shared", "key", key)
	}

	return result.(T), nil
}

// ProbabilisticEarlyRefresh: refresh cache before it expires
// Avoids thundering herd on TTL expiry
// Uses XFetch algorithm: refresh early with probability based on remaining TTL
func (c *StampedeProtectedCache[T]) GetWithEarlyRefresh(ctx context.Context, key string, ttl time.Duration, beta float64, fetch func(ctx context.Context) (T, error)) (T, error) {
	// Get value + TTL remaining
	type cachedItem[T any] struct {
		Value T
		Delta float64 // how long the last fetch took (ms)
		Expiry int64  // unix timestamp
	}

	var item cachedItem[T]
	if err := c.cache.Get(ctx, "xf:"+key, &item); err == nil {
		remaining := float64(item.Expiry) - float64(time.Now().UnixMilli())/1000.0
		// XFetch: early expiry probability
		// P(early refresh) = -delta * beta * ln(random) > remaining
		threshold := -item.Delta * beta * math.Log(rand.Float64())
		if remaining > threshold {
			return item.Value, nil // cache hit, no refresh needed
		}
		// Early refresh triggered
		c.log.Debug("early cache refresh triggered", "key", key, "remaining_s", remaining)
	}

	// Fetch (with single-flight to prevent stampede)
	return c.Get(ctx, key, ttl, func(ctx context.Context) (T, error) {
		start := time.Now()
		value, err := fetch(ctx)
		if err != nil {
			return value, err
		}

		// Store with XFetch metadata
		xfItem := cachedItem[T]{
			Value:  value,
			Delta:  time.Since(start).Seconds(),
			Expiry: time.Now().Add(ttl).Unix(),
		}
		c.cache.Set(ctx, "xf:"+key, xfItem, ttl)
		return value, nil
	})
}

// DistributedLockRefresh: uses Redis lock to ensure single refresh
type DistributedLockRefresh[T any] struct {
	cache  *RedisCache
	log    *slog.Logger
}

// GetWithLock: only one instance refreshes (for multi-process deployments)
func (c *DistributedLockRefresh[T]) GetWithLock(ctx context.Context, key string, ttl time.Duration, fetch func(ctx context.Context) (T, error)) (T, error) {
	var value T

	// Try cache
	if err := c.cache.Get(ctx, key, &value); err == nil {
		return value, nil
	}

	// Acquire distributed lock
	lockKey := "lock:" + key
	lockAcquired, err := c.cache.SetNX(ctx, lockKey, "1", 30*time.Second)
	if err != nil {
		return value, fmt.Errorf("lock acquire: %w", err)
	}

	if !lockAcquired {
		// Another process is refreshing - wait and retry
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		timeout := time.After(5 * time.Second)

		for {
			select {
			case <-timeout:
				return value, fmt.Errorf("timeout waiting for cache refresh")
			case <-ticker.C:
				if err := c.cache.Get(ctx, key, &value); err == nil {
					return value, nil
				}
			case <-ctx.Done():
				return value, ctx.Err()
			}
		}
	}

	// We have the lock - fetch and populate
	defer c.cache.Delete(ctx, lockKey)

	value, err = fetch(ctx)
	if err != nil {
		return value, err
	}

	c.cache.Set(ctx, key, value, ttl)
	return value, nil
}
```

### Junior to FAANG: Understanding the Stampede Before Writing Code

A stampede is what happens when a hot key expires and every in-flight request misses at the same instant. One popular product page evicts at `T=0`. Fifty thousand requests per second hit the origin database simultaneously. The database that happily served zero QPS a moment ago now sees fifty thousand, falls over, and the cache never gets repopulated because every fetch times out. This is the "dogpile" problem. The fix is not "add more cache capacity." The fix is to ensure that only one fetch runs per key while the others wait or serve stale data.

Before touching the code above, get these prerequisites solid. First, know the three failure modes. A cold-start stampede happens when the cache is empty, for example after a deploy or a flush. An expiry stampede happens when a hot key hits its TTL. A write-back stampede happens when a flurry of updates each invalidate the same read key. Each has a different mitigation. The code in this file targets the first two. Second, understand why `singleflight` alone is not enough in multi-pod deployments. `singleflight.Group` deduplicates within one process. If you run 100 pods, you still get 100 concurrent origin fetches on a miss, which is an order of magnitude better than 50000 but still lethal for an unprepared database. That is why `DistributedLockRefresh` uses Redis `SETNX` to serialize across pods.

Worked example for a first-job engineer. Suppose you cache `product:42` with `TTL=60s` and it receives 10000 QPS. Without protection, every 60 seconds you get a spike of 10000 concurrent origin calls in the millisecond window after expiry. With `singleflight` per pod and 50 pods, you get 50 concurrent calls, which is tolerable. With probabilistic early refresh (XFetch, Vattani, Chierichetti, Lowenstein 2015), each request has a small probability of triggering a refresh before expiry, proportional to how long the last fetch took (`delta`) and how close to expiry you are. The probability is computed as `time_now - delta * beta * ln(random) >= expiry`. Tune `beta` around 1.0. A higher `beta` refreshes earlier and more often. A lower `beta` refreshes closer to expiry. The key insight is that `delta` (measured fetch latency) adapts the refresh window to the actual cost of the origin call. Expensive queries refresh earlier. Cheap queries refresh later.

Interview entry-point. If an interviewer asks "how do you prevent cache stampede," do not jump to "add a lock." Walk through the taxonomy. State the three failure modes. Propose `singleflight` for in-process dedup. Propose a distributed lock (Redis `SETNX` with a lease TTL) for cross-process dedup. Then mention probabilistic early refresh to avoid lock contention in the first place. Bonus points if you mention stale-while-revalidate, where the cache returns the old value immediately and kicks off an async refresh, giving you a latency of zero on the hot path and eliminating the stampede entirely. The `SETNX` lock must have a bounded TTL (30 seconds in the code above) so that a dead fetcher cannot permanently block refreshes. The waiting goroutines must also have a timeout (5 seconds above) so a slow origin does not propagate stalls.

Common junior mistakes. Forgetting the double-check inside the `singleflight` callback so you miss a concurrent write that populated the cache while you were queued. Using a non-expiring lock key, which deadlocks the whole key forever if the holder crashes. Using `time.Sleep` in a poll loop instead of a ticker with context cancellation. Not logging when `shared` is true, which hides the fact that your deduplication is actually working in production. Caching the error result (negative caching) for the same TTL as success, which turns a transient origin blip into a minute of 5xx responses. If you do negative-cache, use a much shorter TTL (1 to 5 seconds) and a distinct sentinel so it is visible in metrics.

### Senior at FAANG: Stampede Engineering at Scale

At staff and principal level, stampede prevention is not a library choice. It is a system property that must be reasoned about end-to-end across the caching topology, the origin capacity model, and the failure envelope. The code in this file is a correct local mitigation but it is only one layer of a defense in depth.

Start with the math. The XFetch probabilistic early expiration formula comes from the Vattani et al paper "Optimal Probabilistic Cache Stampede Prevention" (VLDB 2015). The refresh condition is `time_now - delta * beta * ln(U) >= expiry`, where `U` is uniform on `(0,1]` and `delta` is the measured recomputation cost. The expected number of concurrent recomputations when the key is accessed at rate `lambda` is bounded by roughly `1 + lambda * delta * beta` regardless of access rate, which is the key result. That means for a key accessed at 100k QPS with `delta=100ms` and `beta=1`, you expect about `1 + 100000 * 0.1 * 1 = 10001` refresh attempts per expiry window, which is still too many. You combine XFetch with `singleflight` (flattens to 1 per pod) and possibly a distributed lock (flattens to 1 globally). The three layers multiply to give you `global_refreshes_per_expiry = min(pods, 1 + lambda * delta * beta / pods)` which in practice lands in the single digits. Make sure every staff engineer on your team can reproduce this derivation on a whiteboard.

Soft TTL versus hard TTL is the cleanest operational model. Store two expirations per entry. The soft TTL (for example 50 seconds) is when you start refreshing probabilistically or on first miss. The hard TTL (for example 60 seconds) is when Redis itself evicts. Between soft and hard, you serve the cached value and kick off an async refresh. This is the stale-while-revalidate (SWR) pattern borrowed from RFC 5861 for HTTP. The hot path never blocks on origin. The cold path (hard expiry) should never happen for a hot key because the async refresh beat it. If your async refresh fails, you fall back to serving stale past the hard TTL for a bounded `stale-if-error` window. Facebook's TAO, LinkedIn's Couchbase tier, and Netflix's EVCache all implement variants of this pattern. In EVCache, the moneta pattern splits hot keys across an in-memory L1 and a RocksDB-backed L2 on the same node, with SWR between them, which is what lets Netflix serve petabyte-scale personalization data with single-digit millisecond p99.

The singleflight call in Go has a subtle correctness hazard. `Group.Do` holds only one in-flight call per key, but if that call panics or returns a context-cancellation error, every waiter gets the same error. In a high-fanout service, a single request with a tight deadline can cancel the shared computation for thousands of waiters. The mitigation is to run the fetch with a detached context derived from `context.Background()` (with its own deadline) so the waiter-side cancellation does not kill the origin fetch. Use `group.DoChan` with a `select` on the caller's context for the wait side. This pattern is sometimes called "context decoupling" and is essential for any shared-fate fetch. It applies equally to `sync.Once`-based lazy init where one slow caller should not poison the initialization for others.

Distributed lock correctness. `SETNX` with a TTL is a correct mutual exclusion primitive only if you accept fencing hazards. The classic Martin Kleppmann critique of Redlock applies here. If the lock holder GC-pauses past its lease TTL, another holder acquires the lock, and now two writers think they own it. For cache population this is usually benign (both write the same value) but for write-behind it is fatal. If you need true fencing, issue a monotonic fencing token with every lock acquisition (Redis `INCR` on a token counter) and have the origin or cache check the token on write. For pure read population, accept the hazard, keep the lease short (10 to 30 seconds), and monitor for double-fetch rate. Use Lua scripts for the release path (`if GET == token then DEL`) to avoid releasing someone else's lock after your lease expired.

Hot key detection and mitigation. A stampede is usually a symptom of a hot key. At FAANG scale, 0.01 percent of keys receive 50 percent of traffic (the standard Zipf distribution). Detecting hot keys requires sampled counting. Use a count-min sketch on the cache proxy or a TopK structure (Redis 8 has a native `TOPK` data type from RedisBloom, always on in 8.0) to track the N most-accessed keys in real time. When a key crosses a threshold, promote it to a replicated tier. Options include client-side caching with Redis tracking (`CLIENT TRACKING`), adding an in-process LRU in front of Redis for the top 1000 keys (two-tier L1/L2), or shard-bursting where a hot key is replicated to K replicas and clients hash on `key + random(K)`. Twitter's large-scale cache-cluster analysis (OSDI 2020) and Meta's CacheLib documentation describe these patterns. The shard-bursting approach trades invalidation complexity for horizontal read scaling, and you only pay the cost for detected hot keys, not the whole dataset.

Capacity planning under stampede conditions. The origin database must be sized to handle at least the worst-case concurrent refresh rate, not the steady-state rate. If your stampede protection flattens 100k QPS of misses to 10 concurrent refreshes per expiry window, and you have 10000 distinct hot keys with correlated TTLs, you still see `10000 * 10 = 100k` origin QPS during a synchronized expiry event. The fix is TTL jitter. Apply multiplicative jitter of plus or minus 10 to 20 percent per key so that expiries spread out over time. Do not use additive jitter on short TTLs because it clusters. Do not use jitter that is smaller than your typical fetch latency because you will see overlap. For deploy-time cold starts, stagger warmup by key hash across pods so you do not have 1000 pods each hitting the origin for the same 10000 keys simultaneously.

Observability is non-negotiable. Emit metrics for: cache hit rate per key class, origin fetch latency histogram, `singleflight.shared` fraction (fraction of waiters that rode a dedup), XFetch refresh trigger rate, distributed lock contention count, and negative-cache hit rate. Alert on `shared fraction > 0.5` for any key class, which indicates the cache is barely providing any benefit and the key is a stampede candidate. Alert on origin fetch p99 crossing 2x the XFetch `delta` average, which means `beta` is mistuned and you will start missing expiries.

Failure modes to design for explicitly. Cache unavailable (Redis failover): every request becomes a miss, `singleflight` collapses to one-per-pod, origin sees `pods * distinct_keys` QPS. You need a circuit breaker that rejects cache-required requests past a threshold rather than killing the database. Origin unavailable: stale-while-revalidate saves you for the `stale-if-error` window, but after that you must serve an error or a graceful degraded response. Clock skew on distributed locks: use Redis server time (`TIME` command) for lease calculations, not local time. Poison value in cache: a malformed entry causes deserialization errors on every read, and the stampede protection keeps serving it. Include a schema version in the cached payload and treat version mismatch as a miss with forced refresh.

Interview framing for staff-level. If you are asked to design a cache in front of a read-heavy service, the stampede discussion is your differentiator. Walk the interviewer through: probabilistic early refresh, soft and hard TTL with SWR, per-pod singleflight, cross-pod distributed lock with fencing, TTL jitter, hot-key detection with TopK, shard-bursting for hot keys, negative-cache with short TTL, circuit breaker for cache outage, and observability at every layer. Most candidates stop at "use a mutex." A staff candidate designs the full envelope including the failure recovery path.

---
