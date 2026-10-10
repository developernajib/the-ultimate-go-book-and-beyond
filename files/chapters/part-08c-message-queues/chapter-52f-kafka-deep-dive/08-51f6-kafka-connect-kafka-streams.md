## 52F.6 Kafka Connect & Kafka Streams

### Understanding Kafka Connect

Kafka Connect is a framework for streaming data between Kafka and external systems. It provides a standardized way to move data without writing custom producer/consumer code. Connect runs as a distributed service with its own cluster of **workers** that execute **connectors**.

```
┌─────────────────────────────────────────────────────────────┐
│                    Kafka Connect Cluster                    │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  │ Worker 4 │     │
│  │          │  │          │  │          │  │          │     │
│  │ Task A-1 │  │ Task A-2 │  │ Task B-1 │  │ Task B-2 │     │
│  │ Task C-1 │  │          │  │ Task C-2 │  │ Task D-1 │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│                                                             │
│  Connectors:                                                │
│    A = PostgreSQL Source (2 tasks)                          │
│    B = Elasticsearch Sink (2 tasks)                         │
│    C = S3 Sink (2 tasks)                                    │
│    D = MongoDB Source (1 task)                              │
└─────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│   Source Systems │           │   Sink Systems  │
│                  │          │                  │
│  - PostgreSQL    │          │  - Elasticsearch │
│  - MongoDB       │          │  - Amazon S3     │
│  - MySQL         │          │  - HDFS          │
│  - File System   │          │  - JDBC DBs      │
└──────────────────┘          └──────────────────┘
```

### Source vs. Sink Connectors

| Aspect | Source Connector | Sink Connector |
|--------|-----------------|----------------|
| Direction | External system → Kafka | Kafka → External system |
| Role | Produces messages to Kafka topics | Consumes messages from Kafka topics |
| Offset tracking | Tracks source position (e.g., DB binlog offset) | Uses Kafka consumer offsets |
| Examples | Debezium, JDBC Source, FileStream Source | Elasticsearch Sink, S3 Sink, JDBC Sink |
| Parallelism | Tasks split by table/partition/file | Tasks split by Kafka partitions |

### CDC with Debezium (PostgreSQL → Kafka)

Change Data Capture (CDC) captures row-level changes in a database and streams them to Kafka. Debezium is the most popular open-source CDC platform, supporting PostgreSQL, MySQL, MongoDB, SQL Server, and Oracle.

```
┌──────────────┐     WAL        ┌──────────────┐    Topics     ┌─────────┐
│  PostgreSQL  │ ──────────────►│   Debezium   │──────────────►│  Kafka  │
│              │  Logical       │  Connector   │               │         │
│  orders      │  Replication   │              │  dbserver1.   │         │
│  customers   │                │  Decodes WAL │  public.      │         │
│  products    │                │  to events   │  orders       │         │
└──────────────┘                └──────────────┘               └─────────┘
                                                                    │
                                                    ┌───────────────┤
                                                    ▼               ▼
                                              ┌──────────┐   ┌──────────┐
                                              │  Search  │    │Analytics│
                                              │  Service │    │ Service │
                                              └──────────┘   └──────────┘
```

**Setting up Debezium with Docker Compose:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: demo
      POSTGRES_PASSWORD: demo_password
      POSTGRES_DB: orders_db
    command:
      - "postgres"
      - "-c"
      - "wal_level=logical"
      - "-c"
      - "max_wal_senders=4"
      - "-c"
      - "max_replication_slots=4"
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1

  connect:
    image: debezium/connect:2.5
    depends_on:
      - kafka
      - postgres
    ports:
      - "8083:8083"
    environment:
      BOOTSTRAP_SERVERS: kafka:29092
      GROUP_ID: connect-cluster
      CONFIG_STORAGE_TOPIC: connect-configs
      OFFSET_STORAGE_TOPIC: connect-offsets
      STATUS_STORAGE_TOPIC: connect-status
      CONFIG_STORAGE_REPLICATION_FACTOR: 1
      OFFSET_STORAGE_REPLICATION_FACTOR: 1
      STATUS_STORAGE_REPLICATION_FACTOR: 1

volumes:
  pgdata:
```

**Go code to register the Debezium connector and consume CDC events:**

```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// DebeziumEnvelope represents the structure of a Debezium CDC event.
type DebeziumEnvelope struct {
	Schema  json.RawMessage `json:"schema"`
	Payload DebeziumPayload `json:"payload"`
}

// DebeziumPayload holds the before/after states and metadata of a change.
type DebeziumPayload struct {
	Before    map[string]any `json:"before"`
	After     map[string]any `json:"after"`
	Source    DebeziumSource         `json:"source"`
	Operation string                 `json:"op"`
	Timestamp int64                  `json:"ts_ms"`
}

// DebeziumSource contains metadata about where the change originated.
type DebeziumSource struct {
	Version   string `json:"version"`
	Connector string `json:"connector"`
	Name      string `json:"name"`
	Database  string `json:"db"`
	Schema    string `json:"schema"`
	Table     string `json:"table"`
	TxID      int64  `json:"txId"`
	LSN       int64  `json:"lsn"`
	Snapshot  string `json:"snapshot"`
}

// ConnectorConfig defines the Debezium connector registration payload.
type ConnectorConfig struct {
	Name   string            `json:"name"`
	Config map[string]string `json:"config"`
}

// registerDebeziumConnector sends a connector configuration to Kafka Connect.
func registerDebeziumConnector(connectURL string) error {
	config := ConnectorConfig{
		Name: "orders-connector",
		Config: map[string]string{
			"connector.class":                 "io.debezium.connector.postgresql.PostgresConnector",
			"database.hostname":               "postgres",
			"database.port":                   "5432",
			"database.user":                   "demo",
			"database.password":               "demo_password",
			"database.dbname":                 "orders_db",
			"topic.prefix":                    "dbserver1",
			"table.include.list":              "public.orders,public.customers",
			"plugin.name":                     "pgoutput",
			"slot.name":                       "debezium_orders",
			"publication.name":                "dbz_publication",
			"snapshot.mode":                   "initial",
			"tombstones.on.delete":            "true",
			"key.converter":                   "org.apache.kafka.connect.json.JsonConverter",
			"value.converter":                 "org.apache.kafka.connect.json.JsonConverter",
			"key.converter.schemas.enable":    "false",
			"value.converter.schemas.enable":  "true",
			"transforms":                      "unwrap",
			"transforms.unwrap.type":          "io.debezium.transforms.ExtractNewRecordState",
			"transforms.unwrap.drop.tombstones":        "false",
			"transforms.unwrap.delete.handling.mode":    "rewrite",
			"transforms.unwrap.add.fields":              "op,table,lsn,source.ts_ms",
			"heartbeat.interval.ms":           "10000",
			"errors.tolerance":                "all",
			"errors.deadletterqueue.topic.name":         "dlq-cdc-orders",
			"errors.deadletterqueue.context.headers.enable": "true",
		},
	}

	body, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("marshaling connector config: %w", err)
	}

	resp, err := http.Post(
		connectURL+"/connectors",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("registering connector: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusConflict {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// CDCEventHandler processes Change Data Capture events from Debezium.
type CDCEventHandler struct {
	logger *slog.Logger
}

// Setup is called at the beginning of a new consumer group session.
func (h *CDCEventHandler) Setup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("CDC consumer session started",
		"member_id", session.MemberID(),
		"generation_id", session.GenerationID(),
	)
	return nil
}

// Cleanup is called at the end of a consumer group session.
func (h *CDCEventHandler) Cleanup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("CDC consumer session ended")
	return nil
}

// ConsumeClaim processes messages from a claimed partition.
func (h *CDCEventHandler) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	for msg := range claim.Messages() {
		if err := h.processMessage(msg); err != nil {
			h.logger.Error("failed to process CDC event",
				"error", err,
				"topic", msg.Topic,
				"partition", msg.Partition,
				"offset", msg.Offset,
			)
			// Continue processing; the dead letter queue connector
			// configuration handles persistent failures.
		}
		session.MarkMessage(msg, "")
	}
	return nil
}

// processMessage parses and handles a single Debezium CDC event.
func (h *CDCEventHandler) processMessage(msg *sarama.ConsumerMessage) error {
	// Tombstone messages (null value) indicate a delete after compaction.
	if msg.Value == nil {
		h.logger.Debug("received tombstone message",
			"key", string(msg.Key),
			"topic", msg.Topic,
		)
		return nil
	}

	var envelope DebeziumEnvelope
	if err := json.Unmarshal(msg.Value, &envelope); err != nil {
		return fmt.Errorf("unmarshaling CDC event: %w", err)
	}

	payload := envelope.Payload
	table := payload.Source.Table

	switch payload.Operation {
	case "c": // Create
		h.logger.Info("INSERT detected",
			"table", table,
			"data", payload.After,
			"lsn", payload.Source.LSN,
		)
		return h.handleInsert(table, payload.After)

	case "u": // Update
		h.logger.Info("UPDATE detected",
			"table", table,
			"before", payload.Before,
			"after", payload.After,
			"lsn", payload.Source.LSN,
		)
		return h.handleUpdate(table, payload.Before, payload.After)

	case "d": // Delete
		h.logger.Info("DELETE detected",
			"table", table,
			"data", payload.Before,
			"lsn", payload.Source.LSN,
		)
		return h.handleDelete(table, payload.Before)

	case "r": // Read (snapshot)
		h.logger.Debug("SNAPSHOT record",
			"table", table,
			"data", payload.After,
		)
		return h.handleInsert(table, payload.After)

	default:
		h.logger.Warn("unknown operation", "op", payload.Operation)
	}

	return nil
}

func (h *CDCEventHandler) handleInsert(table string, data map[string]any) error {
	// In production, you would update a search index, cache, or
	// materialized view based on the table and inserted data.
	h.logger.Info("processing insert",
		"table", table,
		"record_id", data["id"],
	)
	return nil
}

func (h *CDCEventHandler) handleUpdate(
	table string,
	before, after map[string]any,
) error {
	// Compute changed fields for targeted updates.
	changed := make(map[string]any)
	for key, newVal := range after {
		if oldVal, exists := before[key]; exists {
			if fmt.Sprintf("%v", oldVal) != fmt.Sprintf("%v", newVal) {
				changed[key] = newVal
			}
		}
	}

	h.logger.Info("processing update",
		"table", table,
		"record_id", after["id"],
		"changed_fields", changed,
	)
	return nil
}

func (h *CDCEventHandler) handleDelete(table string, data map[string]any) error {
	h.logger.Info("processing delete",
		"table", table,
		"record_id", data["id"],
	)
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	// Step 1: Register the Debezium connector.
	connectURL := getEnv("CONNECT_URL", "http://localhost:8083")
	if err := registerDebeziumConnector(connectURL); err != nil {
		logger.Error("failed to register connector", "error", err)
		os.Exit(1)
	}
	logger.Info("Debezium connector registered successfully")

	// Step 2: Consume CDC events from Debezium topics.
	brokers := strings.Split(getEnv("KAFKA_BROKERS", "localhost:9092"), ",")
	group := getEnv("CONSUMER_GROUP", "cdc-consumer-group")
	topics := []string{
		"dbserver1.public.orders",
		"dbserver1.public.customers",
	}

	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyCooperativeSticky(),
	}
	config.Consumer.Offsets.Initial = sarama.OffsetOldest
	config.Consumer.Offsets.AutoCommit.Enable = true
	config.Consumer.Offsets.AutoCommit.Interval = 1 * time.Second

	client, err := sarama.NewConsumerGroup(brokers, group, config)
	if err != nil {
		logger.Error("failed to create consumer group", "error", err)
		os.Exit(1)
	}
	defer client.Close()

	handler := &CDCEventHandler{logger: logger}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		logger.Info("shutdown signal received")
		cancel()
	}()

	logger.Info("starting CDC consumer", "topics", topics, "group", group)

	for {
		if err := client.Consume(ctx, topics, handler); err != nil {
			logger.Error("consumer error", "error", err)
		}
		if ctx.Err() != nil {
			break
		}
	}

	logger.Info("CDC consumer shut down")
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
```

### Stream Processing Concepts

Stream processing transforms data as it flows through Kafka. The key abstractions in stream processing are:

```
┌──────────────────────────────────────────────────────────┐
│                Stream Processing Concepts                │
│                                                          │
│  KStream (Event Stream)                                  │
│  ┌─────┬─────┬─────┬─────┬─────┬─────┐                   │
│  │ e1  │ e2  │ e3  │ e4  │ e5  │ e6  │  Each record      │
│  │ k:A │ k:B │ k:A │ k:C │ k:A │ k:B │  is independent   │
│  │ v:1 │ v:2 │ v:3 │ v:4 │ v:5 │ v:6 │                   │
│  └─────┴─────┴─────┴─────┴─────┴─────┘                   │
│                                                          │
│  KTable (Changelog Stream)                               │
│  ┌─────┬─────┬─────┐                                     │
│  │ k:A │ k:B │ k:C │  Latest value per key               │
│  │ v:5 │ v:6 │ v:4 │  (upsert semantics)                 │
│  └─────┴─────┴─────┘                                     │
│                                                          │
│  Windowing                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                  │
│  │ Window 1 │ │ Window 2 │ │ Window 3 │                  │
│  │ 00:00-   │ │ 00:05-   │ │ 00:10-   │  Tumbling:       │
│  │ 00:05    │ │ 00:10    │ │ 00:15    │  fixed, no       │
│  │ [e1,e2]  │ │ [e3,e4]  │ │ [e5,e6]  │  overlap         │
│  └──────────┘ └──────────┘ └──────────┘                  │
│                                                          │
│  ┌──────────────┐                                        │
│  │  Window 1    │  ┌──────────────┐                      │
│  │  00:00-00:10 │  │  Window 2    │                      │
│  │  [e1,e2,e3]  │  │  00:05-00:15 │  Sliding/Hopping:    │
│  └──────────────┘  │  [e3,e4,e5]  │  overlap allowed     │
│                    └──────────────┘                      │
│                                                          │
│  Session Windows                                         │
│  ┌────────┐    ┌──────────────┐    ┌─────┐               │
│  │ gap    │    │   gap        │    │     │ Defined by    │
│  │[e1,e2] │    │ [e4,e5,e6]   │   │[e8] │ inactivity     │
│  └────────┘    └──────────────┘    └─────┘ gap           │
└──────────────────────────────────────────────────────────┘
```

### Go Alternatives to Kafka Streams

Kafka Streams is a JVM-only library. In Go, you have several alternatives:

| Solution | Type | Best For |
|----------|------|----------|
| Custom Go processor | Library | Full control, simple topologies |
| Benthos (now Redpanda Connect) | Framework | Complex pipelines, many connectors |
| Watermill | Library | Event-driven microservices |
| Goka | Library | Kafka-specific stream processing |
| Custom with sarama/franz-go | Library | Maximum performance |

### Go Custom Stream Processor with Windowed Aggregation

Kafka Streams handles windowed aggregation on the JVM, but Go services often need the same capability without a JVM dependency. The following implementation builds a tumbling-window aggregator in pure Go that reads from Kafka, accumulates state in memory with time-bucketed maps, and emits results downstream when each window closes.

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// WindowType defines the type of windowing strategy.
type WindowType int

const (
	TumblingWindow WindowType = iota
	SlidingWindow
	SessionWindow
)

// AggregateFunc defines a function that combines two values.
type AggregateFunc func(existing, incoming any) any

// WindowedKey uniquely identifies a key within a specific time window.
type WindowedKey struct {
	Key         string
	WindowStart time.Time
	WindowEnd   time.Time
}

// WindowStore holds aggregated state for windowed computations.
type WindowStore struct {
	mu       sync.RWMutex
	windows  map[WindowedKey]any
	expiry   map[WindowedKey]time.Time
	retention time.Duration
}

// NewWindowStore creates a WindowStore with the given retention duration.
func NewWindowStore(retention time.Duration) *WindowStore {
	store := &WindowStore{
		windows:   make(map[WindowedKey]any),
		expiry:    make(map[WindowedKey]time.Time),
		retention: retention,
	}

	// Start background cleanup of expired windows.
	go store.cleanupLoop()
	return store
}

// Put adds or updates a value in the window store.
func (ws *WindowStore) Put(key WindowedKey, value any) {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	ws.windows[key] = value
	ws.expiry[key] = time.Now().Add(ws.retention)
}

// Get retrieves a value from the window store.
func (ws *WindowStore) Get(key WindowedKey) (any, bool) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()
	val, ok := ws.windows[key]
	return val, ok
}

// GetAll returns all current window entries.
func (ws *WindowStore) GetAll() map[WindowedKey]any {
	ws.mu.RLock()
	defer ws.mu.RUnlock()
	result := make(map[WindowedKey]any, len(ws.windows))
	for k, v := range ws.windows {
		result[k] = v
	}
	return result
}

func (ws *WindowStore) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		ws.mu.Lock()
		now := time.Now()
		for key, exp := range ws.expiry {
			if now.After(exp) {
				delete(ws.windows, key)
				delete(ws.expiry, key)
			}
		}
		ws.mu.Unlock()
	}
}

// StreamEvent represents an incoming event to process.
type StreamEvent struct {
	Key       string
	Value     json.RawMessage
	Timestamp time.Time
	Topic     string
	Partition int32
	Offset    int64
}

// StreamProcessor processes Kafka messages with windowed aggregation.
type StreamProcessor struct {
	store      *WindowStore
	windowSize time.Duration
	windowType WindowType
	aggregate  AggregateFunc
	initialVal any
	emitFunc   func(key WindowedKey, value any) error
	logger     *slog.Logger
}

// StreamProcessorConfig holds configuration for creating a StreamProcessor.
type StreamProcessorConfig struct {
	WindowSize time.Duration
	WindowType WindowType
	Aggregate  AggregateFunc
	InitialVal any
	Retention  time.Duration
	EmitFunc   func(key WindowedKey, value any) error
	Logger     *slog.Logger
}

// NewStreamProcessor creates a new windowed stream processor.
func NewStreamProcessor(cfg StreamProcessorConfig) *StreamProcessor {
	return &StreamProcessor{
		store:      NewWindowStore(cfg.Retention),
		windowSize: cfg.WindowSize,
		windowType: cfg.WindowType,
		aggregate:  cfg.Aggregate,
		initialVal: cfg.InitialVal,
		emitFunc:   cfg.EmitFunc,
		logger:     cfg.Logger,
	}
}

// Process handles a single incoming event.
func (sp *StreamProcessor) Process(event StreamEvent) error {
	windowKey := sp.computeWindow(event)

	existing, found := sp.store.Get(windowKey)
	if !found {
		existing = sp.initialVal
	}

	var incoming any
	if err := json.Unmarshal(event.Value, &incoming); err != nil {
		return fmt.Errorf("unmarshaling event value: %w", err)
	}

	newVal := sp.aggregate(existing, incoming)
	sp.store.Put(windowKey, newVal)

	if sp.emitFunc != nil {
		if err := sp.emitFunc(windowKey, newVal); err != nil {
			return fmt.Errorf("emitting result: %w", err)
		}
	}

	return nil
}

func (sp *StreamProcessor) computeWindow(event StreamEvent) WindowedKey {
	switch sp.windowType {
	case TumblingWindow:
		windowStart := event.Timestamp.Truncate(sp.windowSize)
		return WindowedKey{
			Key:         event.Key,
			WindowStart: windowStart,
			WindowEnd:   windowStart.Add(sp.windowSize),
		}

	case SlidingWindow:
		// For sliding windows, we use the event time as the window end.
		return WindowedKey{
			Key:         event.Key,
			WindowStart: event.Timestamp.Add(-sp.windowSize),
			WindowEnd:   event.Timestamp,
		}

	default:
		windowStart := event.Timestamp.Truncate(sp.windowSize)
		return WindowedKey{
			Key:         event.Key,
			WindowStart: windowStart,
			WindowEnd:   windowStart.Add(sp.windowSize),
		}
	}
}

// MetricsAggregation represents aggregated metrics within a window.
type MetricsAggregation struct {
	Count        int64     `json:"count"`
	SumCents     int64     `json:"sum_cents"`
	MinCents     int64     `json:"min_cents"`
	MaxCents     int64     `json:"max_cents"`
	AverageCents int64     `json:"average_cents"`
	LastUpdate   time.Time `json:"last_update"`
}

// OrderEvent represents an order event for aggregation.
type OrderEvent struct {
	OrderID     string `json:"order_id"`
	AmountCents int64  `json:"amount_cents"`
	Category    string `json:"category"`
	Timestamp   string `json:"timestamp"`
}

// StreamConsumerHandler bridges Kafka consumer groups with the stream processor.
type StreamConsumerHandler struct {
	processor *StreamProcessor
	logger    *slog.Logger
}

// Setup is called at the beginning of a new consumer group session.
func (h *StreamConsumerHandler) Setup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("stream processor session started",
		"generation", session.GenerationID(),
	)
	return nil
}

// Cleanup is called at the end of a consumer group session.
func (h *StreamConsumerHandler) Cleanup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("stream processor session ended")
	return nil
}

// ConsumeClaim processes messages from a claimed partition.
func (h *StreamConsumerHandler) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	for msg := range claim.Messages() {
		event := StreamEvent{
			Key:       string(msg.Key),
			Value:     msg.Value,
			Timestamp: msg.Timestamp,
			Topic:     msg.Topic,
			Partition: msg.Partition,
			Offset:    msg.Offset,
		}

		if err := h.processor.Process(event); err != nil {
			h.logger.Error("failed to process event",
				"error", err,
				"key", event.Key,
				"offset", event.Offset,
			)
		}

		session.MarkMessage(msg, "")
	}
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Configure the aggregation function for order amounts.
	aggregateOrders := func(existing, incoming any) any {
		agg, ok := existing.(*MetricsAggregation)
		if !ok {
			agg = &MetricsAggregation{
				MinCents: 1<<63 - 1,
			}
		}

		// Parse the incoming order event.
		data, ok := incoming.(map[string]any)
		if !ok {
			return agg
		}

		var amountCents int64
		switch v := data["amount_cents"].(type) {
		case float64:
			amountCents = int64(v)
		case int64:
			amountCents = v
		default:
			return agg
		}

		agg.Count++
		agg.SumCents += amountCents
		agg.AverageCents = agg.SumCents / agg.Count
		agg.LastUpdate = time.Now()

		if amountCents < agg.MinCents {
			agg.MinCents = amountCents
		}
		if amountCents > agg.MaxCents {
			agg.MaxCents = amountCents
		}

		return agg
	}

	// Emit function sends aggregated results to an output topic.
	emitResults := func(key WindowedKey, value any) error {
		agg, ok := value.(*MetricsAggregation)
		if !ok {
			return fmt.Errorf("unexpected value type: %T", value)
		}

		logger.Info("window aggregation result",
			"key", key.Key,
			"window_start", key.WindowStart.Format(time.RFC3339),
			"window_end", key.WindowEnd.Format(time.RFC3339),
			"count", agg.Count,
			"sum_cents", agg.SumCents,
			"average_cents", agg.AverageCents,
			"min_cents", agg.MinCents,
			"max_cents", agg.MaxCents,
		)

		return nil
	}

	processor := NewStreamProcessor(StreamProcessorConfig{
		WindowSize: 5 * time.Minute,
		WindowType: TumblingWindow,
		Aggregate:  aggregateOrders,
		InitialVal: &MetricsAggregation{MinCents: 1<<63 - 1},
		Retention:  1 * time.Hour,
		EmitFunc:   emitResults,
		Logger:     logger,
	})

	// Set up Kafka consumer.
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyCooperativeSticky(),
	}
	config.Consumer.Offsets.Initial = sarama.OffsetOldest

	brokers := []string{"localhost:9092"}
	group := "stream-processor-group"
	topics := []string{"orders"}

	client, err := sarama.NewConsumerGroup(brokers, group, config)
	if err != nil {
		logger.Error("failed to create consumer group", "error", err)
		os.Exit(1)
	}
	defer client.Close()

	handler := &StreamConsumerHandler{
		processor: processor,
		logger:    logger,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	logger.Info("starting stream processor",
		"window_size", "5m",
		"window_type", "tumbling",
		"topics", topics,
	)

	for {
		if err := client.Consume(ctx, topics, handler); err != nil {
			logger.Error("consumer error", "error", err)
		}
		if ctx.Err() != nil {
			break
		}
	}

	// Print final window state.
	logger.Info("final window state")
	for key, val := range processor.store.GetAll() {
		agg := val.(*MetricsAggregation)
		logger.Info("window",
			"key", key.Key,
			"start", key.WindowStart,
			"end", key.WindowEnd,
			"count", agg.Count,
			"sum_cents", agg.SumCents,
			"avg_cents", agg.AverageCents,
		)
	}

	logger.Info("stream processor shut down")
}
```

> **Stream Processing in Go**: Kafka Streams is JVM-only, but Go's goroutines and channels map naturally to stream processing topologies. Shopify's custom Go stream processors handle over 500K events/second per instance with roughly 3x better memory efficiency than equivalent Kafka Streams applications. Go's concurrency primitives handle the plumbing that frameworks provide in other languages, build what you need, benchmark it, and scale horizontally.

### Junior -> FAANG: Choosing Between Kafka Connect and Custom Go Code

New engineers often default to writing custom consumers when Kafka Connect would be the correct tool, or they reach for Kafka Connect when a simple Go consumer would suffice. Understanding when each is appropriate saves significant engineering time.

**Reach for Kafka Connect when:** the source or sink is a well-supported system with an existing connector (PostgreSQL via Debezium, Elasticsearch, S3, BigQuery). These connectors handle schema evolution, exactly-once delivery, dead-letter routing, and connector lifecycle management for you. Writing a custom consumer to replicate PostgreSQL CDC to Elasticsearch is reinventing Debezium, and Debezium has 5 years of production hardening you will not replicate.

**Write custom Go code when:** you need business logic in the pipeline (not just data movement), the connector ecosystem does not support your source or sink, or you need fine-grained control over offset management, error handling, or throughput tuning. The CDC consumer in this section (consuming Debezium output and updating a search index with business-rule-based filtering) is a good example: the data movement is handled by Debezium, and the Go consumer only handles the business logic.

The windowed aggregation `StreamProcessor` in this section is worth understanding even if you never use it directly. Tumbling windows (non-overlapping, fixed-size) are simpler to implement correctly than sliding windows. The `WindowedKey` struct keying state by both the entity key and the time window allows multiple concurrent windows to accumulate without interference. The cleanup goroutine preventing unbounded memory growth is a pattern that every stateful consumer needs.

### Senior @ FAANG: Kafka Connect Governance and Stream Processing Architecture Choices

At the senior level, Kafka Connect is a platform deployment that requires governance, not just a connector you configure and forget. The decisions you make about Connect topology, error handling, and monitoring affect the reliability of every data pipeline in your organization.

**Distributed Connect cluster sizing and task placement.** The Connect diagram shows four workers with tasks distributed across them. At production scale, size your Connect cluster for peak task count plus 30% headroom for rebalancing during worker restarts. Connect rebalances tasks when a worker joins or leaves, similar to consumer group rebalancing. During rebalance, tasks on affected workers pause. Size for N+1 workers so a single worker restart does not trigger task redistribution that impacts throughput SLAs.

**Dead-letter topic configuration is not optional.** The Debezium connector configuration in this section includes `errors.deadletterqueue.topic.name` and `errors.deadletterqueue.context.headers.enable`. Without a DLQ, a deserialization error or schema incompatibility causes the connector to stop and requires manual intervention. With a DLQ, failed records are routed to a separate topic with context headers (original topic, partition, offset, error message) and the connector continues processing. Write a DLQ consumer that alerts on non-empty DLQ topics. At scale, a non-zero DLQ message count is a data loss event, not just a warning.

**Go stream processing vs JVM Kafka Streams tradeoff at the staff level.** The decision between the custom Go stream processor and Kafka Streams (JVM) should be an ADR, not a preference. Kafka Streams provides: a fault-tolerant state store backed by RocksDB and replicated via changelog topics, join semantics between streams and tables, and a DSL for declaring topologies. The Go processor in this section provides: lower memory overhead, no JVM dependency, and full control over state management, but requires you to implement fault-tolerant state, changelog replication, and join semantics yourself. The right answer depends on team familiarity, infrastructure constraints (JVM deployment complexity, GC tuning), and the complexity of the processing topology. Document the tradeoffs explicitly in the ADR. "We chose Go because the team knows Go" is not a sufficient justification if the topology requires stateful joins.

**Monitoring Connect connectors as part of the platform SLA.** Connect connector status (RUNNING, PAUSED, FAILED) must be scraped via the REST API (`GET /connectors/{name}/status`) and exported to Prometheus. A FAILED connector that is not detected for 30 minutes means 30 minutes of data that is not flowing to your sinks. Set an alert on any connector entering FAILED state with a 2-minute threshold. The kafka-connect-monitoring library or a custom scraper hitting the Connect REST API every 30 seconds is the standard approach.

---
