## 37E.6 Batch Operations

### Logged vs Unlogged Batches

Cassandra batch statements group related mutations that share the same partition key, ensuring atomicity within a partition at no extra latency cost. The code below demonstrates logged and unlogged batches and warns against cross-partition batches that can cause coordinator hotspots.

```go
package cassandra

import (
	"context"
	"fmt"
	"time"

	"github.com/gocql/gocql"
)

// BatchProcessor handles bulk write operations
type BatchProcessor struct {
	session *gocql.Session
}

// LoggedBatch: atomic within a single partition (Cassandra guarantees all-or-nothing)
// Use for: multi-table writes that must be consistent (rare case)
// AVOID for: performance optimization - logged batches are SLOWER than individual writes
func (p *BatchProcessor) WriteOrderToMultipleTables(ctx context.Context, order OrderByUser) error {
	batch := p.session.NewBatch(gocql.LoggedBatch).WithContext(ctx)

	// Table 1: orders by user
	batch.Query(
		`INSERT INTO orders_by_user (user_id, created_at, order_id, status, total_cents) VALUES (?, ?, ?, ?, ?)`,
		order.UserID, order.CreatedAt, order.OrderID, order.Status, order.TotalCents,
	)

	// Table 2: orders by id
	batch.Query(
		`INSERT INTO orders_by_id (order_id, user_id, created_at, status, total_cents) VALUES (?, ?, ?, ?, ?)`,
		order.OrderID, order.UserID, order.CreatedAt, order.Status, order.TotalCents,
	)

	// Table 3: orders by status
	batch.Query(
		`INSERT INTO orders_by_status_date (status, date_bucket, created_at, order_id, user_id, total_cents) VALUES (?, ?, ?, ?, ?, ?)`,
		order.Status, toDateBucket(order.CreatedAt), order.CreatedAt, order.OrderID, order.UserID, order.TotalCents,
	)

	return p.session.ExecuteBatch(batch)
}

// UnloggedBatch: NO atomicity guarantee, but better performance for same-partition writes
// Best use case: bulk insert to same partition
func (p *BatchProcessor) BulkInsertSensorReadings(ctx context.Context, readings []SensorReading) error {
	if len(readings) == 0 {
		return nil
	}

	const maxBatchSize = 100 // avoid coordinator memory pressure

	for i := 0; i < len(readings); i += maxBatchSize {
		end := min(i+maxBatchSize, len(readings))

		batch := p.session.NewBatch(gocql.UnloggedBatch).WithContext(ctx)
		for _, r := range readings[i:end] {
			batch.Query(
				`INSERT INTO sensor_readings (sensor_id, day, timestamp, temperature, humidity, pressure) VALUES (?, ?, ?, ?, ?, ?)`,
				r.SensorID, toDateBucket(r.Timestamp), r.Timestamp,
				r.Temperature, r.Humidity, r.Pressure,
			)
		}

		if err := p.session.ExecuteBatch(batch); err != nil {
			return fmt.Errorf("batch insert chunk %d: %w", i/maxBatchSize, err)
		}
	}
	return nil
}

// CounterBatch: for counter column updates
func (p *BatchProcessor) IncrementPageViews(ctx context.Context, pageID gocql.UUID, viewerCountry string) error {
	batch := p.session.NewBatch(gocql.CounterBatch).WithContext(ctx)

	// Total page views
	batch.Query(`UPDATE page_stats SET total_views = total_views + 1 WHERE page_id = ?`, pageID)

	// Views by country
	batch.Query(`UPDATE page_views_by_country SET views = views + 1 WHERE page_id = ? AND country = ?`,
		pageID, viewerCountry)

	return p.session.ExecuteBatch(batch)
}

type SensorReading struct {
	SensorID    gocql.UUID `db:"sensor_id"`
	Day         string     `db:"day"`
	Timestamp   time.Time  `db:"timestamp"`
	Temperature float32    `db:"temperature"`
	Humidity    float32    `db:"humidity"`
	Pressure    float32    `db:"pressure"`
}

func toDateBucket(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}
```

### Junior to FAANG: batches are not transactions

The single most common misunderstanding in first interviews is that a Cassandra BATCH behaves like a SQL transaction. It does not. A LOGGED batch gives atomicity (all writes eventually apply or none do), but it does not give isolation. A reader can observe a partial state mid-batch. An UNLOGGED batch gives neither. The junior-to-FAANG mental reset is simple: a batch is a coordinator-side grouping primitive, not an ACID boundary. Before running your first batch in production, practice two worked examples. First, write the same denormalized row to three tables for a single user action. That is the LOGGED batch use case where you accept the latency cost to avoid partially denormalized state. Second, bulk insert 500 sensor readings for the same `sensor_id` partition. That is the UNLOGGED single-partition case where the batch becomes one coordinator mutation packet and you save network round trips. Interview entry point: be able to explain why the second case is the only batch pattern that improves throughput, and why batching across `sensor_id` values makes throughput worse rather than better.

### Senior at FAANG: batch cost model and the LOGGED batch anti-pattern

The staff-level review of batch usage turns on three mechanics. First, LOGGED batch atomicity is implemented by writing the batch to the `system.batches` distributed log on two batchlog replicas before any mutation reaches its target replicas. On success the coordinator removes the batchlog entry. On partial failure a replay coordinator picks up the batchlog entry after `batchlog_replay_throttle` and re-issues the unapplied mutations. This means a LOGGED batch pays two extra durable writes on unrelated nodes before it even begins. Second, when a LOGGED batch spans N partitions, the coordinator becomes the fan-out point for N independent replica sets. The coordinator holds the batch in memory, serializes it to the batchlog, and then issues writes. CPU and heap pressure on that coordinator scale linearly with partition count, which is why operators see tail latency spikes and `WriteTimeoutException` on batches above roughly 10 partitions or 5 KB of aggregate mutation size. Cassandra 5.0 logs `BatchStatement of prepared statements ... is of size ... exceeding specified threshold of batch_size_warn_threshold_in_kb` for exactly this reason.

The anti-pattern is using LOGGED batches as a throughput optimization. Engineers coming from relational systems assume that batching reduces round trips and therefore improves performance. In Cassandra the opposite holds for any batch that crosses partitions. Each mutation still fans out to its own replica set, so network amplification is identical to individual writes, but now it is serialized through one coordinator plus the batchlog tax. The correct performance pattern is client-side parallelism: fire N async prepared statements against the driver's token-aware routing, letting each mutation hit the correct replica directly. The `gocql` driver with `TokenAwareHostPolicy` wrapping `RoundRobinHostPolicy` plus `NewExecutableQuery` executed concurrently will beat any cross-partition batch on both throughput and tail latency. Reserve LOGGED batches strictly for denormalization atomicity, where the cost is the point.

UNLOGGED single-partition batches are the one genuine performance win, because the coordinator routes the entire batch to the partition owner as a single mutation. Size bounds still matter. Set `batch_size_warn_threshold_in_kb` at 5 and `batch_size_fail_threshold_in_kb` at 50 in `cassandra.yaml`, then enforce a batch size cap in your driver wrapper and a mutation count cap (typically 100 as in the snippet above). Counter batches deserve a warning of their own. Counters are not idempotent, so a retried counter mutation can double-increment. CounterBatch improves atomicity within a partition but does nothing for the retry hazard. In production, treat counters as approximate and reconcile against an append-only event log for anything financial. In ScyllaDB 6.0 the batch semantics are identical but the batchlog replay uses Raft-coordinated group 0 metadata, which reduces the window where a coordinator crash leaves a batchlog entry in limbo. Staff-level interview signal: diagram the coordinator fan-out for a 10-partition LOGGED batch, identify the batchlog replicas, and propose the token-aware parallel alternative with back-pressure via a semaphore.

---
