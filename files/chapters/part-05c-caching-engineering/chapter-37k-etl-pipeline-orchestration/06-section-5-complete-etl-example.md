## Section 5: Complete ETL Example

### 5.1 User Events to Analytics Warehouse

`RunUserEventsPipeline` wires a Kafka consumer to a Postgres analytics table through three stages: extraction (consuming `UserEvent` messages from Kafka with consumer-group offset management), transformation (normalizing property maps to a flat schema), and batch loading (accumulating rows and flushing to Postgres with `COPY FROM` for throughput). A dead-letter queue channel captures malformed or unprocessable events so that poison messages do not stall partition progress.

```go
package etl

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// UserEvent represents a raw event from the app.
type UserEvent struct {
	EventID   string                 `json:"event_id"`
	UserID    string                 `json:"user_id"`
	EventType string                 `json:"event_type"`
	Properties map[string]any `json:"properties"`
	OccurredAt time.Time              `json:"occurred_at"`
}

// RunUserEventsPipeline extracts user events from Kafka, transforms,
// deduplicates, and loads to Postgres analytics table.
func RunUserEventsPipeline(ctx context.Context, kafkaBrokers []string, db *sql.DB) error {
	// Dead letter queue
	dlqFile, err := NewFileDLQ("./dlq/user-events.jsonl")
	if err != nil {
		return fmt.Errorf("create DLQ: %w", err)
	}
	defer dlqFile.Close()

	// Checkpoint store
	ckStore, err := NewFileCheckpointStore("./checkpoints/user-events.json")
	if err != nil {
		return fmt.Errorf("checkpoint store: %w", err)
	}

	// Extract from Kafka
	extractor := NewKafkaExtractor(kafkaBrokers, "user-events", "etl-analytics")
	source, err := extractor.Extract(ctx)
	if err != nil {
		return fmt.Errorf("extract: %w", err)
	}

	// Build pipeline
	pipeline := NewPipeline("user-events-to-analytics", dlqFile)

	// Stage 1: Validate required fields
	pipeline.AddStage(NewValidateStage("validate", []ValidationRule{
		{Field: "event_id", Required: true, Type: "string", MaxLen: 64},
		{Field: "user_id", Required: true, Type: "string", MaxLen: 64},
		{Field: "event_type", Required: true, Type: "string", MaxLen: 128},
	}))

	// Stage 2: Deduplicate (within 24-hour window)
	pipeline.AddStage(NewDeduplicateStage("dedup", 24*time.Hour))

	// Stage 3: Filter bot events
	pipeline.AddStage(NewFilterStage("filter-bots", func(r Record) bool {
		if ua, ok := r.Data["user_agent"].(string); ok {
			return !strings.Contains(strings.ToLower(ua), "bot")
		}
		return true
	}))

	// Stage 4: Enrich with derived fields
	pipeline.AddStage(NewMapStage("enrich", func(r Record) (Record, error) {
		eventType, _ := r.Data["event_type"].(string)

		// Add categorical fields
		r.Data["event_category"] = categorizeEvent(eventType)
		r.Data["is_conversion"] = isConversionEvent(eventType)

		// Normalize timestamp
		if r.Timestamp.IsZero() {
			r.Data["occurred_at"] = time.Now().Format(time.RFC3339)
		} else {
			r.Data["occurred_at"] = r.Timestamp.Format(time.RFC3339)
		}

		r.Data["loaded_at"] = time.Now().Format(time.RFC3339)
		return r, nil
	}))

	// Stage 5: Batch load to Postgres
	loader := NewPostgresLoader(db, "analytics.user_events",
		[]string{"event_id", "user_id", "event_type", "event_category", "is_conversion", "properties", "occurred_at", "loaded_at"},
		1000,
	).WithUpsert([]string{"event_id"})

	// Start pipeline + loader concurrently
	final := make(chan Record, 1024)
	errCh := make(chan error, 2)

	go func() {
		errCh <- pipeline.Run(ctx, source, final)
		close(final)
	}()

	go func() {
		errCh <- loader.Load(ctx, final)
	}()

	// Wait for both to complete
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil && err != context.Canceled {
			return err
		}
	}

	return nil
}

func categorizeEvent(eventType string) string {
	switch {
	case strings.HasPrefix(eventType, "page_"):
		return "navigation"
	case strings.HasPrefix(eventType, "click_"):
		return "interaction"
	case strings.HasPrefix(eventType, "purchase_"):
		return "conversion"
	case strings.HasPrefix(eventType, "error_"):
		return "error"
	default:
		return "other"
	}
}

func isConversionEvent(eventType string) bool {
	conversions := []string{"purchase_completed", "subscription_started", "trial_converted"}
	for _, c := range conversions {
		if eventType == c {
			return true
		}
	}
	return false
}
```

### Junior → FAANG: Reading an end-to-end pipeline like a staff engineer

When you see a complete ETL example like the one above, the junior instinct is to read it line by line and move on. The senior instinct is to ask five questions before reading any code. Where is the watermark and how does it advance. What is the unit of atomicity (per record, per batch, per stage). What happens if the process dies after step N but before step N+1. Which stages are CPU-bound and which are I/O-bound. What is the tail-latency budget for the whole pipeline. Reading the code above through those five questions turns it from a tutorial into a design critique.

Watermark and offset management. The code uses `NewKafkaExtractor` with a consumer group `etl-analytics`, which means Kafka itself tracks the offset per partition. The offset commit happens when the consumer acknowledges, and the critical question is whether the acknowledgment happens before or after the Postgres load commits. In this code, it happens before, because the goroutines are decoupled through the `final` channel. That is at-least-once, not exactly-once. If Postgres commit fails after Kafka offset advances, those records are lost. The fix for exactly-once is to defer Kafka offset commit until after the Postgres transaction commits, which requires threading an ack callback through the pipeline or using Kafka transactions.

Worked example for your first job. You are handed this code and asked "what breaks if we 10x the traffic?" Answer in this order. First, the dedup stage holds a 24-hour window of event IDs in memory. At 10k events per second times 86400 seconds, that is 864 million IDs, which will OOM the process. Fix: move dedup to Redis with TTL, or push it down into Postgres via `ON CONFLICT (event_id) DO NOTHING`. Second, the Postgres loader batch size of 1000 with upsert on `event_id` will saturate the primary. Fix: stage into an unindexed partition, then MERGE during a maintenance window. Third, the single `final` channel of size 1024 becomes a backpressure bottleneck. Fix: partition the loader across N goroutines keyed by `user_id` hash. Giving that answer in a system design interview is the difference between "junior" and "hire."

Interview entry-point. "Walk me through this pipeline and tell me three things you would change for production." Always answer with (1) a correctness concern (the offset-commit ordering above), (2) a scale concern (the in-memory dedup window), and (3) an operational concern (no metrics emission, no DLQ rate alert, no schema-drift guard). Interviewers are testing whether you can see the gaps, not whether you can recite the code.

### Senior @ FAANG: Real-world reference architecture, Postgres CDC to Kafka to Flink to ClickHouse

The example above is a teaching pipeline. The reference architecture you will actually build or inherit at a FAANG in 2026 looks like this. Postgres OLTP as source of truth. Debezium or a custom CDC connector reading the WAL and publishing to Kafka with one topic per table and partition key equal to the primary key. Kafka as the durable event log with 7-day retention and tiered storage to S3 for longer history. Flink as the stateful stream processor doing joins, windowed aggregations, and schema normalization. ClickHouse as the analytical sink with `ReplacingMergeTree` for dedupe and `AggregatingMergeTree` for rollups. OpenLineage events emitted from every stage to Marquez for lineage and impact analysis. Each segment of that pipeline has non-obvious design decisions that separate senior work from junior work.

Postgres CDC details. Logical replication slots in Postgres 16 and 17 leak WAL if the consumer is down, and a stuck slot will fill the disk and crash the primary. The senior setup uses `pg_replication_slot_advance` on a watchdog cron, plus a monitoring metric `pg_replication_slot_lag_bytes` with a page at 10 GB. Publication filters (`CREATE PUBLICATION ... FOR TABLE`) limit which tables are streamed to keep volume bounded, and column filters (Postgres 15+) strip PII before it leaves the database. Debezium emits `before` and `after` images for updates, which you need for correct downstream joins. Snapshot mode (`initial_only`, `never`, `when_needed`) is a deploy-time decision that a junior engineer gets wrong by picking `initial` on a 2 TB table and blocking replication for 14 hours.

Kafka as the spine. Partition count is set by peak throughput divided by per-partition consumer throughput (typically 10 to 50 MB/s), rounded up to leave 2x headroom. Replication factor 3 with `min.insync.replicas=2` and producer `acks=all` is the durable default. `compression.type=zstd` at level 3 on the producer gives 3 to 5x compression over uncompressed JSON with negligible CPU. Tiered storage (Kafka 3.9+) lets you set local retention to 24 hours and remote retention to 30 days on S3, which cuts broker disk cost by 10 to 20x for long-retention topics. Schema Registry with Protobuf or Avro is mandatory. JSON topics are an anti-pattern at FAANG scale because they have no backward-compatibility enforcement and no wire-level type safety.

Flink transformations. The stateful work that a Go pipeline cannot do well lives in Flink. Event-time windowed aggregations with watermark generation, interval joins between two streams, and CEP pattern matching all require aligned checkpoints and managed state. Flink's `RocksDB` state backend with incremental checkpoints to S3 is the production default. Checkpoint interval of 1 minute with a 30-second alignment timeout is the standard starting point. The `TwoPhaseCommitSinkFunction` is how you get end-to-end exactly-once into Kafka or JDBC sinks, and getting it right requires understanding the pre-commit, commit, and abort phases of the Flink checkpoint protocol. This is textbook senior-level material and is a common Staff-level interview topic at Meta, Uber, and Netflix.

ClickHouse as the sink. `ReplacingMergeTree` with a version column gives you dedupe by primary key, but the dedupe happens at merge time, not at query time, so queries must use `FINAL` or `argMax(col, version)` to get the latest row. `AggregatingMergeTree` with materialized views pre-aggregates to hourly and daily rollups, cutting query cost by 10 to 100x for dashboards. Partition by `toYYYYMM(event_date)` and `ORDER BY (tenant_id, event_date, user_id)` is the canonical layout for multi-tenant analytics. Inserts must be batched to at least 1000 rows and ideally 100k rows because ClickHouse creates one part per insert and background merges cannot keep up with small inserts, leading to `Too many parts` errors.

OpenLineage and Marquez for data lineage. Every Flink job, DBT model, and loader emits `OpenLineage` events (`START`, `COMPLETE`, `FAIL`) with input and output dataset references and column-level lineage facets. Marquez ingests these events and exposes a GraphQL API plus a UI that answers "if I change column X in source table Y, what downstream dashboards and ML features are affected." At FAANG scale this is not optional, because a schema change without lineage impact analysis is how you take down the CFO's revenue dashboard. The 2026 standard is OpenLineage 1.x with the `ColumnLineageDatasetFacet` and `DataQualityAssertionsDatasetFacet` enabled.

Idempotency and replay at the architecture level. Every stage must be replayable from a checkpoint without producing duplicate side effects. Kafka replay is trivial (reset consumer group offset). Flink replay requires a savepoint and the guarantee that all downstream sinks are idempotent. ClickHouse replay requires `ReplacingMergeTree` plus a deterministic version column, typically the Kafka offset or the Postgres LSN. The replay drill (take a 1-hour outage, replay from 2 hours ago, verify downstream counts and sums match within epsilon) must be run quarterly in a staging environment. Teams that skip this drill discover in production that their "idempotent" pipeline was never actually idempotent.

Cost accounting. A pipeline of this shape processing 1 billion events per day in 2026 typically costs 40 to 80 USD per day in Kafka (MSK tiered storage), 30 to 60 USD in Flink on Kinesis Data Analytics or a self-managed cluster, 100 to 300 USD in ClickHouse compute and storage, plus S3 and egress. The senior review question is cost per million events and cost per query, tagged by business domain. If those metrics are not on a dashboard, FinOps will come for you.

---

