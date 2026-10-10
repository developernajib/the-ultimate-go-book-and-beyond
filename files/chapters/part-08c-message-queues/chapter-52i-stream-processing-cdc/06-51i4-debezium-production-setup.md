## 52I.4 Debezium Production Setup

> **Senior track**: As of April 2026 the current stable line is Debezium 3.4.x (initial 3.4.0.Final shipped December 2025) with 3.5 in milestone. Use `pgoutput` as the logical decoding plugin (built into Postgres, no external extension). pair it with `REPLICA IDENTITY FULL` on tables where you need accurate `before` state for updates, or at minimum `REPLICA IDENTITY USING INDEX` on the primary key. Debezium runs as a Kafka Connect source by default. Debezium Server is the option when you don't want a Connect cluster and prefer delivering events directly to Kinesis, Pub/Sub, Pulsar, or Redis Streams.

### Connector Configuration

The following JSON configuration shows a production Debezium PostgreSQL connector. Key settings include `heartbeat.interval.ms` (prevents WAL accumulation during low-traffic periods), `slot.name` (ties the connector to a specific replication slot), and `snapshot.mode: initial` (takes a full table snapshot on first startup, then switches to streaming). The password is externalized via Kafka Connect's config provider to avoid plaintext credentials.

```json
{
  "name": "orders-postgres-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres.internal",
    "database.port": "5432",
    "database.user": "debezium_user",
    "database.password": "${file:/opt/kafka/config/debezium.properties:db.password}",
    "database.dbname": "shopdb",
    "database.server.name": "shopdb",
    "plugin.name": "pgoutput",
    "publication.name": "dbz_publication",
    "slot.name": "debezium_orders",
    "table.include.list": "public.orders,public.order_items",
    "heartbeat.interval.ms": "10000",
    "snapshot.mode": "initial",
    "key.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "value.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "schema.registry.url": "http://schema-registry:8081",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite"
  }
}
```

### Debezium Envelope Format

Every Debezium change event wraps the before and after row state in a standardized envelope that also carries transaction metadata, LSN position, and the originating table. The `source.ts_ms` field records the database commit timestamp (use this for event-time processing), while the top-level `ts_ms` records when Debezium processed the event (useful for measuring CDC lag).

```json
{
  "before": {
    "id": 123,
    "status": "pending",
    "amount_cents": 9999
  },
  "after": {
    "id": 123,
    "status": "shipped",
    "amount_cents": 9999
  },
  "source": {
    "version": "3.4.0.Final",
    "connector": "postgresql",
    "name": "shopdb",
    "ts_ms": 1710259200000,
    "db": "shopdb",
    "schema": "public",
    "table": "orders",
    "txId": 789,
    "lsn": 24023120,
    "xmin": null
  },
  "op": "u",
  "ts_ms": 1710259200100,
  "transaction": null
}
```

`op` values: `c` (create), `u` (update), `d` (delete), `r` (read/snapshot)

### Consuming Debezium Events in Go

The following Go implementation defines typed structs for the Debezium envelope and a dispatcher that routes each operation type to the appropriate handler. The generic `DebeziumEnvelope[T]` allows reuse across different table types. The `CDCConsumer` uses franz-go to poll Kafka, deserialize each record, dispatch it, and commit offsets after successful processing.

```go
package cdc

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/twmb/franz-go/pkg/kgo"
)

// DebeziumEnvelope represents the CDC event envelope
type DebeziumEnvelope[T any] struct {
    Before *T              `json:"before"`
    After  *T              `json:"after"`
    Source DebeziumSource  `json:"source"`
    Op     string          `json:"op"`
    TsMs   int64           `json:"ts_ms"`
}

type DebeziumSource struct {
    Version   string `json:"version"`
    Connector string `json:"connector"`
    Name      string `json:"name"`
    TsMs      int64  `json:"ts_ms"`
    DB        string `json:"db"`
    Schema    string `json:"schema"`
    Table     string `json:"table"`
    TxID      int64  `json:"txId"`
    LSN       int64  `json:"lsn"`
}

// Order represents the orders table row
type Order struct {
    ID         int64   `json:"id"`
    CustomerID int64   `json:"customer_id"`
    Status     string  `json:"status"`
    AmountCents int64  `json:"amount_cents"`
    CreatedAt  int64   `json:"created_at"`
}

// OrderCDCHandler handles order CDC events
type OrderCDCHandler struct {
    logger *slog.Logger
    // downstream sinks would be injected here
}

func (h *OrderCDCHandler) Handle(ctx context.Context, envelope DebeziumEnvelope[Order]) error {
    switch envelope.Op {
    case "c": // CREATE
        if envelope.After == nil {
            return fmt.Errorf("create event missing 'after' field")
        }
        return h.handleInsert(ctx, *envelope.After, envelope.Source)

    case "u": // UPDATE
        if envelope.After == nil {
            return fmt.Errorf("update event missing 'after' field")
        }
        return h.handleUpdate(ctx, envelope.Before, *envelope.After, envelope.Source)

    case "d": // DELETE
        if envelope.Before == nil {
            return fmt.Errorf("delete event missing 'before' field")
        }
        return h.handleDelete(ctx, *envelope.Before, envelope.Source)

    case "r": // READ (snapshot)
        if envelope.After == nil {
            return fmt.Errorf("snapshot event missing 'after' field")
        }
        return h.handleSnapshot(ctx, *envelope.After, envelope.Source)

    default:
        h.logger.Warn("unknown op type", "op", envelope.Op)
        return nil
    }
}

func (h *OrderCDCHandler) handleInsert(ctx context.Context, order Order, source DebeziumSource) error {
    h.logger.Info("order created",
        "order_id", order.ID,
        "customer_id", order.CustomerID,
        "amount_cents", order.AmountCents,
        "lsn", source.LSN,
    )
    // sync to Elasticsearch, invalidate cache, update analytics, etc.
    return nil
}

func (h *OrderCDCHandler) handleUpdate(ctx context.Context, before *Order, after Order, source DebeziumSource) error {
    if before != nil && before.Status != after.Status {
        h.logger.Info("order status changed",
            "order_id", after.ID,
            "from", before.Status,
            "to", after.Status,
            "lsn", source.LSN,
        )
    }
    return nil
}

func (h *OrderCDCHandler) handleDelete(ctx context.Context, order Order, source DebeziumSource) error {
    h.logger.Info("order deleted", "order_id", order.ID, "lsn", source.LSN)
    return nil
}

func (h *OrderCDCHandler) handleSnapshot(ctx context.Context, order Order, source DebeziumSource) error {
    // During initial snapshot, use UPSERT semantics in the sink
    h.logger.Debug("snapshot event", "order_id", order.ID)
    return nil
}

// CDCConsumer reads CDC events from Kafka
type CDCConsumer struct {
    client  *kgo.Client
    handler *OrderCDCHandler
    logger  *slog.Logger
}

func NewCDCConsumer(brokers []string, logger *slog.Logger) (*CDCConsumer, error) {
    client, err := kgo.NewClient(
        kgo.SeedBrokers(brokers...),
        kgo.ConsumerGroup("cdc-order-processor"),
        kgo.ConsumeTopics("shopdb.public.orders"),
        kgo.WithLogger(kgo.BasicLogger(nil, kgo.LogLevelInfo, nil)),
    )
    if err != nil {
        return nil, fmt.Errorf("create kafka client: %w", err)
    }

    return &CDCConsumer{
        client:  client,
        handler: &OrderCDCHandler{logger: logger},
        logger:  logger,
    }, nil
}

func (c *CDCConsumer) Run(ctx context.Context) error {
    defer c.client.Close()

    for {
        fetches := c.client.PollFetches(ctx)
        if fetches.IsClientClosed() {
            return nil
        }
        if err := fetches.Err(); err != nil {
            if ctx.Err() != nil {
                return nil
            }
            c.logger.Error("fetch error", "err", err)
            continue
        }

        fetches.EachRecord(func(record *kgo.Record) {
            // Tombstone message = delete in Kafka compacted topic
            if record.Value == nil {
                c.logger.Debug("tombstone message", "key", string(record.Key))
                return
            }

            var envelope DebeziumEnvelope[Order]
            if err := json.Unmarshal(record.Value, &envelope); err != nil {
                c.logger.Error("failed to parse CDC envelope",
                    "err", err,
                    "topic", record.Topic,
                    "partition", record.Partition,
                    "offset", record.Offset,
                )
                return
            }

            if err := c.handler.Handle(ctx, envelope); err != nil {
                c.logger.Error("failed to handle CDC event",
                    "err", err,
                    "op", envelope.Op,
                    "lsn", envelope.Source.LSN,
                )
            }
        })

        if err := c.client.CommitUncommittedOffsets(ctx); err != nil {
            c.logger.Error("failed to commit offsets", "err", err)
        }
    }
}

// EventTime returns the event time from the Debezium source timestamp
func (e DebeziumEnvelope[T]) EventTime() time.Time {
    return time.UnixMilli(e.Source.TsMs).UTC()
}
```

### Junior -> FAANG: Reading the Debezium Connector Config and Envelope

The connector configuration JSON and the envelope format are the two artifacts you will deal with most often as a junior engineer consuming a CDC stream. You do not need to configure Debezium from scratch on day one, but you do need to read an existing configuration and understand what each setting does.

The `heartbeat.interval.ms` setting deserves attention because its absence causes a subtle production issue. On a low-traffic table, the Debezium connector may not receive any actual change events for minutes or hours. During this idle period, the replication slot's `confirmed_flush_lsn` does not advance, even though the WAL continues to grow from other tables not in the connector's `table.include.list`. Without a heartbeat, the slot appears stalled, WAL accumulates, and the disk eventually fills. The heartbeat causes Debezium to periodically write a synthetic record to the WAL to advance the slot even when the tables it watches are idle.

The `snapshot.mode: initial` setting means that when the connector starts for the first time, it reads every existing row from the source tables and emits `op: r` events before switching to streaming mode. If your sink does not handle upserts for these snapshot events, you will get duplicate-key errors. This is one of the most common first-job CDC mistakes.

The `transforms.unwrap.type` and `ExtractNewRecordState` settings flatten the Debezium envelope, replacing it with just the `after` row state. This is convenient for consumers that only care about the current state of a row and do not need the `before` state or the source metadata. The tradeoff: you lose the `op` type and the `source.lsn`, which means you cannot implement idempotent deduplication based on LSN in a consumer that receives the flattened output.

For the envelope, the single most important thing to memorize for the interview is: use `source.ts_ms` for event-time processing, not `ts_ms`. The top-level `ts_ms` is when Debezium processed the WAL record, which can be minutes after the actual database commit during backlog catch-up.

### Senior @ FAANG: Debezium in a Production Platform Context

Running one Debezium connector as a proof of concept is qualitatively different from running a production Debezium fleet. The differences are operational, not technical.

**Connector lifecycle management.** Connectors should be created, paused, resumed, and deleted via an API or GitOps workflow, not via direct Kafka Connect REST calls from an engineer's laptop. At scale, Strimzi provides `KafkaConnector` CRDs that allow connectors to be declared in a Git repository and applied by a controller. Confluent's managed Kafka Connect service provides a control plane. Either approach gives you auditability (who created this connector and when?), version history (what was the configuration before this change?), and rollback (if a configuration change breaks the connector, revert via Git).

**Schema Registry as a hard requirement at scale.** The connector configuration above uses Avro with a Schema Registry. This is the correct choice for any pipeline with more than one consumer or any pipeline that will outlive its first year. JSON without schema validation means that a column rename or type change in the source database propagates to all consumers simultaneously, with no mechanism for the platform to detect the breaking change before it reaches production consumers. Enforcing `BACKWARD` or `FULL` compatibility at the Schema Registry means that the connector configuration change fails at registration time if the new schema would break existing consumers.

**Connector credentials management.** The configuration above externalizes the database password via Kafka Connect's `FileConfigProvider`. In a production deployment, the correct approach is a secrets manager integration: HashiCorp Vault's Kafka Connect plugin, AWS Secrets Manager via the MSK Connect secrets provider, or Kubernetes secrets projected into the Connect pod. Plaintext passwords in connector configurations are a compliance violation in SOC2 and PCI environments.

**The `REPLICA IDENTITY` decision per connector.** The connector configuration specifies `table.include.list`, but it does not specify the `REPLICA IDENTITY` setting for each included table. This is a PostgreSQL-level decision that must be made before the connector is started. If a table has the default `REPLICA IDENTITY DEFAULT`, the `before` field in update events will contain only the primary key, not the full row state. If downstream consumers require the full `before` state (for audit logging, for computing diffs, for cache invalidation that needs to remove old cache keys based on the previous value), `REPLICA IDENTITY FULL` must be set on the source table before the connector starts, not after.

**Managing connector restarts and re-snapshots.** When a Debezium connector is restarted after a long outage, and the replication slot has been invalidated (due to `max_slot_wal_keep_size` or manual intervention), the connector must re-snapshot the source tables. This means a burst of `op: r` events for every row in every captured table. Downstream consumers must be prepared to handle this gracefully: upsert-capable sinks handle it correctly, but sinks that assume each `op: r` event represents a new row will produce duplicates. A senior engineer prepares downstream consumers for this scenario as part of the connector design, not as a post-incident fix.

**Debezium Server as an alternative deployment model.** For teams that do not run Kafka and want CDC events delivered to Kinesis, Pub/Sub, Pulsar, or Redis Streams, Debezium Server is the deployment model. It runs as a standalone Java process, not as a Kafka Connect plugin. It provides the same connector logic (WAL reading, snapshotting, heartbeat) but delivers events directly to the target sink. This simplifies the infrastructure stack for teams that are not already invested in Kafka but comes at the cost of losing Kafka's at-least-once delivery and consumer group management for the CDC stream itself.

---
