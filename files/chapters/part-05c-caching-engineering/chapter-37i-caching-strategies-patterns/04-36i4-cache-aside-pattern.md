## 37I.4 Cache-Aside Pattern

### Full Cache-Aside Implementation

Cache-aside (lazy loading) is the default pattern for read-heavy workloads and the one you should reach for unless you have a specific reason to pick something else. Write-through makes sense when every write must leave the cache consistent and cache misses are disproportionately expensive (e.g., cold reads trigger a heavy join). Write-behind only makes sense when write throughput is the binding constraint and a durable queue stands between the cache and the database to absorb crashes. For everything else - product catalogs, user profiles, feature flags, search results - cache-aside is the right starting point because the application controls exactly what gets cached and when.

The implementation below encapsulates this logic with a two-layer cache (L1 in-process, L2 Redis) and a `GetMany` batch method that minimizes database round-trips by collecting L1 misses, issuing a single Redis `MGet`, and only querying the database for the remaining misses. Note that `getID` is a helper that extracts the ID from the entity type. Implement it using a field accessor or an interface method on your domain type.

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// CacheAsideRepository implements the cache-aside (lazy loading) pattern
// L1: in-process (ristretto) → L2: Redis → L3: PostgreSQL
type CacheAsideRepository[T any] struct {
	l1    *LocalCache[string, T]
	l2    *RedisCache
	db    DBLayer[T]
	l1TTL time.Duration
	l2TTL time.Duration
	log   *slog.Logger
}

// DBLayer is the abstraction for the underlying data source
type DBLayer[T any] interface {
	GetByID(ctx context.Context, id string) (T, error)
	GetByIDs(ctx context.Context, ids []string) ([]T, error)
}

// Get implements cache-aside with two cache layers
func (r *CacheAsideRepository[T]) Get(ctx context.Context, id string) (T, error) {
	cacheKey := r.cacheKey(id)

	// L1: in-process cache
	if val, ok := r.l1.Get(cacheKey); ok {
		return val, nil
	}

	// L2: Redis
	var value T
	if err := r.l2.Get(ctx, cacheKey, &value); err == nil {
		// Populate L1 from L2
		r.l1.Set(cacheKey, value)
		return value, nil
	}

	// L3: Database
	value, err := r.db.GetByID(ctx, id)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("db get: %w", err)
	}

	// Populate caches asynchronously
	r.l1.Set(cacheKey, value)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := r.l2.Set(ctx, cacheKey, value, r.l2TTL); err != nil {
			r.log.Warn("L2 cache set failed", "key", cacheKey, "err", err)
		}
	}()

	return value, nil
}

// GetMany retrieves multiple items, batching cache misses
func (r *CacheAsideRepository[T]) GetMany(ctx context.Context, ids []string) (map[string]T, error) {
	result := make(map[string]T, len(ids))
	var l1Misses []string

	// L1 lookup
	for _, id := range ids {
		if val, ok := r.l1.Get(r.cacheKey(id)); ok {
			result[id] = val
		} else {
			l1Misses = append(l1Misses, id)
		}
	}

	if len(l1Misses) == 0 {
		return result, nil
	}

	// L2 batch lookup
	dests := make([]any, len(l1Misses))
	for i := range l1Misses {
		var v T
		dests[i] = &v
	}
	keys := make([]string, len(l1Misses))
	for i, id := range l1Misses {
		keys[i] = r.cacheKey(id)
	}

	hits, err := r.l2.MGet(ctx, keys, dests)
	if err != nil {
		r.log.Warn("L2 mget failed", "err", err)
		hits = make([]bool, len(l1Misses))
	}

	var dbMisses []string
	for i, hit := range hits {
		id := l1Misses[i]
		if hit {
			v := *dests[i].(*T)
			result[id] = v
			r.l1.Set(r.cacheKey(id), v)
		} else {
			dbMisses = append(dbMisses, id)
		}
	}

	if len(dbMisses) == 0 {
		return result, nil
	}

	// DB batch lookup for remaining misses
	dbResults, err := r.db.GetByIDs(ctx, dbMisses)
	if err != nil {
		return nil, fmt.Errorf("db batch get: %w", err)
	}

	// Populate caches
	for _, item := range dbResults {
		id := getID(item)
		result[id] = item
		r.l1.Set(r.cacheKey(id), item)
	}

	// Async L2 populate
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		pipe := r.l2.client.Pipeline()
		for _, item := range dbResults {
			id := getID(item)
			data, _ := json.Marshal(item)
			pipe.SetEx(ctx, r.cacheKey(id), data, r.l2TTL)
		}
		pipe.Exec(ctx)
	}()

	return result, nil
}

// Invalidate removes an item from all cache layers
func (r *CacheAsideRepository[T]) Invalidate(ctx context.Context, id string) error {
	cacheKey := r.cacheKey(id)
	r.l1.Delete(cacheKey)
	return r.l2.Delete(ctx, cacheKey)
}

func (r *CacheAsideRepository[T]) cacheKey(id string) string {
	return fmt.Sprintf("entity:%s", id)
}

// getID extracts an entity identifier. In production, implement via an interface
// or domain accessor.
func getID[T any](item T) string {
	if ider, ok := any(item).(interface{ GetID() string }); ok {
		return ider.GetID()
	}
	return fmt.Sprint(item)
}
```

### Junior → FAANG: cache-aside as a ladder, not a function

Cache-aside is best visualized as a ladder. Read walks down the ladder from fast to slow: L1, then L2, then origin. Write walks the ladder in reverse for invalidation: origin, then L2, then L1. The write order matters. If you invalidate L1 before L2, a concurrent read can repopulate L1 from a still-stale L2 and the bug loops forever. Always invalidate L2 first, then L1. Better, use a pub/sub bus so every replica invalidates its L1 after the L2 write, which removes the ordering ambiguity.

The second ladder property is that a miss at every layer must populate every layer above the hit on the way back up. The code above does this correctly: an L2 hit populates L1, and a database hit populates both L2 (async) and L1. A common junior mistake is to populate only the layer where the miss began, which leaves the lower layers cold and every subsequent request retraversing the same path.

First-job worked example. Your team's user service implements `GetUser(id)` with cache-aside. QA reports that after an admin edits a user, the change takes up to 10 minutes to appear. Trace: the admin panel writes to Postgres and issues `DEL user:{id}` on Redis. The service reads from L1 first, and the L1 TTL is 10 minutes. The L1 entry was populated before the edit and will not refresh until its TTL fires. Fix: emit a Redis pub/sub message on the `user.invalidate` channel, have every service replica subscribe and call `l1.Delete(cacheKey)` on receipt. After the fix, edits propagate within the pub/sub delivery latency, typically under 100ms.

Interview entry points: draw the cache-aside ladder, explain why async L2 populate is a valid optimization (the next reader still gets a correct result even if the L2 write has not landed yet), and describe the `GetMany` batching strategy above (L1 filter, then L2 MGET for the misses, then DB batch for the L2 misses). Be able to reason about partial failure: if the DB batch succeeds but the L2 async pipeline fails, the result returned to the caller is still correct, and the next reader pays one extra L2 miss. That is the right trade-off for a best-effort cache.

Understand the five formal modes of cache-aside as named patterns: pure read-aside (application does everything), read-through (loader is a cache concern), write-through (write both), write-behind (write one, flush later), and refresh-ahead (proactive rehydrate). Each has a distinct latency, consistency, and failure profile. A senior interviewer will probe whether you pick the right mode for a given workload.

### Senior @ FAANG: the five-mode cache-aside ADR and mesh invalidation

Staff-level cache-aside work is the ADR that selects among the five modes and documents the invalidation mesh. The ADR template below has saved teams from recurring incidents across multiple FAANG cache rewrites.

**Mode 1: read-aside (lazy loading).** Reader populates on miss. Writer invalidates after origin write. Choose for read-dominated workloads with low write rate and tolerant staleness (product catalog, blog posts, search indices). Latency on miss equals cache RTT plus origin RTT plus cache set. Consistency: eventual, bounded by TTL. Failure mode: cache outage degrades to origin-at-full-load.

**Mode 2: read-through.** Cache layer owns the loader. Application calls `cache.Get(key)` and is unaware of the origin. Choose for stable loaders reused widely (ORM-style repositories, shared reference data). Benefits: application code stays clean, loader is centralized and testable. Risks: couples cache to data model, harder to add caller-specific fetch hints.

**Mode 3: write-through.** Writer writes cache and origin synchronously. Origin-first is safer. Choose for workloads where cache-coherence SLA is tight and write rate is moderate (user profile edits, shopping cart updates). Latency: write = origin RTT + cache set. Consistency: strong for the writing session, eventual for remote replicas until their L1 TTL or invalidation fires.

**Mode 4: write-behind (write-back).** Writer writes cache, flushes origin asynchronously. Choose for high write rate plus acceptable data loss window (metrics counters, view counts, last-seen timestamps). Always use a durable queue (Kafka, SQS) as the buffer rather than in-memory queues to survive crashes. Latency: write = cache set. Durability: bounded by queue retention.

**Mode 5: refresh-ahead.** Reader populates on miss and proactively refetches hot entries before expiry. Choose for workloads with sharp hot-key distribution and where boundary-miss latency is unacceptable (homepage feed, top-of-funnel pages). Implement as logical-TTL-plus-physical-TTL. Downside: doubles origin load on hot keys, net-positive only when origin is not the bottleneck.

The ADR must state, per cacheable entity: which mode, TTL values, jitter range, invalidation mechanism, stampede control, negative caching policy, and the fallback on cache failure. Colocate the ADR with the repository code. Review it during every change to the caching layer.

**Mesh invalidation topologies.** Three options, with trade-offs.

*Pub/sub over Redis Keyspace Notifications.* Enable `notify-keyspace-events` on the Redis server, subscribe to `__keyevent@0__:del` and `__keyevent@0__:expired` on every replica, and purge L1 on receipt. Pros: no custom message bus, leverages existing Redis. Cons: lossy under partition, adds load to Redis pub/sub throughput, requires a server-side config change that many managed Redis offerings gate behind support tickets.

*Dedicated pub/sub channel.* Writers explicitly publish to a `cache.invalidate.{namespace}` channel after a successful origin write. Every replica subscribes. Pros: decouples invalidation messages from Redis internals, namespace-scoped, easier to trace. Cons: still lossy under partition, adds one Redis PUBLISH per write.

*Kafka invalidation topic.* Writers publish invalidation events to a Kafka topic partitioned by cache key. Replicas consume with a consumer group per replica (each consumer sees every message). Pros: durable, replayable for cold-start catch-up, scales to millions of invalidations per second. Cons: adds Kafka as a dependency, increases invalidation latency to tens of milliseconds.

**Staff-level ADR for an L1+L2 tiered cache with mesh invalidation** typically picks: read-aside for the default entity repository, write-through for high-coherence entities like auth tokens, write-behind via Kafka for metric counters, refresh-ahead for the top-100 keys of a dashboard, pub/sub invalidation over a dedicated channel for L1 coherence, negative caching with 30 second TTL, TTL jitter at plus-or-minus 20 percent, XFetch probabilistic early expiration on L2 reads, singleflight at L1, cold-start warmer that preseeds L1 from a known hot-key list read out of L2, and a circuit breaker that stops serving through the cache and calls origin directly when cache error rate exceeds 5 percent over a 30 second window (with origin capacity sized to handle at least 30 percent of total traffic uncached as the survivable floor).

**The `GetMany` batch code above** is worth a second read at staff level. The pattern of "filter L1 hits, batch L2 for L1 misses, batch origin for L2 misses" minimizes both RTTs and origin load. The subtlety is that `dests[i].(*T)` assumes `T` is the concrete type the MGet unmarshal populated. If you generalize this to interface types or abstract entities, the pointer trick breaks and you need a different materialization strategy (usually a typed factory function per entity). Note also the async L2 populate after the DB batch: if the caller's context is canceled, the fetch-through path still returns the result because the async goroutine runs on a fresh context with its own timeout. That decoupling is deliberate and is the correct pattern for best-effort cache writes that should not be canceled by a slow client.

**Correctness invariants** to assert in tests: (1) after a Get that missed at every layer, all layers must hold the value (modulo async L2 latency). (2) After an Invalidate, no reader on any replica observes the old value once the invalidation propagates. (3) Under concurrent Get for the same missing key, at most one origin call happens per process (singleflight) and at most a bounded number across the fleet (XFetch or distributed lock). (4) A negative entry must expire in strictly less time than a positive entry, so newly created entities appear within the negative TTL. (5) The cache must never return a value newer than the origin in a way that violates read-your-writes for the writing session, which means the writer must not rely on the local L1 for its own confirmation read after a write.

---
