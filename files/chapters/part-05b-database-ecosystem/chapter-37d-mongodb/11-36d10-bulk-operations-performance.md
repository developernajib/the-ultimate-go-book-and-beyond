## 37D.10 Bulk Operations & Performance

### Bulk Write with BulkWrite API

Bulk writes batch multiple insert, update, and delete operations into a single round trip, dramatically reducing latency when processing large datasets. The following code constructs an ordered `BulkWrite` call with upserts and partial-failure handling suitable for ETL pipelines.

```go
package mongodb

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// BulkProcessor handles high-throughput write operations
type BulkProcessor struct {
	collection *mongo.Collection
	batchSize  int
}

// UpsertProducts bulk upserts products from external feed
func (p *BulkProcessor) UpsertProducts(ctx context.Context, products []Product) (*BulkResult, error) {
	models := make([]mongo.WriteModel, 0, len(products))

	for _, prod := range products {
		filter := bson.D{{Key: "sku", Value: prod.SKU}}
		update := bson.D{{Key: "$set", Value: prod}}

		model := mongo.NewUpdateOneModel().
			SetFilter(filter).
			SetUpdate(update).
			SetUpsert(true)

		models = append(models, model)
	}

	// Process in batches
	var totalResult BulkResult
	for i := 0; i < len(models); i += p.batchSize {
		end := i + p.batchSize
		if end > len(models) {
			end = len(models)
		}
		batch := models[i:end]

		opts := options.BulkWrite().SetOrdered(false) // parallel execution
		result, err := p.collection.BulkWrite(ctx, batch, opts)
		if err != nil {
			// Check for partial success
			var bulkErr mongo.BulkWriteException
			if errors.As(err, &bulkErr) {
				totalResult.Errors = append(totalResult.Errors, bulkErr.WriteErrors...)
			} else {
				return &totalResult, fmt.Errorf("bulk write batch %d: %w", i/p.batchSize, err)
			}
		}

		if result != nil {
			totalResult.Inserted += result.InsertedCount
			totalResult.Updated += result.ModifiedCount
			totalResult.Upserted += result.UpsertedCount
		}
	}

	return &totalResult, nil
}

// DeleteOldDocuments uses deleteMany with index support
func DeleteOldDocuments(ctx context.Context, coll *mongo.Collection, cutoff time.Time) (int64, error) {
	result, err := coll.DeleteMany(ctx, bson.D{
		{Key: "created_at", Value: bson.D{{Key: "$lt", Value: cutoff}}},
		{Key: "status", Value: "archived"},
	})
	if err != nil {
		return 0, fmt.Errorf("delete old: %w", err)
	}
	return result.DeletedCount, nil
}

type BulkResult struct {
	Inserted int64
	Updated  int64
	Upserted int64
	Errors   []mongo.BulkWriteError
}

// Connection pool monitoring
func MonitorPool(ctx context.Context, client *mongo.Client) {
	// Use ServerMonitor for pool events
	// (configured at client creation time via SetPoolMonitor)
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

Bulk operations feel like an optimization, but at FAANG scale they are how you survive. The prerequisite to understand is round-trip cost. A single `UpdateOne` over TLS to a primary in another availability zone is one to three milliseconds of network plus server work. Ten thousand of those is twenty to thirty seconds of wall clock even if the server itself is idle. `BulkWrite` amortises this by sending all ten thousand operations in one TCP exchange.

A worked first-job example: you get a CSV of a hundred thousand product updates from a supplier every morning. The naive loop is `for _, p := range products { coll.UpdateOne(ctx, ...) }`. This runs for ten minutes and times out some requests. The bulk version below runs in under ten seconds:

```go
models := make([]mongo.WriteModel, 0, len(products))
for _, p := range products {
    models = append(models, mongo.NewUpdateOneModel().
        SetFilter(bson.D{{"sku", p.SKU}}).
        SetUpdate(bson.D{{"$set", p}}).
        SetUpsert(true))
}
_, err := coll.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
```

The interview entry point is always "what is the difference between ordered and unordered bulk writes". Ordered stops on the first error and returns. Unordered continues through all operations and reports every error at the end. Use ordered when later operations depend on earlier ones. Use unordered for independent upserts, which is the common case, because it lets the server parallelise across shards.

### Senior at FAANG: Staff and Principal Material

**The per-batch limits.** A single `BulkWrite` is capped by `maxWriteBatchSize` (default 100,000 operations) and `maxBsonObjectSize` (16 MB for the whole command). The driver splits large input automatically, but silently, so if you care about atomicity boundaries, batch explicitly. In sharded clusters each batch is further split per shard by `mongos`, so a hundred-thousand-op bulk against ten shards becomes ten parallel operations of ten thousand.

**InsertMany versus BulkWrite.** `InsertMany` is a subset of `BulkWrite` with fewer code paths and slightly lower overhead. Use it when you really are only inserting. For mixed workloads (insert + update + delete on the same collection in one trip) `BulkWrite` is the only API that preserves operation order within the trip when `Ordered(true)` is set.

**Ordered unordered and failure semantics.** In an ordered bulk, a single write error fails the batch at that operation and returns. Everything before is applied. Everything after is skipped. In unordered, every operation is attempted, errors are accumulated in `BulkWriteException.WriteErrors`, and the `BulkWriteResult` tells you how many actually applied. Both behaviors require the consumer to be idempotent if retried. Key your upserts on a natural ID (`sku`, `external_id`) so replays converge.

**Connection pool sizing and congestion.** Go driver v2 defaults to `maxPoolSize: 100`. A bulk-write-heavy service with fifty goroutines each doing large bulks will saturate the pool and queue. Symptoms are rising `WaitQueueTimeoutError` and p99 latency spikes. Instrument with `SetPoolMonitor` and export `checkedOut`, `waitQueueSize`, and `connectionCount` to Prometheus. Size the pool at roughly 2x expected concurrency, not more, because each connection consumes a server-side thread in the default `mongod` threading model.

**Index maintenance cost during bulk writes.** Every index on the target collection pays write amplification. A collection with ten indexes pays roughly 10x the WiredTiger cache pressure on a bulk insert compared to an unindexed collection. For ETL-style loads the production pattern is: load into a staging collection, build indexes once at the end with `createIndexes` (parallel, background), then `renameCollection` with `dropTarget: true` to swap. This is faster and causes less cache churn than loading into the live collection under its full index set.

**Write concern interplay with bulk.** `w:majority` on a bulk of a hundred thousand ops still means one majority acknowledgment for the whole bulk, not per operation, so durability latency is the slowest replica's commit time for the final op. `j:true` forces a journal fsync. For high-throughput ingest where losing a few seconds of the tail is acceptable, `w:1, j:false` is faster but requires the application to tolerate primary failover data loss. This is a documented trade-off that belongs in an ADR.

**Aggregation with `$merge` for server-side bulk.** For transformations already expressible as aggregations, `$merge` writes results back into a collection without round-tripping through the client. This is the MongoDB equivalent of `INSERT INTO ... SELECT` and is the fastest path for bulk derived-data refresh. Pair with `$out` when you want to replace the collection atomically rather than merge.

**Backpressure.** A bulk producer reading from Kafka or S3 can overwhelm a MongoDB primary. Enforce backpressure with a semaphore sized to the pool, a per-batch ack, and an adaptive batch size that shrinks on rising replication lag (`rs.printReplicationInfo()` or `replSetGetStatus`). Principal-level design includes a circuit breaker on `WriteConflict` rate and a dead-letter collection for poison batches.

---
