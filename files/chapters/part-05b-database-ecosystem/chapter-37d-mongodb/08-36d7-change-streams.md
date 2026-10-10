## 37D.7 Change Streams

### Requirements and Semantics

Change streams require a replica set or sharded cluster (the oplog is the underlying data source) and a read concern of `majority` or higher. Events are delivered *at-least-once*: the consumer must persist the resume token *after* successfully processing each event and use it on reconnect via `SetResumeAfter` or `SetStartAfter`. Exactly-once consumption is the consumer's responsibility. Typical strategies are idempotent handlers (keyed by `_id` + `clusterTime`), a dedup cache in Redis, or an outbox table that records processed tokens in the same transaction as the downstream write. Resume tokens expire when the oplog horizon passes their cluster time, so persist them frequently for lagging consumers and size the oplog for at least 24-72 hours of retention.

### Real-Time Event Processing

Change streams open a long-lived cursor on a collection's oplog, delivering real-time insert, update, replace, and delete events as typed `ChangeEvent` structs. The resume token stored with each event allows the consumer to reconnect after a network failure without replaying already-processed events, making change streams a reliable foundation for event-driven architectures.

```go
package mongodb

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ChangeEvent represents a MongoDB change stream event
type ChangeEvent[T any] struct {
	ID            bson.Raw              `bson:"_id"`       // resume token
	OperationType string                `bson:"operationType"`
	FullDocument  T                     `bson:"fullDocument"`
	DocumentKey   bson.D                `bson:"documentKey"`
	UpdateDesc    *UpdateDescription    `bson:"updateDescription,omitempty"`
	ClusterTime   bson.Timestamp        `bson:"clusterTime"`
	Namespace     Namespace             `bson:"ns"`
}

type UpdateDescription struct {
	UpdatedFields   bson.Raw `bson:"updatedFields"`
	RemovedFields   []string `bson:"removedFields"`
}

type Namespace struct {
	Database   string `bson:"db"`
	Collection string `bson:"coll"`
}

// ChangeStreamWatcher watches for changes with resume capability
type ChangeStreamWatcher[T any] struct {
	collection  *mongo.Collection
	log         *slog.Logger
	resumeToken bson.Raw
}

// Watch starts watching a collection for changes
func (w *ChangeStreamWatcher[T]) Watch(ctx context.Context, handler func(ChangeEvent[T]) error) error {
	// Pipeline to filter events (optional)
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "operationType", Value: bson.D{{Key: "$in", Value: bson.A{"insert", "update", "replace", "delete"}}}},
		}}},
	}

	opts := options.ChangeStream().
		SetFullDocument(options.UpdateLookup). // get full doc on update
		SetFullDocumentBeforeChange(options.WhenAvailable)

	// Resume from last processed position if available
	if w.resumeToken != nil {
		opts.SetResumeAfter(w.resumeToken)
	}

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		stream, err := w.collection.Watch(ctx, pipeline, opts)
		if err != nil {
			w.log.Error("change stream open failed", "err", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
				continue
			}
		}

		if err := w.processStream(ctx, stream, handler); err != nil {
			w.log.Error("change stream error", "err", err)
			stream.Close(ctx)
			// Update resume token before reconnecting
			if w.resumeToken != nil {
				opts.SetResumeAfter(w.resumeToken)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (w *ChangeStreamWatcher[T]) processStream(
	ctx context.Context,
	stream *mongo.ChangeStream,
	handler func(ChangeEvent[T]) error,
) error {
	defer stream.Close(ctx)

	for stream.Next(ctx) {
		var event ChangeEvent[T]
		if err := stream.Decode(&event); err != nil {
			w.log.Error("decode change event", "err", err)
			continue
		}

		if err := handler(event); err != nil {
			w.log.Error("handle change event",
				"operation", event.OperationType,
				"err", err,
			)
			// Depending on requirements: continue or return error
			continue
		}

		// Update resume token after successful processing
		w.resumeToken = stream.ResumeToken()
	}

	if err := stream.Err(); err != nil {
		return fmt.Errorf("stream error: %w", err)
	}
	return nil
}

// NotificationService defines methods for sending customer alerts
type NotificationService interface {
	SendOrderConfirmation(Order) error
	SendShippingNotification(Order) error
}

// SearchIndexService defines methods for updating external search indices
type SearchIndexService interface {
	IndexOrder(Order) error
	RemoveOrder(bson.ObjectID) error
}

// OrderEventProcessor processes order change events
type OrderEventProcessor struct {
	watcher     *ChangeStreamWatcher[Order]
	notifier    NotificationService
	searchIndex SearchIndexService
	log         *slog.Logger
}

func (p *OrderEventProcessor) Start(ctx context.Context) error {
	return p.watcher.Watch(ctx, p.handleEvent)
}

func (p *OrderEventProcessor) handleEvent(event ChangeEvent[Order]) error {
	switch event.OperationType {
	case "insert":
		// New order: send confirmation email
		return p.notifier.SendOrderConfirmation(event.FullDocument)

	case "update", "replace":
		// Status change: notify customer
		if event.FullDocument.Status == "shipped" {
			return p.notifier.SendShippingNotification(event.FullDocument)
		}
		// Sync to search index
		return p.searchIndex.IndexOrder(event.FullDocument)

	case "delete":
		// Remove from search index
		docID := event.DocumentKey[0].Value.(bson.ObjectID)
		return p.searchIndex.RemoveOrder(docID)
	}
	return nil
}

// Database-level change stream (watch all collections)
func WatchDatabase(ctx context.Context, db *mongo.Database, log *slog.Logger) error {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "ns.coll", Value: bson.D{{Key: "$in", Value: bson.A{"orders", "users", "products"}}}},
		}}},
	}

	stream, err := db.Watch(ctx, pipeline, options.ChangeStream().SetFullDocument(options.UpdateLookup))
	if err != nil {
		return fmt.Errorf("watch database: %w", err)
	}
	defer stream.Close(ctx)

	for stream.Next(ctx) {
		var event bson.M
		if err := stream.Decode(&event); err != nil {
			log.Error("decode db event", "err", err)
			continue
		}
		log.Info("database change",
			"collection", event["ns"].(bson.M)["coll"],
			"operation", event["operationType"],
		)
	}
	return stream.Err()
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

Think of change streams as a managed tail of the oplog with a cursor API. If you have worked with Postgres logical replication slots or Kafka Connect, the mental model is similar. If you have not, the prerequisite you need is an understanding of the oplog itself. The oplog is a capped collection on every replica set member. Every write is recorded there with a `clusterTime` timestamp and an operation type. Change streams filter this feed, attach resume tokens, and hand you typed events.

A first-job use case is syncing MongoDB rows into a search index. Your senior tells you "when an order ships, update OpenSearch". The naive implementation is to call both MongoDB and OpenSearch from the handler that marks the order shipped. That is a dual-write problem. If OpenSearch is down, your data drifts. The change stream pattern fixes this. You write only to MongoDB in the request handler, and a separate consumer reads the change stream and updates OpenSearch idempotently. A worked skeleton looks like:

```go
stream, _ := col.Watch(ctx, mongo.Pipeline{},
    options.ChangeStream().SetFullDocument(options.UpdateLookup))
for stream.Next(ctx) {
    var ev struct{ FullDocument Order `bson:"fullDocument"` }
    stream.Decode(&ev)
    search.Index(ev.FullDocument)
    saveToken(stream.ResumeToken())
}
```

The interview entry point is usually "how does the consumer recover from a crash". The answer is the resume token. You persist it after processing each event, and on restart you pass it to `SetResumeAfter`. If the token is older than the oplog window, it is invalid and you must do a full resync. Being able to articulate the at-least-once contract and the idempotent-handler requirement is typically enough for a mid-level interview.

### Senior at FAANG: Staff and Principal Material

Production change-stream systems at scale live or die by oplog sizing, resume-token hygiene, and downstream backpressure. A staff engineer should be fluent in the following.

**Resume tokens and the oplog window.** A resume token encodes a `BinData` keyString that the server uses to re-seek the oplog. If your consumer is down longer than the oldest oplog entry, the token is unusable and you get `ChangeStreamHistoryLost`. Size the oplog by measured write rate plus a margin, not by a default. On write-heavy shards we have seen oplogs of 200 GB sized explicitly because the recovery SLO required 48 hours of lag tolerance. Expose `oplog window` as a first-class SLI and alert when it drops below twice the consumer restart budget.

**Post-images since MongoDB 6.0.** `SetFullDocumentBeforeChange(WhenAvailable)` requires `changeStreamPreAndPostImages: true` on the collection. Post-images, along with `updateDescription.updatedFields`, give you a true CDC record with both before and after state. This is critical for building materialized views, correct `UPDATE` events in downstream Kafka, and field-level audit. The cost is additional oplog and a side collection (`system.preimages`), which retains images for `expireAfterSeconds`. Budget for it explicitly.

**Debezium MongoDB connector and Kafka CDC.** Debezium consumes change streams and publishes Kafka records using a schema-compatible envelope. At staff level know: Debezium stores its own offset in Kafka Connect, not in your application, so the resume token is managed for you but you lose direct control. Transformations like `ExtractNewDocumentState` unwrap the `fullDocument` envelope. For sharded clusters Debezium opens a single cluster-level change stream, and the connector snapshots collections before it starts streaming. A single Debezium task is the ordering boundary, so if you need strict per-key ordering downstream, key the Kafka topic by `documentKey._id`.

**Global watermark and multi-shard ordering.** A cluster-level change stream on a sharded cluster interleaves events from all shards using a global logical clock. The server waits up to `maxAwaitTimeMS` for the slowest shard to produce an event or a noop so the watermark can advance. If one shard is idle, the watermark stalls, and your downstream consumer sees apparent "lag" that is actually a correctness guarantee. To diagnose, watch `operationTime` in `$currentOp` on each shard and confirm the config server's cluster-time heartbeats. The workaround for intentionally idle shards is to enable `writePeriodicNoops`, which ticks the oplog every ten seconds.

**Backpressure and fan-out.** A single Go consumer is a single point of throughput. For cross-region fan-out the mature pattern is: change stream to internal Kafka, Kafka to many consumers, each idempotent, each with its own offset. Putting downstream HTTP calls directly in the change-stream loop will cause oplog-window alerts the first time a partner API slows down. At principal level you should be able to sketch an SLO-driven design: p99 event-to-delivery latency, maximum acceptable oplog consumption, and the autoscaling signal (lag derivative) that triggers consumer scale-out.

**The transactional outbox.** When a transaction writes both business state and an `outbox` document, a change-stream consumer publishes the outbox entry and then deletes or marks it. This gives you exactly-once semantics at the business-event level without XA or Saga orchestration. It is the default answer in senior interviews for "how do you publish events consistently with MongoDB writes".

---
