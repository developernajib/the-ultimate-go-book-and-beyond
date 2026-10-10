## 37J.2 Event-Driven Cache Invalidation

### Kafka-Based Invalidation Pipeline

The Kafka-based invalidation pipeline treats cache eviction as a first-class domain event: each `InvalidationEvent` carries an `EntityType`, `EntityID`, surrogate `Tags` for CDN purging, and a monotonic `Version` field so consumers can drop out-of-order messages. The consumer runs in a separate goroutine pool and calls both Redis `DEL` (for application-layer caches) and the CDN purge API atomically, ensuring that a product update clears all cache tiers before new requests arrive.

```go
package invalidation

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

// InvalidationEvent represents a cache invalidation message
type InvalidationEvent struct {
	EventID    string    `json:"event_id"`
	EntityType string    `json:"entity_type"` // "product", "user", "order"
	EntityID   string    `json:"entity_id"`
	Action     string    `json:"action"`      // "update", "delete", "create"
	Tags       []string  `json:"tags"`        // surrogate keys for CDN
	Timestamp  time.Time `json:"timestamp"`
	Version    int64     `json:"version"`     // for ordering
}

// InvalidationPublisher publishes cache invalidation events
type InvalidationPublisher struct {
	producer *kgo.Client
	topic    string
	log      *slog.Logger
}

// Publish sends an invalidation event for an entity
func (p *InvalidationPublisher) Publish(ctx context.Context, entityType, entityID, action string) error {
	event := InvalidationEvent{
		EventID:    generateID(),
		EntityType: entityType,
		EntityID:   entityID,
		Action:     action,
		Tags:       buildTags(entityType, entityID),
		Timestamp:  time.Now().UTC(),
		Version:    time.Now().UnixNano(),
	}

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Use entityID as partition key for ordered delivery per entity
	record := &kgo.Record{
		Topic: p.topic,
		Key:   []byte(entityType + ":" + entityID),
		Value: data,
	}

	return p.producer.ProduceSync(ctx, record).FirstErr()
}

// buildTags generates surrogate keys for CDN purging
func buildTags(entityType, entityID string) []string {
	tags := []string{
		fmt.Sprintf("%s:%s", entityType, entityID),
	}

	// Add parent entity tags for cascading invalidation
	switch entityType {
	case "product":
		tags = append(tags, "products") // invalidate product listing pages
	case "order":
		// Orders affect user's order history
		// entityID is "userID:orderID"
		parts := strings.SplitN(entityID, ":", 2)
		if len(parts) == 2 {
			tags = append(tags, fmt.Sprintf("user:%s:orders", parts[0]))
		}
	case "user":
		tags = append(tags, fmt.Sprintf("user:%s", entityID))
	}
	return tags
}

// InvalidationConsumer processes invalidation events
type InvalidationConsumer struct {
	consumer  *kgo.Client
	redis     *redis.Client
	cdnPurger CDNPurger
	localEvict func(key string) // L1 cache eviction
	log       *slog.Logger
}

// CDNPurger abstracts CDN-specific purge operations
type CDNPurger interface {
	PurgeBySurrogateKey(ctx context.Context, tags []string) error
	PurgeByURL(ctx context.Context, urls []string) error
}

// Start begins consuming invalidation events
func (c *InvalidationConsumer) Start(ctx context.Context) error {
	for {
		fetches := c.consumer.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return nil
		}

		fetches.EachPartition(func(p kgo.FetchTopicPartition) {
			for _, record := range p.Records {
				if err := c.processEvent(ctx, record.Value); err != nil {
					c.log.Error("process invalidation event",
						"offset", record.Offset,
						"err", err,
					)
				}
			}
		})
	}
}

func (c *InvalidationConsumer) processEvent(ctx context.Context, data []byte) error {
	var event InvalidationEvent
	if err := json.Unmarshal(data, &event); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}

	// 1. Evict from L1 (in-process) cache - broadcast to all app instances via pub/sub
	cacheKey := fmt.Sprintf("%s:%s", event.EntityType, event.EntityID)
	c.localEvict(cacheKey)

	// 2. Delete from Redis (L2)
	redisKeys := buildRedisKeys(event.EntityType, event.EntityID)
	if len(redisKeys) > 0 {
		if err := c.redis.Del(ctx, redisKeys...).Err(); err != nil {
			c.log.Warn("redis delete failed", "keys", redisKeys, "err", err)
		}
	}

	// 3. Purge CDN (L3) - async to not block
	go func() {
		pCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if len(event.Tags) > 0 {
			if err := c.cdnPurger.PurgeBySurrogateKey(pCtx, event.Tags); err != nil {
				c.log.Error("cdn purge failed", "tags", event.Tags, "err", err)
			}
		}
	}()

	c.log.Info("cache invalidated",
		"entity_type", event.EntityType,
		"entity_id", event.EntityID,
		"action", event.Action,
	)
	return nil
}

func buildRedisKeys(entityType, entityID string) []string {
	switch entityType {
	case "product":
		return []string{
			fmt.Sprintf("product:%s", entityID),
			fmt.Sprintf("product:%s:details", entityID),
			fmt.Sprintf("product:%s:inventory", entityID),
		}
	case "user":
		return []string{
			fmt.Sprintf("user:%s", entityID),
			fmt.Sprintf("user:%s:profile", entityID),
			fmt.Sprintf("user:%s:orders", entityID),
		}
	}
	return []string{fmt.Sprintf("%s:%s", entityType, entityID)}
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
```

### Junior → FAANG: reading this pipeline the way an interviewer wants

First time you see this code it looks like five things at once. Break it down. There is a producer that emits a JSON event to Kafka with the entity key as the partition key. There is a consumer that reads events and does three things in order: evict from an in-process map, delete from Redis, purge from the CDN. The partition key `entityType:entityID` is the single most important line in the file and interviewers will zero in on it. Kafka guarantees ordering only within a partition, so by hashing all events for "product:42" to the same partition you guarantee that a later UPDATE invalidation for product 42 is never processed before an earlier one, even though the consumer pool runs many workers in parallel. Miss that line and your pipeline silently reorders invalidations under load, which produces the worst kind of bug: correct most of the time, wrong exactly when a user is watching. The second thing to notice is the async CDN purge inside a goroutine with its own timeout context. The author did that because CDN purge latency is tens to hundreds of milliseconds and blocking the Kafka consumer on it would collapse throughput. The trade-off is that if the CDN purge fails, the Kafka offset is already committed and you have lost the invalidation. A junior writes this and moves on. A strong candidate notices the gap and proposes fixing it (a dead-letter topic, a retry with exponential backoff, or deferring the offset commit until the CDN call succeeds). That observation is the difference between "knows Go" and "thinks about distributed systems," and it is exactly what the interviewer is probing for.

### Senior @ FAANG: outbox, CDC, ordering, and the at-least-once discipline

The pipeline above publishes directly from the application. That is a dual-write and it is wrong at scale, because a crash between the DB commit and the Kafka publish leaves you with a committed change that no cache ever learns about. The production pattern is the transactional outbox. Inside the same DB transaction that updates the product row, insert a row into an `outbox` table with the entity ID, action, and payload. Debezium (or a similar CDC connector) tails the Postgres WAL using logical replication, reads committed outbox rows in commit order, and emits them to Kafka. This gives you exactly-once from the application's point of view (the DB commit is the single source of truth) and at-least-once from Kafka downward, which is the correct layering. The event schema in the snippet uses `time.Now().UnixNano()` as a version, which is fine for a toy but unsafe in production because clocks drift and two writers on different nodes can collide. Use the database's transaction ID, a sequence, or an application-level monotonic counter per aggregate. Consumers must be idempotent because at-least-once delivery will replay events, sometimes minutes after the original during a consumer lag spike. DEL is naturally idempotent, but if you ever evolve to "write-update" semantics (pushing the new value into the cache instead of deleting) you reintroduce ordering hazards and you must gate the write on `Version > stored_version`. Causal consistency is the next layer up. A user who just clicked Save expects their next GET to reflect the write, even though invalidation is asynchronous. Solutions include a read-your-writes cookie that bypasses cache for N seconds for that session, a version token returned on write and sent on subsequent reads, or sticky sessions that route the user back to the same app node which invalidated its own L1 first. Tag-based invalidation is the final lever and it is where CDN integration earns its keep. A single product update purges `product:42`, `products`, `category:electronics`, `search:iphone`, and `sitemap:products`, atomically across every PoP, because Cloudflare's tag purge API accepts a list and fans out. The consumer code should build this tag set from a declarative map owned by the team that writes the cache keys, not hard-coded in the invalidation service, so that adding a new cached view does not require changing the invalidation pipeline. That ownership boundary is what keeps the system maintainable as the number of cached surfaces grows from tens to thousands.

---
