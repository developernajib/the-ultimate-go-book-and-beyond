## 52I.7 Complete Pipeline: PostgreSQL → Debezium → Kafka → Go → ClickHouse

This section assembles the individual components into a complete pipeline: PostgreSQL changes flow through Debezium into Kafka, a Go consumer transforms them, and batched inserts land in ClickHouse for analytics. The implementation includes Prometheus metrics for observability, time-based and size-based batch flushing, and graceful shutdown that drains in-flight batches before exit.

> **Senior track**: The ClickHouse sink uses `ReplacingMergeTree` keyed on `order_id` with `event_time` as the version column, which makes reprocessing idempotent: two inserts of the same `order_id` will eventually collapse to the highest `event_time` during merge. For stronger read-after-write consistency use a staging table plus `INSERT INTO final SELECT ... FROM staging` with dedup by PK. Tune batch size 1000-10000 rows and flush interval 1-5 seconds. ClickHouse rejects too-frequent small inserts (`too_many_parts`).

```go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/ClickHouse/clickhouse-go/v2"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/twmb/franz-go/pkg/kgo"
)

var (
    eventsProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "cdc_events_processed_total",
    }, []string{"op", "table"})

    processingLatency = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "cdc_processing_duration_seconds",
        Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0},
    })
)

// AnalyticsOrder is the ClickHouse analytics schema
type AnalyticsOrder struct {
    OrderID    int64     `ch:"order_id"`
    CustomerID int64     `ch:"customer_id"`
    Status     string    `ch:"status"`
    AmountCents int64    `ch:"amount_cents"`
    EventTime  time.Time `ch:"event_time"`
    IsDeleted  uint8     `ch:"is_deleted"` // for ReplacingMergeTree
}

// OrderCDCPipeline transforms Debezium order events to ClickHouse
type OrderCDCPipeline struct {
    kafka  *kgo.Client
    ch     clickhouse.Conn
    logger *slog.Logger
    batch  []AnalyticsOrder
    batchSize int
}

func NewOrderCDCPipeline(kafkaBrokers []string, chDSN string, logger *slog.Logger) (*OrderCDCPipeline, error) {
    kafkaClient, err := kgo.NewClient(
        kgo.SeedBrokers(kafkaBrokers...),
        kgo.ConsumerGroup("cdc-clickhouse-sync"),
        kgo.ConsumeTopics("shopdb.public.orders"),
    )
    if err != nil {
        return nil, fmt.Errorf("kafka client: %w", err)
    }

    conn, err := clickhouse.Open(&clickhouse.Options{
        Addr: []string{chDSN},
        Auth: clickhouse.Auth{Database: "analytics"},
    })
    if err != nil {
        return nil, fmt.Errorf("clickhouse conn: %w", err)
    }

    return &OrderCDCPipeline{
        kafka:     kafkaClient,
        ch:        conn,
        logger:    logger,
        batchSize: 500,
    }, nil
}

func (p *OrderCDCPipeline) Run(ctx context.Context) error {
    defer p.kafka.Close()
    defer p.ch.Close()

    flushTicker := time.NewTicker(5 * time.Second)
    defer flushTicker.Stop()

    for {
        select {
        case <-ctx.Done():
            return p.flush(context.Background())
        case <-flushTicker.C:
            if err := p.flush(ctx); err != nil {
                p.logger.Error("flush error", "err", err)
            }
        default:
            fetches := p.kafka.PollFetches(ctx)
            if fetches.IsClientClosed() {
                return nil
            }
            fetches.EachRecord(func(rec *kgo.Record) {
                start := time.Now()
                if err := p.processRecord(ctx, rec); err != nil {
                    p.logger.Error("process record error", "err", err,
                        "partition", rec.Partition, "offset", rec.Offset)
                }
                processingLatency.Observe(time.Since(start).Seconds())
            })

            if len(p.batch) >= p.batchSize {
                if err := p.flush(ctx); err != nil {
                    p.logger.Error("flush error", "err", err)
                }
            }

            if err := p.kafka.CommitUncommittedOffsets(ctx); err != nil {
                p.logger.Error("commit error", "err", err)
            }
        }
    }
}

func (p *OrderCDCPipeline) processRecord(ctx context.Context, rec *kgo.Record) error {
    if rec.Value == nil {
        return nil // tombstone
    }

    var envelope struct {
        Before *Order         `json:"before"`
        After  *Order         `json:"after"`
        Source DebeziumSource `json:"source"`
        Op     string         `json:"op"`
    }

    if err := json.Unmarshal(rec.Value, &envelope); err != nil {
        return fmt.Errorf("unmarshal envelope: %w", err)
    }

    eventsProcessed.WithLabelValues(envelope.Op, envelope.Source.Table).Inc()

    switch envelope.Op {
    case "c", "u", "r":
        if envelope.After == nil {
            return nil
        }
        p.batch = append(p.batch, AnalyticsOrder{
            OrderID:    envelope.After.ID,
            CustomerID: envelope.After.CustomerID,
            Status:     envelope.After.Status,
            AmountCents: envelope.After.AmountCents,
            EventTime:  time.UnixMilli(envelope.Source.TsMs).UTC(),
            IsDeleted:  0,
        })
    case "d":
        if envelope.Before == nil {
            return nil
        }
        p.batch = append(p.batch, AnalyticsOrder{
            OrderID:   envelope.Before.ID,
            EventTime: time.UnixMilli(envelope.Source.TsMs).UTC(),
            IsDeleted: 1,
        })
    }
    return nil
}

func (p *OrderCDCPipeline) flush(ctx context.Context) error {
    if len(p.batch) == 0 {
        return nil
    }

    batch, err := p.ch.PrepareBatch(ctx, "INSERT INTO orders_analytics")
    if err != nil {
        return fmt.Errorf("prepare batch: %w", err)
    }

    for _, row := range p.batch {
        if err := batch.AppendStruct(&row); err != nil {
            return fmt.Errorf("append struct: %w", err)
        }
    }

    if err := batch.Send(); err != nil {
        return fmt.Errorf("send batch: %w", err)
    }

    p.logger.Info("flushed to clickhouse", "count", len(p.batch))
    p.batch = p.batch[:0]
    return nil
}

func Run() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

    pipeline, err := NewOrderCDCPipeline(
        []string{"kafka:9092"},
        "clickhouse:9000",
        logger,
    )
    if err != nil {
        logger.Error("failed to create pipeline", "err", err)
        os.Exit(1)
    }

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        <-sigCh
        logger.Info("shutdown signal received")
        cancel()
    }()

    if err := pipeline.Run(ctx); err != nil {
        logger.Error("pipeline error", "err", err)
        os.Exit(1)
    }
}
```

### Junior -> FAANG: Reading a Complete Pipeline Implementation

The `OrderCDCPipeline` in this section wires together three concerns: Kafka consumption, batch accumulation, and ClickHouse insertion. Read it as a loop with two exit conditions and two flush triggers.

The exit conditions are: `ctx.Done()` (graceful shutdown, flushes the remaining batch before exiting) and `fetches.IsClientClosed()` (Kafka client was closed, exit cleanly). The two flush triggers are: the 5-second ticker (time-based flush) and `len(p.batch) >= p.batchSize` (size-based flush). Both flush to ClickHouse and reset the batch slice.

The `processRecord` function handles the three meaningful CDC operations. For `c` (create), `u` (update), and `r` (snapshot), it appends a row with `IsDeleted = 0`. For `d` (delete), it appends a row with `IsDeleted = 1`. This is the `ReplacingMergeTree` pattern: the delete is represented as a row with a deletion flag, which ClickHouse's merge process uses to suppress the previous version of the row.

The Prometheus metrics (`eventsProcessed`, `processingLatency`) are the minimum observability for this pipeline. In production you would add: batch size histogram, flush duration histogram, Kafka consumer lag gauge (polled from the Kafka client's internal offset tracker), and a ClickHouse error counter.

One subtle issue in the implementation: offset commits happen in the `default:` case of the `select`, which means offsets are committed after each `PollFetches` call regardless of whether the records from that poll have been flushed to ClickHouse yet. If the process crashes between the `CommitUncommittedOffsets` call and the next flush, records that were committed in Kafka may not have been written to ClickHouse. The ClickHouse `ReplacingMergeTree` idempotency handles this for re-delivered records, but it requires understanding how the idempotency works (the same `order_id` and `event_time` will produce an identical row on re-insert, which ClickHouse deduplicates during merge).

### Senior @ FAANG: Production Gaps and ClickHouse Sink Design Decisions

This implementation is a correct starting point but has several production gaps that a senior engineer would close before certifying it for a business-critical pipeline.

**Offset commit placement.** The implementation commits offsets inside the `default:` case of the `select` loop, immediately after polling. This means records may be committed in Kafka before they are flushed to ClickHouse. The safer pattern is to commit offsets only after a successful flush: accumulate records, flush to ClickHouse, then commit. This requires tracking which offsets correspond to which batch, which franz-go supports via the `kgo.CommitRecords` method. The trade-off is that if the flush succeeds but the commit fails (rare, but possible), the records are redelivered and re-inserted into ClickHouse. With `ReplacingMergeTree`, this is idempotent. Without it, this is a source of duplicates.

**ClickHouse `ReplacingMergeTree` semantics and their limits.** `ReplacingMergeTree` deduplicates rows with the same sorting key during background merges. Between merges, duplicate rows coexist and are both visible to queries. This means that in the window between a re-insert and the next merge, a `SELECT COUNT(*)` on ClickHouse may return a higher count than the true deduplicated count. For most analytics use cases, this is acceptable. For use cases that require read-after-write consistency (an operational dashboard that must reflect the current row count accurately), a staging-plus-merge pattern is required: insert into a staging table, then run an `INSERT INTO final SELECT DISTINCT ON (order_id) ... FROM staging ORDER BY event_time DESC` to merge into the final table with explicit deduplication.

**Batch size and flush interval tuning.** The implementation uses a hardcoded batch size of 500 and a 5-second flush interval. ClickHouse performance is highly sensitive to these parameters. Too-frequent small inserts (`INSERT` with fewer than ~1000 rows) cause `too_many_parts` errors as ClickHouse cannot merge parts fast enough. Too-infrequent large inserts increase memory usage and expose the pipeline to larger data loss windows on crash. The production recommendation is a batch size of 5000-10000 rows and a flush interval of 1-5 seconds, tuned based on the peak event rate and ClickHouse's part merge throughput for the table's schema.

**Graceful shutdown race condition.** The shutdown path calls `p.flush(context.Background())` after `ctx` is canceled. This is correct: using `context.Background()` ensures the flush is not canceled by the shutdown signal. However, if the Kafka client is closed before `flush()` completes, the `CommitUncommittedOffsets` call at the end of the loop may fail because the client is already closed. The correct sequence is: stop polling (cancel context), flush the remaining batch, commit offsets, then close the Kafka client. The current implementation closes the client via `defer p.kafka.Close()`, which runs before the flush completes in some orderings. A clean implementation uses an explicit shutdown sequence rather than a defer chain.

**Observability: the missing metrics.** The two Prometheus metrics in this implementation (event counter and processing latency histogram) are necessary but not sufficient. The metrics that a FAANG on-call needs to diagnose a pipeline incident are: (a) ClickHouse batch flush duration (is the sink slowing down?), (b) ClickHouse flush error rate (is the sink rejecting inserts?), (c) Kafka consumer lag per partition (is the consumer falling behind?), (d) batch size distribution (are batches hitting the size limit or the time limit?). Without these, a consumer lag alert is actionable only if the on-call already knows which component is the bottleneck.

**Schema evolution: the ClickHouse side.** When the source table gains a new column, the Debezium envelope gains a new field in `after`. The Go struct (`AnalyticsOrder`) must be updated to include the new field, and the ClickHouse table must have the corresponding column added. ClickHouse supports online `ALTER TABLE ADD COLUMN` without a table lock. The migration sequence is: add the column to ClickHouse first (with a default value), then deploy the updated Go consumer that populates it. If you deploy the Go consumer first, ClickHouse will reject the `INSERT` for unknown columns unless the driver is configured to ignore extra fields. The reverse sequence (ClickHouse first, then Go) is the safe order.

---
