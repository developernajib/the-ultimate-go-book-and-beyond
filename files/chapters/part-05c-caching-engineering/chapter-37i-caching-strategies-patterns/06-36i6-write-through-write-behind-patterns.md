## 37I.6 Write-Through & Write-Behind Patterns

### Write-Through and Write-Behind Caches

Pick write-through when **consistency** is the dominant constraint - cached data must match the database at all times and a few extra milliseconds per write are acceptable. Pick write-behind when **write throughput** is the dominant constraint and the application can tolerate a bounded window of durability lag (or compensate for it with a durable buffer such as Redis Streams or Kafka between the cache and the database). For most services, neither applies and plain cache-aside is correct.

Write-through caches update the cache synchronously with every write, guaranteeing strong consistency at the cost of write latency. Write-behind (write-back) decouples the cache update from the database write by buffering mutations asynchronously, improving write throughput at the risk of losing buffered data on crash. Both patterns are implemented below. The `WriteThroughCache` writes to the database first (the authoritative store) then updates the cache. If the cache write fails, the data remains safe in the database and the next read repopulates the cache. The `WriteBehindCache` reverses this: it writes to the cache immediately for low-latency responses, then queues an asynchronous flush to the database. When the queue fills, it falls back to synchronous writes to prevent data loss.

```go
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// WriteThroughCache synchronously writes to both cache and DB
// Use for: high-read, lower-write scenarios where cache miss is expensive
type WriteThroughCache[T any] struct {
	cache  *RedisCache
	db     WriteDB[T]
	ttl    time.Duration
}

type WriteDB[T any] interface {
	Save(ctx context.Context, entity T) error
	Delete(ctx context.Context, id string) error
}

// Save writes to DB first, then updates cache
func (w *WriteThroughCache[T]) Save(ctx context.Context, key string, entity T) error {
	// Write to DB (authoritative)
	if err := w.db.Save(ctx, entity); err != nil {
		return fmt.Errorf("db save: %w", err)
	}

	// Update cache synchronously
	if err := w.cache.Set(ctx, key, entity, w.ttl); err != nil {
		// Log but don't fail - DB is the source of truth
		// Cache will be populated on next read
	}

	return nil
}

// Delete removes from both DB and cache
func (w *WriteThroughCache[T]) Delete(ctx context.Context, key, id string) error {
	if err := w.db.Delete(ctx, id); err != nil {
		return err
	}
	return w.cache.Delete(ctx, key)
}

// WriteBehindCache: writes to cache first, async flush to DB
// Use for: write-heavy workloads where latency is critical
// Risk: data loss if cache node fails before flush
type WriteBehindCache[T any] struct {
	cache    *RedisCache
	db       WriteDB[T]
	writeQ   chan writeBehindOp[T]
	log      *slog.Logger
}

type writeBehindOp[T any] struct {
	key    string
	entity T
	delete bool
}

// NewWriteBehindCache creates write-behind cache with background flusher
func NewWriteBehindCache[T any](cache *RedisCache, db WriteDB[T], queueSize int, log *slog.Logger) *WriteBehindCache[T] {
	w := &WriteBehindCache[T]{
		cache:  cache,
		db:     db,
		writeQ: make(chan writeBehindOp[T], queueSize),
		log:    log,
	}
	go w.flushWorker(context.Background())
	return w
}

// Save writes to cache immediately, queues DB write
func (w *WriteBehindCache[T]) Save(ctx context.Context, key string, entity T, ttl time.Duration) error {
	// Write to cache immediately (low latency path)
	if err := w.cache.Set(ctx, key, entity, ttl); err != nil {
		return fmt.Errorf("cache write: %w", err)
	}

	// Queue async DB write
	select {
	case w.writeQ <- writeBehindOp[T]{key: key, entity: entity}:
	default:
		// Queue full: write synchronously to avoid data loss
		w.log.Warn("write-behind queue full, writing synchronously")
		return w.db.Save(ctx, entity)
	}
	return nil
}

func (w *WriteBehindCache[T]) flushWorker(ctx context.Context) {
	// Batch writes: collect up to 100 items or 100ms
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	var batch []writeBehindOp[T]
	maxBatch := 100

	flush := func() {
		if len(batch) == 0 {
			return
		}
		for _, op := range batch {
			if op.delete {
				if err := w.db.Delete(ctx, op.key); err != nil {
					w.log.Error("write-behind delete failed", "key", op.key, "err", err)
				}
			} else {
				if err := w.db.Save(ctx, op.entity); err != nil {
					w.log.Error("write-behind save failed", "key", op.key, "err", err)
					// TODO: dead letter queue for failed writes
				}
			}
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case op := <-w.writeQ:
			batch = append(batch, op)
			if len(batch) >= maxBatch {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}
```

### Junior to FAANG: Getting Write Patterns Right the First Time

Most first-year engineers default to cache-aside without realizing they have made a choice. Cache-aside means the application reads from cache, falls back to the database on miss, populates the cache, and writes directly to the database while invalidating or refreshing the cache. It is the right default for 90 percent of services. Write-through and write-behind are specialized patterns for specific constraints, and using them in the wrong context creates either a latency regression or a data loss incident.

The core rule of write-through: the database is the source of truth, the cache is a read optimization. You write to the database first. Only after the database commits do you update the cache. If the cache write fails, you swallow the error and log it. The next read will repopulate. Do not reverse this order. Writing to the cache first and then the database creates a window where a reader can see data that will never be persisted if the database write fails and the cache TTL has not yet expired. That is a phantom write, and it is one of the harder bugs to diagnose because the symptom appears hours after the root cause.

The core rule of write-behind: durability has moved from the database to the write queue. The instant you acknowledge a write to the client based only on a cache entry plus an in-memory queue slot, you have promised the client that the data is durable even though it is not. If the process crashes, those buffered writes are gone. Treat this as a durability downgrade and decide explicitly whether your application can tolerate it. For a user's "last active" timestamp on a social feed, losing a few seconds of writes on crash is fine. For a financial transaction, it is catastrophic. Never use write-behind for data that must not be lost, unless your buffer itself is durable (Kafka or Redis Streams with AOF fsync-always).

Worked example for a first-job engineer. You are asked to cache user profile updates. The profile is read 1000 times per second per user but written maybe once per week per user. This is the textbook case for cache-aside, not write-through. Write-through would add a Redis round-trip to every write for no throughput benefit. Now flip the scenario. You are asked to cache click-stream event counters that update 100 times per second per user. This is the case for write-behind, because writing 100 rows per second per user to Postgres will exhaust connection pools, whereas buffering in cache and flushing batches of 1000 every 100ms will coast. But you also need the durability caveat: if the buffer is a plain in-memory channel like in the code above, a pod crash loses up to 100ms of clicks. If that matters, replace the in-memory channel with a Kafka producer and let a separate consumer service handle the flush.

Read the code above with fresh eyes. Spot three junior-trap details. First, the write-through `Save` swallows the cache error silently. That is correct because the database is authoritative, but you must still emit a metric so you can alert on elevated cache write failures. A silent failure rate of 10 percent means your cache hit rate is quietly collapsing. Second, the write-behind `Save` falls back to synchronous DB write when the queue is full. This is the right behavior, but it means your write latency has a bimodal distribution: fast when the queue has slack, slow when it does not. Your p50 is the cache path, your p99 is the DB path. Alert on queue fullness, not on p99 latency in isolation. Third, the flush worker uses `context.Background()` which means it will not honor shutdown. On process termination you lose everything in the queue. Production write-behind must drain the queue on `SIGTERM` before exit. Wire a graceful shutdown that flips the worker context to cancellation and waits for the queue to empty with a bounded timeout.

Interview entry-point. "When would you use write-through versus write-behind versus cache-aside" is a staple question. Answer with the dominant constraint. Write-through when consistency is the constraint and write latency is acceptable to grow by the cache-write cost. Write-behind when write throughput is the constraint and you can absorb a durability window. Cache-aside otherwise. Then name the hybrid: write-around (write to database, skip cache, let next read populate) is useful for write-heavy keys that are rarely read. If you can name all four patterns and match them to constraints, you are already ahead of 80 percent of candidates.

### Senior at FAANG: Durability, Consistency, and the Write-Path Envelope

At staff and principal level the write pattern choice is a distributed systems question about where durability lives, what consistency level clients observe, and how the system recovers after partial failure. The code above is a correct starting point but is missing the production envelope that makes these patterns safe at scale.

Write-through consistency guarantees are weaker than they look. The pattern "write DB, then write cache" is not atomic. Between the two writes there is a window where a concurrent reader that misses the cache will read the new DB value, populate the cache, and then be overwritten by the write-through populate. This is benign for idempotent writes but races for non-idempotent ones. Worse, two concurrent writers can interleave: Writer A writes DB value `v1`, Writer B writes DB value `v2`, B populates cache with `v2`, A populates cache with `v1`, and now the cache has `v1` while the DB has `v2`. This is a lost-update-in-cache and is invisible until the TTL elapses. The fix is either optimistic concurrency (include a version or timestamp in the cached payload, do `SET` only if version is newer, use Redis Lua or `SETIFGT`), or treat the cache write as an invalidation rather than a populate. Invalidate-on-write is almost always the safer pattern. The cache write becomes `DEL key`, and the next read does the populate under single-flight. This eliminates the lost-update race entirely at the cost of one extra origin read per write.

The staleness window of write-through is not zero. It is bounded by the cache write latency after the DB commit. If the cache write takes 5ms, there is a 5ms window where a reader can hit the old cached value after the DB has the new one. For strongly consistent reads you must route through the DB during that window, which defeats the cache. The honest characterization of write-through is "bounded staleness of one cache write latency," not "zero staleness." Publish this number to clients.

Write-behind is a queue engineering problem. The in-memory channel is a toy. Production write-behind uses a durable log (Kafka, Redis Streams with AOF, Pulsar) with at-least-once delivery semantics and idempotent DB writes on the consumer side. The producer side writes the cache and enqueues the log entry in a transaction. If the cache and log are both Redis, use `MULTI`/`EXEC` or a Lua script to make it atomic. If the cache is Redis and the log is Kafka, you have a dual-write problem and must accept eventual consistency or use a transactional outbox (write to DB outbox table, CDC propagates to cache and Kafka). The Netflix EVCache moneta pattern handles this by using RocksDB as a local durable L2, where the cache write is itself durable and the asynchronous DB flush becomes a background replication rather than a data-loss risk.

Batching math for the flush worker. Throughput improves with batch size up to the point where batch latency exceeds the buffering tolerance. If the DB handles 10k inserts/sec single-row and 100k inserts/sec in batches of 100, the break-even point is around batch size 10. Beyond that you gain throughput but add latency. A flush every 100ms with max batch 100 gives you peak throughput of 1000 writes/sec through the queue, which is the bottleneck not the DB. Tune both dimensions together. For a write-heavy service, push batch size to 1000 and flush interval to 10ms so you can sustain 100k writes/sec through one flusher. For multi-key coalescing (many writes to the same key), deduplicate in the queue using a map keyed by entity ID, keeping only the latest value. This turns N writes to the same key into 1 DB write, which is often a 10x to 100x throughput win for hot keys.

Ordering guarantees under write-behind are subtle. If two writes to the same key are enqueued and a third write to a different but related key is enqueued between them, a naive parallel flusher may reorder them. The DB sees `key1=v2, key2=v1, key1=v1` when the application wrote `key1=v1, key2=v1, key1=v2`. For single-key ordering, partition the flush workers by hash of the key, so all writes to one key go through one worker in arrival order. For cross-key ordering, use a single flusher (scalability ceiling) or accept causal consistency only within partitions.

Failure recovery. A write-behind pod that crashes with 10k items in its queue has lost 10k writes from the client's perspective (they were acknowledged). Recovery requires either a durable log (replay on restart), a reconciliation job that periodically diffs cache against DB and flushes missing entries, or accepting the loss. Netflix EVCache and Meta's TAO log-everywhere strategy replicate writes to multiple nodes synchronously before acknowledgment, turning write-behind into a quorum write. This is write-behind-with-quorum, not pure write-behind. The latency is still better than write-through because the quorum is in the cache tier (single-digit ms) not the DB tier (tens of ms).

Dual-write hazard and the CDC alternative. Any time you write to two systems (cache and DB) you have a dual-write problem. The only correct solutions are a transaction across both (rare, expensive), a transactional outbox, or CDC (Change Data Capture). CDC flips the architecture: the application only writes to the DB, a CDC pipeline (Debezium, Maxwell, Postgres logical replication, MySQL binlog, DynamoDB Streams) tails the DB changelog and updates the cache asynchronously. This is strictly stronger than write-through for consistency because the cache update is driven by the actual committed DB state. The latency is similar to write-behind (async, bounded lag) but there is no durability hazard because the DB is the single write target. For any new service at FAANG scale in 2026, CDC-driven cache invalidation is the default. Write-through and write-behind are legacy patterns preserved for services where CDC was not available when they were built.

Observability for write paths. Metrics must include: write latency histogram split by path (cache-only, DB-only, both), write-behind queue depth, queue age at dequeue time, flush batch size distribution, flush failure rate per key class, and lag between cache write and DB commit. Alert on queue age p99 crossing the client-visible durability contract. Alert on flush failure rate above 0.1 percent, which indicates a persistent DB problem that the queue is hiding from users. For write-through, alert on cache-write failure rate, which is a leading indicator of cache tier problems before reads start failing. Trace every write end-to-end with correlation IDs from the client through to DB commit and cache populate.

Interview framing for staff. If asked "implement a write-behind cache" do not just describe a channel and a flusher. Walk through: durability model (in-memory versus durable log), ordering model (per-key partitioned flusher), batching strategy (size and time), failure recovery (graceful drain, reconciliation), backpressure policy (drop, block, fall back to sync), dual-write mitigation (outbox or CDC), and observability. Then mention when you would not build this at all: CDC from the DB is usually the better answer at FAANG scale and moves the durability question back to the DB where it belongs.

---
