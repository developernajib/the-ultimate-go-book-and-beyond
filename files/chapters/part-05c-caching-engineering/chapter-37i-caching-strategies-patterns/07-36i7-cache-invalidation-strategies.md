## 37I.7 Cache Invalidation Strategies

### Tag-Based Invalidation

Tag-based invalidation associates cache entries with one or more tags (e.g., `"user:123"`, `"product:456"`) using Redis sets. When an entity changes, calling `InvalidateByTag` deletes every cache entry associated with that tag in a single operation. This avoids the need to track individual cache keys for each entity. The `VersionedCache` below takes an alternative approach: instead of deleting keys, it increments a version counter so that all cache keys containing the old version number become stale automatically. Finally, `CacheInvalidationBus` uses Redis pub/sub to broadcast invalidation events to all application instances, ensuring L1 in-process caches stay synchronized across a multi-node deployment.

```go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TaggedCache supports tag-based invalidation
// When a product changes, invalidate all caches tagged with "product:123"
type TaggedCache struct {
	client *redis.Client
	prefix string
}

// SetWithTags stores a value tagged with multiple tags
func (c *TaggedCache) SetWithTags(ctx context.Context, key string, value any, ttl time.Duration, tags ...string) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	pipe := c.client.Pipeline()

	// Store the value
	pipe.SetEx(ctx, c.key(key), data, ttl)

	// Associate key with each tag
	for _, tag := range tags {
		pipe.SAdd(ctx, c.tagKey(tag), c.key(key))
		pipe.Expire(ctx, c.tagKey(tag), ttl+time.Hour) // tag set expires after content
	}

	_, err = pipe.Exec(ctx)
	return err
}

// InvalidateByTag removes all cache entries associated with a tag
func (c *TaggedCache) InvalidateByTag(ctx context.Context, tag string) error {
	tagKey := c.tagKey(tag)

	// Get all keys associated with this tag
	keys, err := c.client.SMembers(ctx, tagKey).Result()
	if err != nil {
		return err
	}

	if len(keys) == 0 {
		return nil
	}

	// Delete all tagged keys + the tag set
	keys = append(keys, tagKey)
	return c.client.Del(ctx, keys...).Err()
}

// Example: invalidate all user-related caches when user updates
func InvalidateUserCaches(ctx context.Context, cache *TaggedCache, userID string) error {
	// Invalidates: user profile, user orders list, user recommendations
	return cache.InvalidateByTag(ctx, fmt.Sprintf("user:%s", userID))
}

func (c *TaggedCache) key(k string) string    { return c.prefix + ":" + k }
func (c *TaggedCache) tagKey(tag string) string { return c.prefix + ":tag:" + tag }

// VersionedCache: increment version to invalidate all entries for an entity
type VersionedCache struct {
	client *redis.Client
	prefix string
}

// GetVersion retrieves the current version of an entity
func (c *VersionedCache) GetVersion(ctx context.Context, entityType, entityID string) (int64, error) {
	key := fmt.Sprintf("%s:version:%s:%s", c.prefix, entityType, entityID)
	version, err := c.client.Get(ctx, key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return version, err
}

// BumpVersion invalidates all versioned cache entries for an entity
func (c *VersionedCache) BumpVersion(ctx context.Context, entityType, entityID string) (int64, error) {
	key := fmt.Sprintf("%s:version:%s:%s", c.prefix, entityType, entityID)
	return c.client.Incr(ctx, key).Result()
}

// KeyWithVersion generates a version-aware cache key
func (c *VersionedCache) KeyWithVersion(ctx context.Context, baseKey, entityType, entityID string) (string, error) {
	version, err := c.GetVersion(ctx, entityType, entityID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:v%d", baseKey, version), nil
}

// PublishInvalidation uses Redis pub/sub to broadcast invalidation across nodes
type CacheInvalidationBus struct {
	client  *redis.Client
	local   *LocalCache[string, any]
	channel string
}

// Publish sends invalidation message to all subscribers
func (b *CacheInvalidationBus) Publish(ctx context.Context, key string) error {
	return b.client.Publish(ctx, b.channel, key).Err()
}

// Subscribe listens for invalidation messages and evicts from local cache
func (b *CacheInvalidationBus) Subscribe(ctx context.Context) {
	sub := b.client.Subscribe(ctx, b.channel)
	defer sub.Close()

	for msg := range sub.Channel() {
		b.local.Delete(msg.Payload)
	}
}
```

### Junior to FAANG: Why Invalidation Is the Hard Part

Phil Karlton's quote "there are only two hard things in Computer Science: cache invalidation and naming things" is a joke that stops being funny the first time a stale cache entry ships a wrong price to a customer. As a junior engineer, internalize that invalidation is where cache correctness bugs live. Read paths are easy. Write paths are medium. Invalidation is where you earn your seniority.

Start with the four mechanisms. First, TTL-based invalidation relies on a time bound. Set a 60-second TTL and accept up to 60 seconds of staleness. This is the default and it is correct for most read-heavy workloads where slight staleness is acceptable. Second, application-level explicit invalidation means the write path issues an explicit `DEL key` or `SET key newvalue` on every mutation. This gives you bounded staleness equal to your cache write latency, at the cost of coupling the write path to the cache. Third, event-driven invalidation uses a message bus (Redis pub/sub, Kafka, NATS) to broadcast "key X changed" to subscribers, including in-process L1 caches on other pods. Fourth, CDC-driven invalidation tails the database changelog (Debezium on MySQL binlog or Postgres logical replication) and issues cache invalidations from the commit stream. Each mechanism has a latency floor and a correctness contract. Learn them together.

The code above shows three specific patterns. Tag-based invalidation stores a Redis set per tag listing every cached key associated with that tag, so one user update can invalidate all of that user's caches with one call. Versioned caching flips the problem: instead of deleting keys, bump a version counter for an entity and include the version in the cache key. Old-version keys become unreachable and expire naturally under TTL. Pub/sub invalidation broadcasts a key name to every node, and each node drops the matching entry from its L1 cache. Each has tradeoffs. Tag-based pays storage cost for the tag sets and requires transactional set-maintenance. Versioned pays the cost of an extra `GET version` per read (usually pipelined) and leaves stale entries in Redis until TTL. Pub/sub is cheap but not delivery-guaranteed. If a pod misses a pub/sub message (network blip, slow consumer, reconnect), its L1 will serve stale data until TTL.

Worked example. You are caching user profiles with a 10-minute TTL. A user updates their display name at `T=0`. Without explicit invalidation, any pod that had cached the old value continues to serve it until its local TTL expires, up to 10 minutes. With pub/sub invalidation, the write publishes `invalidate user:42` and all pods clear their L1 within milliseconds. With CDC, the Postgres update emits a binlog event, the CDC consumer publishes the invalidation, and the latency depends on the CDC pipeline (usually 100ms to 1s). With versioned keys, the write bumps `user:42:version` from 3 to 4. The next read builds key `user:42:v4` which misses cache, repopulates, and old `user:42:v3` sits in Redis until its TTL expires harmlessly.

Interview entry-point. "How do you invalidate a cache" is a question where juniors answer "delete the key" and seniors answer with the whole taxonomy plus failure modes. Name TTL, explicit DELETE, tag-based, versioned keys, pub/sub fan-out, and CDC. Then name the cache-bust-on-deploy pattern: include a build hash or schema version in the cache key prefix so a deploy automatically orphans all old entries without touching Redis. This is free, ops-friendly, and solves a huge class of "forgot to migrate the cache" bugs.

Common junior mistakes. Calling `KEYS pattern` to find entries to invalidate. Do not. `KEYS` is O(N) over the whole keyspace and locks Redis. Use `SCAN` with cursor iteration or maintain tag sets. Issuing the cache DELETE before the DB write commits, which can race with a concurrent reader repopulating the cache with the old DB value. Always invalidate after commit. Invalidating once on write, because pub/sub is fire-and-forget. If a subscriber was disconnected, it missed the event. Use pub/sub for best-effort fanout and TTL as the correctness backstop. Publishing the full new value on the invalidation channel. Publish only the key name. Let each subscriber decide whether to repopulate lazily or refetch eagerly.

### Senior at FAANG: Invalidation as a Distributed Systems Problem

At staff and principal level, cache invalidation is a consensus problem disguised as a plumbing problem. The question is not "how do I delete a key" but "how do I guarantee that every cache layer converges to the new value within a bounded time while the system is under partial failure." The code in this file is a reasonable starting kit but is only part of the full production envelope.

Start with the invalidation contract. Every cache tier must publish two numbers: the worst-case staleness bound and the convergence time under failure. Worst-case staleness is the time between a committed DB write and the oldest possible cache observation of the new value. Convergence time is the time until all caches have the new value under normal operation. These are different numbers. Under normal operation, a pub/sub invalidation converges in milliseconds. Under a network partition that blocks pub/sub, convergence degrades to TTL, which might be minutes. Without a TTL backstop, convergence is unbounded. Every cache tier in production must have a TTL backstop, no exceptions. Event-driven invalidation is an optimization on top of TTL, never a replacement for it.

CDC is the gold standard at FAANG scale and deserves its own analysis. Debezium on MySQL binlog or Postgres logical replication gives you an ordered, committed-only, at-least-once stream of row changes. You run a consumer per cache cluster that translates row changes into cache invalidations. The latency floor is typically 100 to 500 milliseconds end-to-end. The durability property is critical: the CDC stream contains only committed changes, so you never invalidate based on an uncommitted write that might roll back (a classic dual-write hazard). LinkedIn's Databus, Airbnb's SpinalTap, Meta's Wormhole, and Netflix's DBLog are all variations of this architecture. For a new service, adopt Debezium Server or Postgres logical replication over `pgoutput` and standardize the schema of cache invalidation events across the company. Make the event format explicit: `{"entity": "user", "id": "42", "op": "update", "tx_lsn": "0/3A4B5C6D", "committed_at": "2026-04-22T..."}`. Include the LSN so consumers can detect gaps and replay.

Ordering and causality. If `user:42` is updated at `T=0` and `user:42:friends` is updated at `T=1ms` and both emit invalidations, a reader that sees the second invalidation before the first can populate the friends cache with a value that references an old user version. This is a causal consistency violation. Fix by including version vectors or monotonic commit timestamps in the cache value itself and rejecting populates that would move a key backwards in version. In Redis this is a Lua script that does `SET` only if the embedded version is greater than the existing one. Meta's TAO and DynamoDB's strongly consistent reads address this by making the cache aware of write ordering.

Thundering invalidation. Invalidating a hot key with 100k QPS triggers a stampede immediately after the invalidation lands. The mitigation is invalidate-and-populate-atomically: the writer computes the new value and does `SET key newvalue EX ttl` in a single operation, so readers see the new value directly with no miss. This turns invalidation into refresh. Combine with versioned payloads to avoid lost-update races. For cases where you cannot compute the new value on the write path (expensive derivation), use invalidate-to-sentinel: set the key to a sentinel like `REFRESHING` with a short TTL, and have the single-flight path re-derive and populate. Readers that see the sentinel wait for a short interval rather than stampeding the origin.

Pub/sub fanout is not reliable. Redis pub/sub is fire-and-forget with no persistence. A subscriber that disconnects loses messages. Under Redis cluster failover, subscribers must reconnect to the new primary and can miss events during the transition. For strict correctness, use Redis Streams with consumer groups (persistent, ack-based) or a real message bus (Kafka, Pulsar, NATS JetStream). For best-effort L1 invalidation with a TTL backstop, pub/sub is fine. Make the tradeoff explicit in the design doc. Redis 8.0 client-side caching (`CLIENT TRACKING` with broadcasting mode or key-range mode) moves this burden onto the Redis server, which maintains the subscription state and pushes invalidations over a dedicated channel. This is the recommended pattern for in-process L1 caches as of 2026.

Tag-based invalidation at scale has a fan-out problem. A user-updated event invalidates 50 cached aggregations that reference the user. Each invalidation hits Redis. A popular user (a celebrity, an admin, a shared resource) can trigger tens of thousands of invalidations per write. Mitigate with versioned references: instead of invalidating aggregations, bump the referenced version and let the aggregation cache detect the version mismatch on next read and recompute. This moves the cost from the write path to the read path, which is usually the right tradeoff because writes are rarer than reads. For tag sets, use Redis sharded pub/sub in cluster mode and ensure tag keys are colocated with their referenced data keys via hash tags `{user:42}:tag` so that `SMEMBERS` and `DEL` can execute in a single cluster slot.

Cache-bust on deploy. Include a build identifier or schema version in every cache key prefix. When you deploy a version that changes the serialization format, the old keys are unreachable and get naturally evicted via LRU or TTL. This avoids the classic deploy disaster where a new binary reads an old cached payload and panics on unmarshal. Pair with a forward-compatible serialization format (Protobuf with unknown-field-tolerance, JSON with tolerant parsers) so that during rolling deploys, old and new pods can share the cache without corruption. At Meta scale, cache-bust uses a content hash of the source schema as the prefix, so the invalidation is automatic on any schema change.

Negative cache invalidation. When a read misses the DB, you cache a sentinel ("not found") to prevent DoS-via-cache-miss on hot keys. That sentinel must be invalidated when the entity is later created, otherwise the creation is invisible to readers for up to the negative TTL. Include negative entries in your invalidation schema and always invalidate on insert, not just on update and delete. This is a common omission in production invalidation layers.

Reconciliation is the last line of defense. Every serious cache tier needs a periodic sweep that compares a sample of cache entries against the DB and reports divergence. Run it continuously as a background job at low priority. Alert on divergence rate above a threshold (typically 0.01 percent). This catches bugs in the invalidation logic itself, missed events, pub/sub gaps, CDC pipeline issues, and schema mismatches. Netflix runs reconciliation on EVCache at every layer, and the reconciliation metrics are treated as SLIs. At any time your divergence rate tells you whether your invalidation envelope is actually holding.

Interview framing for staff. When asked "design cache invalidation for a large system" do not start with DELETE. Start with the convergence and staleness contracts. Enumerate TTL, explicit, pub/sub, CDC. Discuss ordering and causal consistency. Cover hot-key and celebrity-fanout. Talk about reconciliation. Mention Redis 8 client-side caching tracking mode as the 2026 default for L1 sync. Close with deploy-time cache-bust as a freebie. The candidate who frames invalidation as a convergence problem instead of a delete problem signals staff-level thinking immediately.

---
