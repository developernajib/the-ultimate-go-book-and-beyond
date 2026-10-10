## Section 4: Change Data Capture (CDC)

### 4.1 The CDC landscape in 2026

CDC turns your existing OLTP database into a streaming source without forcing application code to dual-write. Three pieces matter:

- **Debezium** remains the canonical open-source CDC framework. It runs as a Kafka Connect connector (or now, standalone as Debezium Server) and reads change events from MySQL binlog, PostgreSQL logical replication slots, MongoDB oplog, and SQL Server CDC tables. Output goes to Kafka, Pulsar, Kinesis, or cloud PubSub.
- **Postgres logical replication slots** are the substrate Debezium's Postgres connector sits on. You can also read the slot directly using `pgoutput` or `wal2json` with the `pglogrepl` Go library, skipping Kafka Connect entirely when you want tighter control or a lighter deployment.
- **Managed alternatives**: AWS DMS, Google Datastream, Fivetran HVR, and newcomers like Streamkap and Sequin wrap CDC with hosted infrastructure. They trade control for operations.

The dual-write problem is the reason CDC exists. If your service writes a row to Postgres and then publishes an event to Kafka in application code, the two writes are not atomic: a crash between them leaves the system inconsistent. CDC flips this: the database is the only write target, and the WAL is the source of truth for downstream consumers. The Transactional Outbox pattern (write events to an `outbox` table in the same transaction, CDC picks them up) is a common hybrid for when you want explicit event semantics rather than raw row diffs.

> **Senior track**: Postgres logical replication has two concrete operational traps. (1) If a consumer falls behind, the replication slot holds back WAL truncation and the WAL directory grows unbounded until the disk fills. Always monitor `pg_replication_slots.restart_lsn` lag. (2) Schema changes (DDL) are not captured by default. Adding a column to a replicated table and not updating the publication means the new column is silently missing from downstream events.

Change Data Capture (CDC) extracts row-level changes from a database's write-ahead log and streams them as events, enabling downstream consumers to react to data changes without polling. The integration below uses Debezium-compatible PostgreSQL logical replication to stream changes into a Go consumer that updates downstream caches and search indices.

```go
package cdc

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// DebeziumEvent is the message format Debezium publishes to Kafka.
type DebeziumEvent struct {
	Schema  DebeziumSchema  `json:"schema"`
	Payload DebeziumPayload `json:"payload"`
}

type DebeziumSchema struct {
	Type   string `json:"type"`
	Name   string `json:"name"`
	Fields []DebeziumField `json:"fields"`
}

type DebeziumField struct {
	Type     string `json:"type"`
	Optional bool   `json:"optional"`
	Field    string `json:"field"`
}

type DebeziumPayload struct {
	Before  map[string]any `json:"before"`
	After   map[string]any `json:"after"`
	Source  DebeziumSource         `json:"source"`
	Op      string                 `json:"op"` // c=create, u=update, d=delete, r=read(snapshot)
	TsMs    int64                  `json:"ts_ms"`
}

type DebeziumSource struct {
	Version  string `json:"version"`
	Connector string `json:"connector"`
	Name     string `json:"name"`
	TsMs     int64  `json:"ts_ms"`
	Snapshot bool   `json:"snapshot"`
	DB       string `json:"db"`
	Schema   string `json:"schema"`
	Table    string `json:"table"`
	TxID     *int64 `json:"txId"`
	LSN      *int64 `json:"lsn"`
}

// CDCEvent is the normalized CDC event consumed by our application.
type CDCEvent struct {
	Table     string
	Operation string // INSERT, UPDATE, DELETE, SNAPSHOT
	Before    map[string]any
	After     map[string]any
	OccurredAt time.Time
	LSN       int64
}

// DebeziumConsumer processes Debezium-format CDC events from Kafka.
type DebeziumConsumer struct {
	brokers  []string
	topics   []string
	handlers map[string]CDCHandler
	mu       sync.RWMutex
}

// CDCHandler processes CDC events for a specific table.
type CDCHandler func(ctx context.Context, event CDCEvent) error

func NewDebeziumConsumer(brokers []string) *DebeziumConsumer {
	return &DebeziumConsumer{
		brokers:  brokers,
		handlers: make(map[string]CDCHandler),
	}
}

// OnTable registers a handler for changes to a specific table.
func (c *DebeziumConsumer) OnTable(table string, handler CDCHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[table] = handler
	c.topics = append(c.topics, "dbserver1.public."+table)
}

// Start begins consuming CDC events.
func (c *DebeziumConsumer) Start(ctx context.Context, groupID string) error {
	if len(c.topics) == 0 {
		return fmt.Errorf("no topics registered")
	}

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:  c.brokers,
		GroupID:  groupID,
		MinBytes: 1,
		MaxBytes: 10 << 20,
		MaxWait:  500 * time.Millisecond,
	})

	// Subscribe to all registered topics
	// (kafka-go doesn't support dynamic topic subscription - use GroupTopics)
	_ = reader // In production: use sarama or confluent-kafka for multi-topic

	defer reader.Close()

	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("fetch CDC message: %w", err)
		}

		if err := c.processMessage(ctx, msg); err != nil {
			fmt.Printf("CDC process error: %v\n", err)
		}

		reader.CommitMessages(ctx, msg)
	}
}

func (c *DebeziumConsumer) processMessage(ctx context.Context, msg kafka.Message) error {
	if len(msg.Value) == 0 {
		return nil // tombstone (delete marker in compacted topic)
	}

	var debeziumEvent DebeziumEvent
	if err := json.Unmarshal(msg.Value, &debeziumEvent); err != nil {
		return fmt.Errorf("unmarshal debezium event: %w", err)
	}

	table := debeziumEvent.Payload.Source.Table
	op := operationStr(debeziumEvent.Payload.Op)

	event := CDCEvent{
		Table:      table,
		Operation:  op,
		Before:     debeziumEvent.Payload.Before,
		After:      debeziumEvent.Payload.After,
		OccurredAt: time.UnixMilli(debeziumEvent.Payload.TsMs),
	}
	if debeziumEvent.Payload.Source.LSN != nil {
		event.LSN = *debeziumEvent.Payload.Source.LSN
	}

	c.mu.RLock()
	handler, ok := c.handlers[table]
	c.mu.RUnlock()

	if !ok {
		return nil // no handler for this table
	}

	return handler(ctx, event)
}

func operationStr(op string) string {
	switch op {
	case "c":
		return "INSERT"
	case "u":
		return "UPDATE"
	case "d":
		return "DELETE"
	case "r":
		return "SNAPSHOT"
	default:
		return op
	}
}

// EventStore represents an event store capable of loading and appending domain events.
type EventStore interface {
	Append(ctx context.Context, aggregateID string, events []DomainEvent, expectedVersion int64) error
	Load(ctx context.Context, aggregateID string) ([]DomainEvent, error)
}

// DomainEvent represents a domain event produced from CDC.
type DomainEvent struct {
	ID            string          `json:"id"`
	AggregateID   string          `json:"aggregate_id"`
	AggregateType string          `json:"aggregate_type"`
	EventType     string          `json:"event_type"`
	Version       int64           `json:"version"`
	Payload       json.RawMessage `json:"payload"`
	OccurredAt    time.Time       `json:"occurred_at"`
}

// CDCToEventStream converts CDC events into domain events for event sourcing.
func CDCToEventStream(ctx context.Context, consumer *DebeziumConsumer, store EventStore) {
	consumer.OnTable("orders", func(ctx context.Context, event CDCEvent) error {
		if event.Operation == "SNAPSHOT" {
			return nil // skip snapshot
		}

		var domainEventType string
		switch event.Operation {
		case "INSERT":
			domainEventType = "OrderCreatedViaCDC"
		case "UPDATE":
			domainEventType = "OrderUpdatedViaCDC"
		case "DELETE":
			domainEventType = "OrderDeletedViaCDC"
		}

		payload, _ := json.Marshal(map[string]any{
			"before": event.Before,
			"after":  event.After,
		})

		orderID := ""
		if event.After != nil {
			if id, ok := event.After["id"].(string); ok {
				orderID = id
			}
		} else if event.Before != nil {
			if id, ok := event.Before["id"].(string); ok {
				orderID = id
			}
		}

		if orderID == "" {
			return nil
		}

		domainEvent := DomainEvent{
			ID:            fmt.Sprintf("cdc-%d", event.LSN),
			AggregateID:   orderID,
			AggregateType: "Order",
			EventType:     domainEventType,
			Payload:       payload,
			OccurredAt:    event.OccurredAt,
		}

		// Load current version first for optimistic concurrency
		events, _ := store.Load(ctx, orderID)
		version := int64(len(events))

		domainEvent.Version = version + 1
		return store.Append(ctx, orderID, []DomainEvent{domainEvent}, version)
	})
}
```

### Junior → FAANG: CDC for First-Job Engineers

CDC is the pattern that junior engineers meet second (after plain HTTP APIs) when they join a team of any meaningful scale, and it is one of the most interview-legible topics because the motivation is concrete and easy to explain. The prerequisite gap is usually the write-ahead log itself. A junior who has only used a database through an ORM may not realize that Postgres, MySQL, and SQL Server each write every change to a durable log before the row is updated, and that this log is replayed on crash recovery and streamed to replicas for high availability. CDC piggybacks on that same log. You are not adding new infrastructure to the database, you are subscribing to a stream the database already produces for its own reasons.

The dual-write problem is the single clearest motivation for CDC and the one you should be able to articulate in an interview in under a minute. A service writes a row to Postgres and then publishes a message to Kafka. These two writes are not atomic. If the process crashes between them, the row is in the database but the downstream consumer never hears about it. Retrying the Kafka publish on restart risks double-publishing. Two-phase commit across a database and a message broker is operationally toxic. CDC solves this by making the database the only write target. The WAL already records the fact. Debezium reads the WAL, publishes to Kafka, and every downstream consumer sees the same ordered stream the database itself would replay. You will be asked this question. Rehearse the answer.

Worked example for a first job. A product team owns a `users` table in Postgres. The search team wants a user name search backed by Elasticsearch. The naive solution is to add an `es.Index()` call in the user update handler. This dual-writes. Every code path that updates a user must remember. New columns added in migrations are forgotten. A background job that runs an `UPDATE` in bulk skips the indexing entirely. The CDC solution is a Debezium Postgres connector that tails the replication slot, publishes row changes to a Kafka topic, and a Go consumer (like `DebeziumConsumer` above) indexes into Elasticsearch. Now every write path, including manual SQL, flows into the index. Your first ticket on this kind of team will often be writing the consumer for a new downstream. The code pattern is the `OnTable` registration above. Read it until it is boring.

First-job context. If you are hired onto a data platform or infrastructure team at a FAANG, expect Debezium, Kafka Connect, and replication slot management to be part of your on-call. The operational gotchas in section 4.1 (unbounded WAL growth when a consumer lags, silent schema drift on DDL) are the ones that wake you up. Managed alternatives (Fivetran log-based, AWS DMS, Google Datastream) shift the operational burden but do not remove it: you still own the source database's replication slot budget and the downstream schema contract.

### Senior @ FAANG: CDC, Lakehouse Integration, and the Operational Surface That Bites

At the staff level CDC is a platform decision, not a service decision. You are picking a tool chain that will ingest every OLTP write across dozens of services, land them in analytics and search, and carry the compliance weight of being the canonical change feed. The tool landscape in 2026 has three distinct zones. Open source self-hosted: Debezium 2.7 running on Kafka Connect, Flink CDC 3.x (which bundles Debezium engines into Flink connectors for stream-native ingestion), and direct `pgoutput` readers built on `pglogrepl` or Java's PgJDBC. Commercial managed: Fivetran HVR for the enterprise data warehouse market, AWS DMS and its successor DMS Serverless for AWS-native shops, Google Datastream, and Striim. Newer specialized vendors: Streamkap, Sequin, Estuary Flow, and Materialize's own source connectors. The pick depends on where the data lands and who is on call.

Debezium connectors deserve a precise mental model. The Postgres connector creates a logical replication slot and a publication, then streams `pgoutput` decoded messages out of the slot, normalizing each to the Debezium envelope (`before`, `after`, `source`, `op`, `ts_ms`). The MySQL connector reads the binlog in row format. The MongoDB connector reads the oplog or change streams. The SQL Server connector reads the native CDC tables. Each connector publishes to a Kafka topic per table by default, and the single-message transformations (SMTs) let you reshape the envelope, route to different topics, mask fields, or drop columns before the message reaches consumers. The two SMTs worth memorizing are `ExtractNewRecordState` (unwraps the envelope into a flat row, because most downstream consumers do not want the before/after wrapper) and `outbox.EventRouter` (for the transactional outbox pattern, which routes rows from an outbox table to per-aggregate topics with the aggregate ID as the Kafka key).

Replication slot management is the single most operationally dangerous part of the stack. A logical replication slot in Postgres retains WAL segments until the consumer has acknowledged them. If the consumer stops, the slot pins `restart_lsn` and the WAL directory grows without bound. On a busy OLTP primary, the disk fills in hours. Production hygiene requires four controls. First, alert on `pg_replication_slots.restart_lsn` lag in bytes, with warning around 1 GB and page at 10 GB against the primary's WAL retention. Second, alert on slot inactivity: `active = false` for longer than a threshold means the consumer died. Third, a replication slot auto-drop runbook for disaster scenarios where the primary must be saved and the slot rebuilt from a new snapshot. Fourth, a separate small-disk WAL archive volume so slot growth does not compete with the main data volume for space. Kafka Connect is no gentler: Connect workers store offsets in a Kafka topic, and a botched offset reset replays years of history into downstream, which is sometimes the correct recovery and sometimes a self-inflicted outage.

Schema evolution across CDC is where teams that thought they were done get surprised. A DDL `ALTER TABLE users ADD COLUMN phone TEXT` does not automatically appear in the replication stream. Postgres publications default to the set of columns at creation time unless you configured `FOR ALL TABLES` with `publish_via_partition_root` and include the right options. Debezium 2.x detects schema changes through a separate schema history topic, but the downstream consumer must tolerate new fields appearing without a redeploy. Treat the downstream as a reader that does forward-compatible deserialization (Protobuf, Avro with a schema registry, or JSON with explicit field allowlists). Never let a consumer crash-loop on an unknown field. The schema registry pattern (Confluent Schema Registry, AWS Glue Schema Registry, Apicurio) with `BACKWARD` or `FULL` compatibility mode is the industry default and the interview answer.

CDC to lakehouse is the dominant 2026 pattern. The target is an Iceberg, Delta Lake, or Hudi table partitioned by date and keyed by primary key, updated incrementally from the CDC stream. The two architectural camps are: (a) Flink CDC writing directly to Iceberg with upsert semantics via the Iceberg sink, or (b) Kafka Connect to S3/GCS as raw change events, followed by a merge-on-read compaction job (Spark, dbt, or Airbyte) that folds changes into the analytic table. Choice (a) gives you sub-minute latency and stronger exactly-once guarantees through Flink checkpointing. Choice (b) decouples streaming from analytics and survives multi-hour downstream outages because the raw events accumulate in object storage. Most FAANG data platforms run both, with latency-sensitive tables on Flink CDC and everything else on batched compaction. The governance overlay (Unity Catalog, Nessie, Polaris) tracks table versions and row-level lineage back to the originating OLTP transaction ID, which is the auditor-friendly story.

The transactional outbox pattern is the bridge between CDC and domain events. A service writes business rows and an `outbox` row in the same transaction. Debezium's outbox SMT reads only the outbox table and routes each row to a topic named by the aggregate type, using the aggregate ID as the Kafka key. This gives you atomic dual writes (one database transaction) with domain-level event semantics (business-shaped events, not row diffs), and it is the pattern Chris Richardson, Gunnar Morling, and Debezium's own docs uniformly recommend. The cost is the outbox retention policy: rows must be deleted after they have been read, otherwise the table grows without bound. The usual solution is a trigger or a periodic `DELETE` of rows older than one hour, which is safe because the CDC connector has already published them.

Exactly-once semantics end to end are achievable but expensive and misunderstood. Kafka Connect plus Debezium offers at-least-once out of the box. Downstream consumers must deduplicate using the source LSN or transaction ID, which is why `DebeziumSource.LSN` matters and why production consumers should persist a processed-LSN high-water mark keyed by aggregate or topic partition. Flink CDC offers exactly-once within a Flink pipeline through checkpointed offsets and two-phase sink commits, but exactly-once stops at the sink boundary unless the sink also participates in the transaction (Iceberg, Kafka transactional producer, or a JDBC sink with idempotent upserts). The honest operating posture is at-least-once with idempotent consumers everywhere, and reserve "exactly-once" language for regulator-facing documentation where the compliance team has verified the end-to-end claim.

GDPR and right-to-erasure cut through CDC designs harder than most. A delete in the OLTP becomes a tombstone event in Kafka, but the event with the pre-image (the `before` field) still carries PII. Retention on the change topic and on any derived analytic table must honor the erasure request, which means either crypto-shredding (per-subject encryption keys destroyed on erasure, a pattern CockroachDB and some Snowflake setups use) or periodic full rewrites of retained history with the subject's rows removed. Design this in at day one if the data includes personal identifiers, because retrofitting it across a lakehouse with years of history is measured in quarters.

---
