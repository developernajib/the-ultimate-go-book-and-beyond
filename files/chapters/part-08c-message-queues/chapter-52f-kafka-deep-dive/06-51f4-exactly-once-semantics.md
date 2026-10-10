## 52F.4 Exactly-Once Semantics

Achieving exactly-once message processing is one of the hardest problems in distributed systems. Kafka provides three delivery guarantees, and since version 0.11 (2017), supports true exactly-once semantics through a combination of idempotent producers, transactional APIs, and read-committed consumers.

> **Senior track**: Kafka EOS guarantees apply to **Kafka-to-Kafka** flows only (the consume-transform-produce pattern where input offsets, output records, and downstream state all live inside Kafka). If your sink is an external database, HTTP service, or cache, Kafka transactions cannot make that external write atomic with the offset commit. You need either the **transactional outbox pattern** (write to a DB outbox table in a local DB transaction, then relay to Kafka via CDC/Debezium) or an **idempotent consumer** (unique message ID + upsert keyed on it). Claiming "end-to-end exactly-once" without one of these is a red flag in design reviews.
>
> Also, starting with modern clients (franz-go, confluent-kafka-go 2.x, Java 3.0+), `enable.idempotence=true` and `acks=all` are the **default**. You have to opt out, not opt in.

### Delivery Guarantee Spectrum

Kafka's delivery semantics exist on a spectrum from at-most-once through at-least-once to exactly-once, each requiring different producer configuration. The following table shows how `acks`, `enable.idempotence`, and transactions interact to place a producer at each point on that spectrum.

```
At-Most-Once         At-Least-Once         Exactly-Once
     │                     │                     │
     ▼                     ▼                     ▼
  acks=0               acks=all              acks=all
  No retries           Retries enabled       + Idempotence
  Fast, lossy          May duplicate         + Transactions
                                             + Read-committed

  "Fire and forget"    "Retry until ack'd"   "Each message processed
   Some messages        Same message may       exactly once, even
   may be lost"         be delivered 2+"       across failures"
```

### Idempotent Producer: PID + Sequence Number

When `enable.idempotence=true`, the Kafka broker assigns each producer instance a **Producer ID (PID)** and tracks a **sequence number** per partition. This eliminates duplicates from producer retries within a single producer session.

```
Producer Session (PID=42):

  Message 1: PID=42, Partition=0, Seq=0  → Broker writes, acks
  Message 2: PID=42, Partition=0, Seq=1  → Broker writes, ack LOST
  Message 2: PID=42, Partition=0, Seq=1  → Broker detects duplicate (same PID+Seq)
                                           → Returns ack without writing

  Broker's sequence tracking:
  ┌──────────────────────────────────────┐
  │ Partition 0 Sequence Map:            │
  │   PID=42 → last_seq=1                │
  │   PID=43 → last_seq=7                │
  │   PID=44 → last_seq=3                │
  └──────────────────────────────────────┘

  Requirements for idempotence:
  - acks=all (automatically set)
  - max.in.flight.requests.per.connection <= 5
  - retries > 0
```

**Limitation**: Idempotence only prevents duplicates within a single producer session (same PID). If the producer process restarts, it gets a new PID, and cross-session duplicates are possible. For cross-session guarantees, you need transactions.

### Transactional Producer API

Transactions extend idempotence across multiple partitions and producer sessions. A **transactional producer** groups multiple writes (potentially to different topics/partitions) into an atomic unit - either all succeed or all are rolled back.

```
Transactional Flow:

  1. initTransactions()     → Register transactional.id with coordinator
  2. beginTransaction()     → Start a new transaction
  3. send(topic-A, msg1)    → Buffered in transaction
  4. send(topic-B, msg2)    → Buffered in transaction
  5. sendOffsetsToTxn()     → Include consumer offsets in transaction
  6. commitTransaction()    → Atomically commit all writes + offsets
     OR
  6. abortTransaction()     → Roll back everything

  ┌────────────────────────────────────────────────────┐
  │              Transaction Coordinator               │
  │                                                    │
  │  transactional.id = "order-processor-1"            │
  │  PID = 42, Epoch = 3                               │
  │                                                    │
  │  Active Transaction:                               │
  │  ├── Write: topic-A, partition 0, offset 100       │
  │  ├── Write: topic-B, partition 2, offset 50        │
  │  └── Offsets: input-topic, partition 1, offset 75  │
  │                                                    │
  │  State: ONGOING → PREPARE_COMMIT → COMMITTED       │
  └────────────────────────────────────────────────────┘
```

### Read-Committed Isolation Level

Consumers must set `isolation.level=read_committed` to see only messages from committed transactions. Without this, consumers see all messages including those from aborted transactions.

```
Partition timeline with transactions:

  Offset: 0  1  2  3  4  5  6  7  8  9  10
  Data:   [A][B][C][D][E][F][G][H][I][J][K]
  Txn:     -  T1 T1  -  T2 T2 T2  -  T1 T1  -
  Status:  -  ✓  ✓   -  ✗  ✗  ✗   -  ✓  ✓   -

  T1 = committed, T2 = aborted

  read_uncommitted consumer sees:  A B C D E F G H I J K  (all 11)
  read_committed consumer sees:    A B C D       H I J K  (8, skips aborted T2)
```

### End-to-End Exactly-Once: Consume-Transform-Produce

The most powerful pattern is **consume-transform-produce** with transactions. A consumer reads from an input topic, processes the data, and writes to an output topic - all within a single transaction that includes the consumer's offset commit.

```
Exactly-Once Consume-Transform-Produce:

  ┌─────────────┐     ┌──────────────────────────┐     ┌─────────────┐
  │ Input Topic │────►│ Transactional Processor  │────►│ Output Topic│
  │  "raw-      │     │                          │     │  "enriched- │
  │   orders"   │     │  1. Begin transaction    │     │   orders"   │
  └─────────────┘     │  2. Consume message      │     └─────────────┘
                      │  3. Transform/enrich     │
                      │  4. Produce to output    │
                      │  5. Commit consumer      │
                      │     offsets to txn       │
                      │  6. Commit transaction   │
                      │                          │
                      │  If ANY step fails:      │
                      │  → Abort transaction     │
                      │  → Consumer offsets NOT  │ 
                      │    committed             │
                      │  → Output NOT written    │
                      │  → Retry from same offset│
                      └──────────────────────────┘
```

### Deduplication Strategies for Consumers

Even with Kafka's exactly-once guarantees, external systems (databases, APIs) may receive duplicate requests during failure recovery. Consumer-side deduplication adds an extra safety layer:

| Strategy | How It Works | Pros | Cons |
|----------|-------------|------|------|
| **Idempotent operations** | Design operations to be naturally idempotent (SET vs INCREMENT) | No extra storage | Not always possible |
| **Dedup table** | Store processed message IDs in a database table | Reliable | Extra storage and lookups |
| **Bloom filter** | Probabilistic dedup with compact memory footprint | Fast, low memory | False positives possible |
| **Idempotency key** | Use message key + offset as unique constraint | Simple | Requires database support |

### Go Code: Transactional Producer

Exactly-once semantics in Kafka require the producer to open a transaction, write to one or more topics, and commit atomically, aborting on any error to prevent partial writes. The transactional producer calls `BeginTransaction`, writes records, and calls `CommitTransaction` only on success. On any error it calls `AbortTransaction` and logs the epoch-fence error that occurs when a zombie producer with an older epoch tries to write after a failover.

```go
// File: kafka-fundamentals/exactly_once/transactional_producer.go
package exactlyonce

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "sync"
    "time"

    "github.com/twmb/franz-go/pkg/kgo"
)

// TxnProducerConfig configures the transactional producer.
type TxnProducerConfig struct {
    Brokers          []string
    TransactionalID  string        // Must be unique and stable across restarts.
    TransactionTimeout time.Duration
    MaxRetries       int
    Logger           *slog.Logger
}

// DefaultTxnProducerConfig returns sensible defaults.
func DefaultTxnProducerConfig(brokers []string, txnID string) TxnProducerConfig {
    return TxnProducerConfig{
        Brokers:            brokers,
        TransactionalID:    txnID,
        TransactionTimeout: 60 * time.Second,
        MaxRetries:         3,
        Logger:             slog.Default(),
    }
}

// TxnProducer provides transactional producing with exactly-once semantics.
type TxnProducer struct {
    client *kgo.Client
    config TxnProducerConfig
    logger *slog.Logger
    mu     sync.Mutex
}

// NewTxnProducer creates a new transactional producer using franz-go.
func NewTxnProducer(config TxnProducerConfig) (*TxnProducer, error) {
    if len(config.Brokers) == 0 {
        return nil, errors.New("at least one broker is required")
    }
    if config.TransactionalID == "" {
        return nil, errors.New("transactional ID is required")
    }
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    client, err := kgo.NewClient(
        kgo.SeedBrokers(config.Brokers...),
        kgo.TransactionalID(config.TransactionalID),
        kgo.TransactionTimeout(config.TransactionTimeout),
        // Idempotence is automatically enabled with transactions.
        kgo.RequiredAcks(kgo.AllISRAcks()),
        kgo.RecordRetries(config.MaxRetries),
    )
    if err != nil {
        return nil, fmt.Errorf("creating kafka client: %w", err)
    }

    return &TxnProducer{
        client: client,
        config: config,
        logger: config.Logger,
    }, nil
}

// Init initializes the transactional producer with the Kafka cluster.
// Must be called once before any transactions.
func (tp *TxnProducer) Init(ctx context.Context) error {
    tp.logger.Info("initializing transactional producer",
        "transactional_id", tp.config.TransactionalID,
    )

    // BeginTransaction after InitTransactions is handled by franz-go
    // when we call client methods with transactional ID set.
    return nil
}

// ExecuteTransaction runs a function within a Kafka transaction.
// If the function returns nil, the transaction is committed.
// If the function returns an error, the transaction is aborted.
func (tp *TxnProducer) ExecuteTransaction(ctx context.Context, fn func(ctx context.Context, tx *Transaction) error) error {
    tp.mu.Lock()
    defer tp.mu.Unlock()

    // Begin the transaction.
    if err := tp.client.BeginTransaction(); err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    tx := &Transaction{
        client: tp.client,
        logger: tp.logger,
    }

    // Execute the user's function.
    if err := fn(ctx, tx); err != nil {
        tp.logger.Error("transaction function failed, aborting",
            "error", err,
        )
        // Abort the transaction - all buffered records are discarded.
        if abortErr := tp.client.AbortBufferedRecords(ctx); abortErr != nil {
            tp.logger.Error("failed to abort buffered records", "error", abortErr)
        }
        if endErr := tp.client.EndTransaction(ctx, kgo.TryAbort); endErr != nil {
            tp.logger.Error("failed to abort transaction", "error", endErr)
            return fmt.Errorf("aborting transaction after error %w: %w", err, endErr)
        }
        return fmt.Errorf("transaction aborted: %w", err)
    }

    // Commit the transaction.
    if err := tp.client.EndTransaction(ctx, kgo.TryCommit); err != nil {
        tp.logger.Error("failed to commit transaction", "error", err)
        return fmt.Errorf("committing transaction: %w", err)
    }

    tp.logger.Debug("transaction committed successfully")
    return nil
}

// Close closes the transactional producer.
func (tp *TxnProducer) Close() {
    tp.client.Close()
    tp.logger.Info("transactional producer closed")
}

// Transaction represents an active Kafka transaction.
type Transaction struct {
    client *kgo.Client
    logger *slog.Logger
}

// Produce sends a record within this transaction.
func (tx *Transaction) Produce(ctx context.Context, topic string, key, value []byte, headers map[string]string) error {
    record := &kgo.Record{
        Topic: topic,
        Key:   key,
        Value: value,
    }

    for k, v := range headers {
        record.Headers = append(record.Headers, kgo.RecordHeader{
            Key:   k,
            Value: []byte(v),
        })
    }

    // ProduceSync within a transaction buffers the record for the transaction.
    results := tx.client.ProduceSync(ctx, record)
    for _, r := range results {
        if r.Err != nil {
            return fmt.Errorf("producing to %s: %w", topic, r.Err)
        }
        tx.logger.Debug("record buffered in transaction",
            "topic", r.Record.Topic,
            "partition", r.Record.Partition,
            "offset", r.Record.Offset,
        )
    }
    return nil
}
```

Here is a complete example demonstrating the consume-transform-produce pattern:

```go
// File: kafka-fundamentals/cmd/exactly-once-processor/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    exactlyonce "github.com/example/kafka-fundamentals/exactly_once"
    "github.com/twmb/franz-go/pkg/kgo"
)

// RawOrder is the input event.
type RawOrder struct {
    OrderID    string `json:"order_id"`
    CustomerID string `json:"customer_id"`
    TotalCents int64  `json:"total_cents"`
    Region     string `json:"region"`
}

// EnrichedOrder is the output event with additional computed fields.
type EnrichedOrder struct {
    OrderID           string    `json:"order_id"`
    CustomerID        string    `json:"customer_id"`
    TotalCents        int64     `json:"total_cents"`
    Region            string    `json:"region"`
    TaxCents          int64     `json:"tax_cents"`
    TotalWithTaxCents int64     `json:"total_with_tax_cents"`
    Currency          string    `json:"currency"`
    ProcessedAt       time.Time `json:"processed_at"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    brokersEnv := os.Getenv("KAFKA_BROKERS")
    if brokersEnv == "" {
        brokersEnv = "localhost:9092"
    }
    brokers := strings.Split(brokersEnv, ",")

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM,
    )
    defer cancel()

    // Create the transactional producer.
    txnConfig := exactlyonce.DefaultTxnProducerConfig(brokers, "order-enrichment-processor-1")
    txnConfig.Logger = logger

    txnProducer, err := exactlyonce.NewTxnProducer(txnConfig)
    if err != nil {
        logger.Error("failed to create transactional producer", "error", err)
        os.Exit(1)
    }
    defer txnProducer.Close()

    // Create the consumer (reads from input topic).
    consumer, err := kgo.NewClient(
        kgo.SeedBrokers(brokers...),
        kgo.ConsumerGroup("order-enrichment-group"),
        kgo.ConsumeTopics("raw-orders"),
        kgo.FetchIsolationLevel(kgo.ReadCommitted()), // Only read committed messages.
        kgo.DisableAutoCommit(), // We commit offsets within the transaction.
    )
    if err != nil {
        logger.Error("failed to create consumer", "error", err)
        os.Exit(1)
    }
    defer consumer.Close()

    logger.Info("starting exactly-once processor",
        "input_topic", "raw-orders",
        "output_topic", "enriched-orders",
    )

    // Tax rates by region.
    taxRates := map[string]float64{
        "us-east-1":      0.08,
        "us-west-2":      0.065,
        "eu-west-1":      0.20,
        "ap-southeast-1": 0.07,
    }

    currencies := map[string]string{
        "us-east-1":      "USD",
        "us-west-2":      "USD",
        "eu-west-1":      "EUR",
        "ap-southeast-1": "SGD",
    }

    for {
        select {
        case <-ctx.Done():
            logger.Info("processor shutting down")
            return
        default:
        }

        fetches := consumer.PollFetches(ctx)
        if fetches.IsClientClosed() {
            return
        }

        if errs := fetches.Errors(); len(errs) > 0 {
            for _, e := range errs {
                logger.Error("fetch error",
                    "topic", e.Topic,
                    "partition", e.Partition,
                    "error", e.Err,
                )
            }
            continue
        }

        // Process each record within a transaction.
        fetches.EachRecord(func(record *kgo.Record) {
            err := txnProducer.ExecuteTransaction(ctx, func(txCtx context.Context, tx *exactlyonce.Transaction) error {
                // 1. Deserialize the input.
                var raw RawOrder
                if err := json.Unmarshal(record.Value, &raw); err != nil {
                    logger.Error("failed to unmarshal raw order",
                        "partition", record.Partition,
                        "offset", record.Offset,
                        "error", err,
                    )
                    // Skip bad data - produce to dead-letter topic.
                    return tx.Produce(txCtx, "dead-letter-orders", record.Key, record.Value, map[string]string{
                        "error":            err.Error(),
                        "original_topic":   "raw-orders",
                        "original_partition": fmt.Sprintf("%d", record.Partition),
                    })
                }

                // 2. Transform/enrich.
                taxRate := taxRates[raw.Region]
                if taxRate == 0 {
                    taxRate = 0.10 // Default 10% tax.
                }

                taxCents := int64(float64(raw.TotalCents) * taxRate)
                enriched := EnrichedOrder{
                    OrderID:           raw.OrderID,
                    CustomerID:        raw.CustomerID,
                    TotalCents:        raw.TotalCents,
                    Region:            raw.Region,
                    TaxCents:          taxCents,
                    TotalWithTaxCents: raw.TotalCents + taxCents,
                    Currency:          currencies[raw.Region],
                    ProcessedAt:       time.Now().UTC(),
                }

                if enriched.Currency == "" {
                    enriched.Currency = "USD"
                }

                enrichedData, err := json.Marshal(enriched)
                if err != nil {
                    return fmt.Errorf("marshaling enriched order: %w", err)
                }

                // 3. Produce to output topic within the transaction.
                return tx.Produce(txCtx, "enriched-orders", record.Key, enrichedData, map[string]string{
                    "source":         "order-enrichment-processor",
                    "schema_version": "2.0.0",
                })
            })

            if err != nil {
                logger.Error("transaction failed",
                    "partition", record.Partition,
                    "offset", record.Offset,
                    "error", err,
                )
            }
        })
    }
}
```

### Go Code: Idempotent Consumer with Dedup Table

For external systems that don't participate in Kafka transactions (databases, HTTP APIs), we need consumer-side deduplication:

```go
// File: kafka-fundamentals/exactly_once/idempotent_consumer.go
package exactlyonce

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "sync"
    "time"

    "github.com/segmentio/kafka-go"
)

// DedupStore provides deduplication tracking for consumed messages.
// Implementations can use any backend: PostgreSQL, Redis, in-memory, etc.
type DedupStore interface {
    // HasProcessed checks if a message with this key has already been processed.
    HasProcessed(ctx context.Context, dedupKey string) (bool, error)
    // MarkProcessed records that a message has been processed.
    MarkProcessed(ctx context.Context, dedupKey string) error
}

// PostgresDedupStore uses PostgreSQL for deduplication tracking.
type PostgresDedupStore struct {
    db     *sql.DB
    logger *slog.Logger
}

// NewPostgresDedupStore creates a dedup store backed by PostgreSQL.
// The table is created automatically if it doesn't exist.
func NewPostgresDedupStore(db *sql.DB, logger *slog.Logger) (*PostgresDedupStore, error) {
    if db == nil {
        return nil, errors.New("database connection is required")
    }

    // Create the dedup table with automatic cleanup of old entries.
    createSQL := `
        CREATE TABLE IF NOT EXISTS kafka_dedup (
            dedup_key   VARCHAR(255) PRIMARY KEY,
            processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_kafka_dedup_processed_at
            ON kafka_dedup (processed_at);
    `
    if _, err := db.Exec(createSQL); err != nil {
        return nil, fmt.Errorf("creating dedup table: %w", err)
    }

    return &PostgresDedupStore{db: db, logger: logger}, nil
}

// HasProcessed checks if a dedup key exists in the database.
func (s *PostgresDedupStore) HasProcessed(ctx context.Context, dedupKey string) (bool, error) {
    var exists bool
    err := s.db.QueryRowContext(ctx,
        "SELECT EXISTS(SELECT 1 FROM kafka_dedup WHERE dedup_key = $1)",
        dedupKey,
    ).Scan(&exists)
    if err != nil {
        return false, fmt.Errorf("checking dedup key: %w", err)
    }
    return exists, nil
}

// MarkProcessed inserts a dedup key into the database.
func (s *PostgresDedupStore) MarkProcessed(ctx context.Context, dedupKey string) error {
    _, err := s.db.ExecContext(ctx,
        "INSERT INTO kafka_dedup (dedup_key) VALUES ($1) ON CONFLICT (dedup_key) DO NOTHING",
        dedupKey,
    )
    if err != nil {
        return fmt.Errorf("marking dedup key: %w", err)
    }
    return nil
}

// CleanupOldEntries removes dedup entries older than the retention period.
// Run this periodically to prevent unbounded growth.
func (s *PostgresDedupStore) CleanupOldEntries(ctx context.Context, retention time.Duration) (int64, error) {
    cutoff := time.Now().Add(-retention)
    result, err := s.db.ExecContext(ctx,
        "DELETE FROM kafka_dedup WHERE processed_at < $1",
        cutoff,
    )
    if err != nil {
        return 0, fmt.Errorf("cleaning up dedup entries: %w", err)
    }
    return result.RowsAffected()
}

// InMemoryDedupStore provides an in-memory dedup store for testing.
type InMemoryDedupStore struct {
    mu   sync.RWMutex
    keys map[string]time.Time
}

// NewInMemoryDedupStore creates a new in-memory dedup store.
func NewInMemoryDedupStore() *InMemoryDedupStore {
    return &InMemoryDedupStore{
        keys: make(map[string]time.Time),
    }
}

// HasProcessed checks if the key exists in memory.
func (s *InMemoryDedupStore) HasProcessed(_ context.Context, dedupKey string) (bool, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    _, exists := s.keys[dedupKey]
    return exists, nil
}

// MarkProcessed stores the key in memory.
func (s *InMemoryDedupStore) MarkProcessed(_ context.Context, dedupKey string) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.keys[dedupKey] = time.Now()
    return nil
}

// IdempotentConsumer wraps a standard consumer with deduplication.
type IdempotentConsumer struct {
    reader    *kafka.Reader
    dedup     DedupStore
    handler   IdempotentHandler
    logger    *slog.Logger
    dedupKeyFn func(msg kafka.Message) string
}

// IdempotentHandler processes a message and performs external side effects.
type IdempotentHandler func(ctx context.Context, msg kafka.Message) error

// IdempotentConsumerConfig configures the idempotent consumer.
type IdempotentConsumerConfig struct {
    Brokers    []string
    Topic      string
    GroupID    string
    DedupStore DedupStore
    Handler    IdempotentHandler
    Logger     *slog.Logger
    // DedupKeyFn generates a unique deduplication key for each message.
    // Default: "topic:partition:offset"
    DedupKeyFn func(msg kafka.Message) string
}

// NewIdempotentConsumer creates a consumer with built-in deduplication.
func NewIdempotentConsumer(config IdempotentConsumerConfig) (*IdempotentConsumer, error) {
    if config.DedupStore == nil {
        return nil, errors.New("dedup store is required")
    }
    if config.Handler == nil {
        return nil, errors.New("handler is required")
    }
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    dedupKeyFn := config.DedupKeyFn
    if dedupKeyFn == nil {
        dedupKeyFn = func(msg kafka.Message) string {
            return fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset)
        }
    }

    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:  config.Brokers,
        Topic:    config.Topic,
        GroupID:  config.GroupID,
        MinBytes: 1,
        MaxBytes: 10 << 20,
    })

    return &IdempotentConsumer{
        reader:     reader,
        dedup:      config.DedupStore,
        handler:    config.Handler,
        logger:     config.Logger,
        dedupKeyFn: dedupKeyFn,
    }, nil
}

// Run starts the idempotent consumer loop.
func (ic *IdempotentConsumer) Run(ctx context.Context) error {
    ic.logger.Info("idempotent consumer started")

    for {
        msg, err := ic.reader.FetchMessage(ctx)
        if err != nil {
            if errors.Is(err, context.Canceled) {
                return nil
            }
            ic.logger.Error("fetch error", "error", err)
            continue
        }

        dedupKey := ic.dedupKeyFn(msg)

        // Check if this message was already processed.
        processed, err := ic.dedup.HasProcessed(ctx, dedupKey)
        if err != nil {
            ic.logger.Error("dedup check failed",
                "dedup_key", dedupKey,
                "error", err,
            )
            // On dedup check failure, process anyway (at-least-once is better than skipping).
        }

        if processed {
            ic.logger.Debug("skipping duplicate message",
                "dedup_key", dedupKey,
                "partition", msg.Partition,
                "offset", msg.Offset,
            )
            // Commit the offset even though we skipped processing.
            if commitErr := ic.reader.CommitMessages(ctx, msg); commitErr != nil {
                ic.logger.Error("failed to commit skipped message", "error", commitErr)
            }
            continue
        }

        // Process the message.
        if err := ic.handler(ctx, msg); err != nil {
            ic.logger.Error("handler failed",
                "dedup_key", dedupKey,
                "error", err,
            )
            // Don't commit - message will be redelivered on next fetch.
            continue
        }

        // Mark as processed BEFORE committing offset.
        // This ensures that even if the commit fails and the message is
        // redelivered, we won't reprocess it.
        if err := ic.dedup.MarkProcessed(ctx, dedupKey); err != nil {
            ic.logger.Error("failed to mark as processed",
                "dedup_key", dedupKey,
                "error", err,
            )
            // Processing succeeded but dedup marking failed.
            // This is okay - worst case the dedup check will miss it and
            // the handler should be idempotent as a final safety net.
        }

        // Commit the offset.
        if err := ic.reader.CommitMessages(ctx, msg); err != nil {
            ic.logger.Error("failed to commit offset",
                "partition", msg.Partition,
                "offset", msg.Offset,
                "error", err,
            )
        }
    }
}

// Close closes the idempotent consumer.
func (ic *IdempotentConsumer) Close() error {
    return ic.reader.Close()
}
```

Here is a full example demonstrating the idempotent consumer with a PostgreSQL dedup table:

```go
// File: kafka-fundamentals/cmd/idempotent-consumer/main.go
package main

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    _ "github.com/lib/pq"
    "github.com/segmentio/kafka-go"

    exactlyonce "github.com/example/kafka-fundamentals/exactly_once"
)

// OrderEvent matches the producer's OrderEvent for deserialization.
type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    TotalCents int64     `json:"total_cents"`
    Status     string    `json:"status"`
    Region     string    `json:"region"`
    CreatedAt  time.Time `json:"created_at"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Database connection for dedup table and business logic.
    dbURL := os.Getenv("DATABASE_URL")
    if dbURL == "" {
        dbURL = "postgres://localhost:5432/orders?sslmode=disable"
    }

    db, err := sql.Open("postgres", dbURL)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    if err := db.Ping(); err != nil {
        logger.Error("database not reachable", "error", err)
        os.Exit(1)
    }

    // Create dedup store.
    dedupStore, err := exactlyonce.NewPostgresDedupStore(db, logger)
    if err != nil {
        logger.Error("failed to create dedup store", "error", err)
        os.Exit(1)
    }

    // Start a background goroutine to clean up old dedup entries.
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM,
    )
    defer cancel()

    go func() {
        ticker := time.NewTicker(1 * time.Hour)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                deleted, err := dedupStore.CleanupOldEntries(ctx, 7*24*time.Hour)
                if err != nil {
                    logger.Error("dedup cleanup failed", "error", err)
                } else {
                    logger.Info("dedup cleanup complete", "deleted", deleted)
                }
            }
        }
    }()

    brokersEnv := os.Getenv("KAFKA_BROKERS")
    if brokersEnv == "" {
        brokersEnv = "localhost:9092"
    }
    brokers := strings.Split(brokersEnv, ",")

    // Create the idempotent consumer.
    consumer, err := exactlyonce.NewIdempotentConsumer(exactlyonce.IdempotentConsumerConfig{
        Brokers:    brokers,
        Topic:      "enriched-orders",
        GroupID:    "order-db-writer",
        DedupStore: dedupStore,
        Logger:     logger,
        // Custom dedup key using the order ID from the message payload.
        DedupKeyFn: func(msg kafka.Message) string {
            var order OrderEvent
            if err := json.Unmarshal(msg.Value, &order); err != nil {
                // Fall back to topic:partition:offset if we can't parse.
                return fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset)
            }
            return fmt.Sprintf("order:%s", order.OrderID)
        },
        Handler: func(ctx context.Context, msg kafka.Message) error {
            var order OrderEvent
            if err := json.Unmarshal(msg.Value, &order); err != nil {
                logger.Error("failed to unmarshal order", "error", err)
                return nil // Skip bad data.
            }

            // Write to database - this is the external side effect.
            _, err := db.ExecContext(ctx, `
                INSERT INTO orders (order_id, customer_id, total_cents, status, region, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (order_id)
                DO UPDATE SET status = $4, updated_at = NOW()
            `, order.OrderID, order.CustomerID, order.TotalCents,
                order.Status, order.Region, order.CreatedAt)

            if err != nil {
                return fmt.Errorf("inserting order %s: %w", order.OrderID, err)
            }

            logger.Info("order written to database",
                "order_id", order.OrderID,
                "customer", order.CustomerID,
                "total_cents", order.TotalCents,
            )
            return nil
        },
    })
    if err != nil {
        logger.Error("failed to create idempotent consumer", "error", err)
        os.Exit(1)
    }
    defer consumer.Close()

    logger.Info("idempotent consumer started - processing enriched orders to database")

    if err := consumer.Run(ctx); err != nil {
        logger.Error("consumer error", "error", err)
        os.Exit(1)
    }

    logger.Info("idempotent consumer stopped cleanly")
}
```

> **Exactly-Once Reality Check**: True exactly-once is achievable *within Kafka* using transactions. For external systems (databases, HTTP APIs), the best you can achieve is "effectively exactly-once" through idempotent consumers with dedup tracking. The standard pattern at Kafka-heavy shops is an idempotency key - typically the combination of topic, partition, and offset stored in the destination system as part of the same database transaction that performs the business logic.

### Junior -> FAANG: Exactly-Once is a System Property, Not a Producer Setting

The most common misconception among new Kafka engineers is that setting `enable.idempotence=true` gives you exactly-once semantics for your entire system. It does not. Idempotence prevents duplicate messages within a single producer session within Kafka itself. It says nothing about what happens when your consumer writes to a PostgreSQL database and then crashes before committing the Kafka offset.

Build this mental checklist before claiming "exactly-once" for any pipeline:

1. Is the producer idempotent? (`enable.idempotence=true`, same PID, no producer restarts between messages.)
2. Are all writes within a Kafka transaction? (Transactional producer, `sendOffsetsToTransaction` for the input offset.)
3. Is the consumer's external write idempotent? (Database upsert with conflict handling, or the dedup table pattern.)
4. Is the external write atomic with the offset commit? (Requires either the transactional outbox pattern, or Kafka transactions where both output and offsets are inside the same transaction.)

If any of these is "no," you do not have exactly-once. You have at-least-once with some deduplication.

For first-job interviews at companies that use Kafka, be able to draw the consume-transform-produce diagram from memory and explain which failure scenarios it prevents. "The input offset is committed inside the same transaction as the output write, so if the broker crashes after committing the transaction, the consumer resumes from the committed input offset and does not re-process" is a complete and correct answer.

The `DedupStore` interface in this section is a good pattern to memorize. The interface abstraction (not tied to PostgreSQL or Redis) is the right design: you can swap the backend for testing without changing consumer logic, and you can choose the appropriate dedup backend based on the cardinality and retention requirements.

### Senior @ FAANG: Exactly-Once Semantics as an Architectural Commitment

At the senior level, the decision to implement exactly-once semantics is an architectural commitment with cost implications across the entire pipeline. Understanding these costs is what separates engineers who can make the call confidently from engineers who implement it because "the docs say it's possible."

**Transactional overhead is real and must be measured.** Kafka transactions add a transaction coordinator round trip to every commit. In high-throughput pipelines, this adds 2-10ms per transaction. At 100 transactions per second, that is acceptable. At 10,000 transactions per second, it becomes a throughput bottleneck. Profile the transactional producer against your target throughput before committing to the pattern in a design review.

**`transactional.id` fencing is the mechanism that makes EOS safe across producer restarts.** When a transactional producer initializes with a known `transactional.id`, the broker bumps the epoch. Any pending writes from an old producer instance with the same `transactional.id` but a lower epoch are rejected as "zombie writes." This is the fence that prevents a crashed-and-restarted producer from writing duplicate records during a failover window. The implication: `transactional.id` must be stable and unique per producer instance. Generating it from the pod UUID breaks the fencing guarantee because each restart gets a fresh ID.

**Exactly-once for external databases requires the transactional outbox pattern, not Kafka transactions.** The consume-transform-produce pattern guarantees exactly-once within Kafka. When the sink is a PostgreSQL database, you need the transactional outbox: write to an outbox table within the same local DB transaction that performs your business logic, then use Debezium CDC to relay outbox events to Kafka. This way, the business write and the event emission are in a single local transaction with the database's ACID guarantees. The Kafka commit is then safe to handle at-least-once because the outbox relay is idempotent (Debezium tracks WAL offsets). This is the pattern used by Netflix, Stripe, and most mature event-driven systems at scale.

**Dedup table TTL is a correctness parameter, not just a storage optimization.** The `CleanupOldEntries` function in this section deletes dedup entries older than a retention period. If you set this retention shorter than your Kafka topic retention, you create a window where a consumer can re-process an old message (from a replay or rewind scenario) and the dedup table will not catch the duplicate. Set dedup table retention to at least the maximum replay window your system supports, typically equal to or greater than topic retention.

---
