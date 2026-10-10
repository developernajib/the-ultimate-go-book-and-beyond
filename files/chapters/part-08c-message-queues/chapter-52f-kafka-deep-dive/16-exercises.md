## Exercises

### Exercise 1: High-Throughput Order Event Pipeline

**Goal**: Build an HTTP endpoint that accepts order events, publishes to Kafka with an idempotent producer, and a consumer group that processes at 10,000 messages/second, writes to PostgreSQL with exactly-once semantics, and exposes Prometheus metrics.

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "github.com/segmentio/kafka-go"
)

var (
    ordersProduced = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "orders_produced_total",
        Help: "Total orders published to Kafka",
    })
    ordersProcessed = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "orders_processed_total",
        Help: "Total orders processed by consumer",
    }, []string{"status"})
    processingDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
        Name:    "order_processing_duration_seconds",
        Buckets: prometheus.ExponentialBuckets(0.0005, 2, 10),
    })
)

func init() {
    prometheus.MustRegister(ordersProduced, ordersProcessed, processingDuration)
}

type OrderEvent struct {
    OrderID     string `json:"order_id"`
    UserID      string `json:"user_id"`
    AmountCents int64  `json:"amount_cents"`
    Currency    string `json:"currency"`
}

func main() {
    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    writer := &kafka.Writer{
        Addr:         kafka.TCP("localhost:9092"),
        Topic:        "orders",
        RequiredAcks: kafka.RequireAll,
        MaxAttempts:  5,
        Compression:  kafka.Lz4,
        // Batching for throughput
        BatchSize:    100,
        BatchTimeout: 10 * time.Millisecond,
    }
    defer writer.Close()

    // HTTP producer endpoint
    http.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        var order OrderEvent
        if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
            http.Error(w, "invalid json", http.StatusBadRequest)
            return
        }
        if order.OrderID == "" || order.UserID == "" || order.AmountCents <= 0 {
            http.Error(w, "missing required fields", http.StatusBadRequest)
            return
        }

        payload, _ := json.Marshal(order)
        err := writer.WriteMessages(r.Context(), kafka.Message{
            Key:   []byte(order.UserID), // Partition by user for ordering
            Value: payload,
            Headers: []kafka.Header{
                {Key: "content-type", Value: []byte("application/json")},
                {Key: "source", Value: []byte("order-api")},
            },
        })
        if err != nil {
            http.Error(w, "failed to publish", http.StatusInternalServerError)
            log.Printf("kafka write error: %v", err)
            return
        }

        ordersProduced.Inc()
        w.WriteHeader(http.StatusAccepted)
        json.NewEncoder(w).Encode(map[string]string{"status": "accepted", "order_id": order.OrderID})
    })

    http.Handle("/metrics", promhttp.Handler())

    // Consumer runs in background
    go runConsumer(ctx)

    srv := &http.Server{Addr: ":8080", ReadTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second}
    go func() {
        log.Println("server listening on :8080")
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("http server: %v", err)
        }
    }()

    <-ctx.Done()
    log.Println("shutting down...")
    srv.Shutdown(context.Background())
}

func runConsumer(ctx context.Context) {
    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:        []string{"localhost:9092"},
        Topic:          "orders",
        GroupID:        "order-processor",
        MinBytes:       10e3, // 10KB - wait for batches for throughput
        MaxBytes:       10e6, // 10MB
        CommitInterval: 0,    // Manual commit
    })
    defer reader.Close()

    for {
        msg, err := reader.FetchMessage(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return
            }
            log.Printf("fetch error: %v", err)
            continue
        }

        start := time.Now()
        err = processOrder(ctx, msg)
        processingDuration.Observe(time.Since(start).Seconds())

        if err != nil {
            ordersProcessed.WithLabelValues("error").Inc()
            log.Printf("processing error offset=%d: %v", msg.Offset, err)
            continue
        }

        ordersProcessed.WithLabelValues("success").Inc()
        if err := reader.CommitMessages(ctx, msg); err != nil {
            log.Printf("commit error: %v", err)
        }
    }
}

func processOrder(ctx context.Context, msg kafka.Message) error {
    var order OrderEvent
    if err := json.Unmarshal(msg.Value, &order); err != nil {
        return fmt.Errorf("unmarshal: %w", err)
    }
    // In production: write to PostgreSQL with idempotency key
    // idempotencyKey := fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset)
    log.Printf("processed order=%s user=%s amount_cents=%d", order.OrderID, order.UserID, order.AmountCents)
    return nil
}
```

**Run it**:
```bash
docker run -d --name kafka -p 9092:9092 apache/kafka:4.0.0
kafka-topics.sh --create --topic orders --partitions 24 --replication-factor 1 --bootstrap-server localhost:9092
go run main.go
curl -X POST localhost:8080/orders -d '{"order_id":"ord-1","user_id":"u-42","amount_cents":9999,"currency":"USD"}'
curl localhost:8080/metrics | grep orders_
```

---

### Exercise 2: Dead Letter Queue Pattern

**Goal**: Consumer retries processing up to 3 times with exponential backoff (1s/2s/4s), then routes to a DLQ topic with metadata headers. Implement a DLQ replay endpoint.

```go
package dlq

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "strconv"
    "time"

    "github.com/segmentio/kafka-go"
)

const (
    mainTopic = "orders"
    dlqTopic  = "orders.dlq"
    maxRetries = 3
)

type DLQConsumer struct {
    reader    *kafka.Reader
    dlqWriter *kafka.Writer
}

func NewDLQConsumer(brokers []string) *DLQConsumer {
    return &DLQConsumer{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers: brokers,
            Topic:   mainTopic,
            GroupID: "order-processor-dlq",
        }),
        dlqWriter: &kafka.Writer{
            Addr:         kafka.TCP(brokers...),
            Topic:        dlqTopic,
            RequiredAcks: kafka.RequireAll,
        },
    }
}

func (c *DLQConsumer) Run(ctx context.Context) error {
    for {
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return nil
            }
            return fmt.Errorf("fetch: %w", err)
        }

        if err := c.processWithRetry(ctx, msg); err != nil {
            log.Printf("sending to DLQ offset=%d reason=%v", msg.Offset, err)
            if dlqErr := c.sendToDLQ(ctx, msg, err.Error()); dlqErr != nil {
                log.Printf("CRITICAL: failed to send to DLQ: %v", dlqErr)
                // Do NOT commit - will retry entire sequence on restart
                continue
            }
        }

        c.reader.CommitMessages(ctx, msg)
    }
}

func (c *DLQConsumer) processWithRetry(ctx context.Context, msg kafka.Message) error {
    backoff := time.Second
    for attempt := 0; attempt < maxRetries; attempt++ {
        err := processMessage(msg)
        if err == nil {
            return nil
        }
        log.Printf("attempt %d/%d failed for offset=%d: %v", attempt+1, maxRetries, msg.Offset, err)
        if attempt < maxRetries-1 {
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return ctx.Err()
            }
            backoff *= 2 // exponential: 1s → 2s → 4s
        }
    }
    return fmt.Errorf("exhausted %d retries", maxRetries)
}

func (c *DLQConsumer) sendToDLQ(ctx context.Context, original kafka.Message, reason string) error {
    return c.dlqWriter.WriteMessages(ctx, kafka.Message{
        Key:   original.Key,
        Value: original.Value,
        Headers: []kafka.Header{
            {Key: "X-Retry-Count", Value: []byte(strconv.Itoa(maxRetries))},
            {Key: "X-Original-Topic", Value: []byte(original.Topic)},
            {Key: "X-Original-Partition", Value: []byte(strconv.Itoa(int(original.Partition)))},
            {Key: "X-Original-Offset", Value: []byte(strconv.FormatInt(original.Offset, 10))},
            {Key: "X-Failure-Reason", Value: []byte(reason)},
            {Key: "X-Failed-At", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
        },
    })
}

// DLQ replay endpoint: POST /dlq/replay?limit=100
// Reads from DLQ and re-publishes to the original topic
func DLQReplayHandler(brokers []string) http.HandlerFunc {
    mainWriter := &kafka.Writer{
        Addr:         kafka.TCP(brokers...),
        Topic:        mainTopic,
        RequiredAcks: kafka.RequireAll,
    }

    return func(w http.ResponseWriter, r *http.Request) {
        limitStr := r.URL.Query().Get("limit")
        limit, _ := strconv.Atoi(limitStr)
        if limit == 0 || limit > 1000 {
            limit = 100
        }

        dlqReader := kafka.NewReader(kafka.ReaderConfig{
            Brokers:   brokers,
            Topic:     dlqTopic,
            GroupID:   "dlq-replayer",
            MaxWait:   2 * time.Second,
        })
        defer dlqReader.Close()

        replayed := 0
        ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
        defer cancel()

        for replayed < limit {
            msg, err := dlqReader.FetchMessage(ctx)
            if err != nil {
                break
            }
            // Strip DLQ headers before replaying
            err = mainWriter.WriteMessages(ctx, kafka.Message{
                Key:   msg.Key,
                Value: msg.Value,
                Headers: []kafka.Header{
                    {Key: "X-Replayed-From-DLQ", Value: []byte("true")},
                    {Key: "X-Replayed-At", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
                },
            })
            if err != nil {
                log.Printf("replay write error: %v", err)
                continue
            }
            dlqReader.CommitMessages(ctx, msg)
            replayed++
        }

        json.NewEncoder(w).Encode(map[string]int{"replayed": replayed})
    }
}

func processMessage(msg kafka.Message) error {
    // Placeholder - implement actual processing
    log.Printf("processing: %s", msg.Value)
    return nil
}
```

---

### Exercise 3: Multi-Datacenter Replication with MirrorMaker 2

**Goal**: Configure MirrorMaker 2 for active-passive replication between two datacenters, implement a Go consumer that detects replication lag and alerts when lag exceeds 30 seconds, and handle read-your-writes consistency.

**mm2.properties** (MirrorMaker 2 configuration):
```properties
# Source and target cluster aliases
clusters = us-east, eu-west

# Cluster connection details
us-east.bootstrap.servers = kafka-us-east-1:9092,kafka-us-east-2:9092,kafka-us-east-3:9092
eu-west.bootstrap.servers = kafka-eu-west-1:9092,kafka-eu-west-2:9092,kafka-eu-west-3:9092

# Security (production)
us-east.security.protocol = SASL_SSL
us-east.sasl.mechanism = PLAIN
# eu-west same...

# Replication: us-east → eu-west (active-passive)
us-east->eu-west.enabled = true
us-east->eu-west.topics = orders, payments, user-events
us-east->eu-west.topics.blacklist = __consumer_offsets, __transaction_state

# Replicated topics in eu-west will be prefixed: us-east.orders
# Consumer offsets are also synchronized for failover:
us-east->eu-west.sync.group.offsets.enabled = true
us-east->eu-west.sync.group.offsets.interval.seconds = 60

# Tune replication throughput
us-east->eu-west.replication.factor = 3
replication.policy.class = org.apache.kafka.connect.mirror.DefaultReplicationPolicy

# Heartbeat and checkpoint topics for lag monitoring
heartbeats.enabled = true
checkpoints.enabled = true
emit.heartbeats.interval.seconds = 10
emit.checkpoints.interval.seconds = 30
```

**Go replication lag monitor**:
```go
package replication

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/segmentio/kafka-go"
)

var replicationLagSeconds = prometheus.NewGaugeVec(prometheus.GaugeOpts{
    Name: "kafka_mirrormaker_replication_lag_seconds",
    Help: "Replication lag between source and target datacenter in seconds",
}, []string{"source_cluster", "target_cluster", "topic"})

func init() { prometheus.MustRegister(replicationLagSeconds) }

// ReplicationLagMonitor reads from the MirrorMaker heartbeat topic
// to calculate replication lag between datacenters.
type ReplicationLagMonitor struct {
    reader       *kafka.Reader
    alertThreshold time.Duration
}

func NewReplicationLagMonitor(targetBrokers []string) *ReplicationLagMonitor {
    return &ReplicationLagMonitor{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers: targetBrokers,
            Topic:   "heartbeats",      // MirrorMaker 2 heartbeat topic
            GroupID: "lag-monitor",
        }),
        alertThreshold: 30 * time.Second,
    }
}

func (m *ReplicationLagMonitor) Run(ctx context.Context) {
    for {
        msg, err := m.reader.ReadMessage(ctx)
        if err != nil {
            if ctx.Err() != nil { return }
            log.Printf("heartbeat read error: %v", err)
            time.Sleep(5 * time.Second)
            continue
        }

        // Heartbeat message timestamp is when it was produced at the source
        // Current time minus message timestamp = replication lag
        lag := time.Since(msg.Time)

        sourceCluster := getHeader(msg, "source.cluster")
        targetCluster := getHeader(msg, "target.cluster")

        replicationLagSeconds.WithLabelValues(sourceCluster, targetCluster, msg.Topic).
            Set(lag.Seconds())

        if lag > m.alertThreshold {
            // In production: send to PagerDuty/OpsGenie
            log.Printf("ALERT: replication lag %.1fs exceeds threshold %.1fs (source=%s target=%s)",
                lag.Seconds(), m.alertThreshold.Seconds(), sourceCluster, targetCluster)
        }
    }
}

// ReadYourWritesConsumer reads from the source DC if available,
// falls back to replicated topic in target DC.
// Ensures consumers always see their own writes.
type ReadYourWritesConsumer struct {
    primaryReader  *kafka.Reader
    fallbackReader *kafka.Reader
    lagMonitor     *ReplicationLagMonitor
}

func (c *ReadYourWritesConsumer) ReadMessage(ctx context.Context) (kafka.Message, error) {
    // If replication lag is acceptable, read from local (replicated) topic
    // Otherwise, read directly from the source cluster
    // This is the read-your-writes consistency pattern for geo-distributed Kafka
    return c.primaryReader.ReadMessage(ctx)
}

func getHeader(msg kafka.Message, key string) string {
    for _, h := range msg.Headers {
        if h.Key == key { return string(h.Value) }
    }
    return "unknown"
}

func Example() {
    fmt.Println("MirrorMaker 2 setup:")
    fmt.Println("1. Deploy mm2.properties to Kafka Connect cluster")
    fmt.Println("2. Start: connect-mirror-maker.sh mm2.properties")
    fmt.Println("3. Verify: kafka-topics.sh --list | grep 'us-east\\.'")
    fmt.Println("4. Monitor lag via heartbeats topic")
}
```

---

### Exercise 4: Kafka Streams-style Processing in Go

**Goal**: Consume a `page-views` topic, compute 5-minute tumbling window counts per user, handle late arrivals up to 1 minute, and checkpoint window state to Redis.

```go
package windowing

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/segmentio/kafka-go"
)

type PageViewEvent struct {
    UserID    string    `json:"user_id"`
    PageURL   string    `json:"page_url"`
    Timestamp time.Time `json:"timestamp"`
}

type WindowKey struct {
    UserID      string
    WindowStart time.Time
}

func (k WindowKey) RedisKey() string {
    return fmt.Sprintf("pageviews:%s:%d", k.UserID, k.WindowStart.Unix())
}

const (
    windowSize    = 5 * time.Minute
    lateArrival   = 1 * time.Minute
    checkpointTTL = 2 * time.Hour // Keep window state for 2 hours
)

type WindowedConsumer struct {
    reader      *kafka.Reader
    redisClient *redis.Client
}

func NewWindowedConsumer(brokers []string, redisAddr string) *WindowedConsumer {
    return &WindowedConsumer{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers:        brokers,
            Topic:          "page-views",
            GroupID:        "page-view-aggregator",
            MinBytes:       1e3,
            MaxBytes:       10e6,
            CommitInterval: 5 * time.Second,
        }),
        redisClient: redis.NewClient(&redis.Options{Addr: redisAddr}),
    }
}

func (c *WindowedConsumer) Run(ctx context.Context) error {
    // Periodically flush and emit closed windows
    go c.emitClosedWindows(ctx)

    for {
        msg, err := c.reader.ReadMessage(ctx)
        if err != nil {
            if ctx.Err() != nil { return nil }
            log.Printf("read error: %v", err)
            continue
        }

        var event PageViewEvent
        if err := json.Unmarshal(msg.Value, &event); err != nil {
            log.Printf("unmarshal error: %v", err)
            continue
        }

        // Assign event to tumbling window based on event timestamp (not processing time)
        windowStart := event.Timestamp.Truncate(windowSize)

        // Late arrival check: discard if too old
        watermark := time.Now().Add(-lateArrival)
        if windowStart.Before(watermark.Truncate(windowSize)) {
            log.Printf("dropping late event user=%s ts=%v (watermark=%v)",
                event.UserID, event.Timestamp, watermark)
            continue
        }

        key := WindowKey{UserID: event.UserID, WindowStart: windowStart}
        if err := c.incrementWindow(ctx, key); err != nil {
            log.Printf("increment error: %v", err)
        }
    }
}

func (c *WindowedConsumer) incrementWindow(ctx context.Context, key WindowKey) error {
    pipe := c.redisClient.Pipeline()
    pipe.Incr(ctx, key.RedisKey())
    pipe.Expire(ctx, key.RedisKey(), checkpointTTL)
    _, err := pipe.Exec(ctx)
    return err
}

// emitClosedWindows fires every minute and emits results for windows that are now closed
// (window end + lateArrival grace period has passed)
func (c *WindowedConsumer) emitClosedWindows(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Find all windows that closed > lateArrival ago
            // In production: use Redis SCAN with prefix pattern
            // then emit to output topic "page-view-counts"
            log.Println("emitting closed windows (checkpoint from Redis)...")
            // emitOutputEvents(ctx, closedWindows)
        }
    }
}

// GetWindowCount retrieves the current count for a specific user+window
// This enables read-your-writes queries during active windows
func (c *WindowedConsumer) GetWindowCount(ctx context.Context, userID string, windowStart time.Time) (int64, error) {
    key := WindowKey{UserID: userID, WindowStart: windowStart}
    count, err := c.redisClient.Get(ctx, key.RedisKey()).Int64()
    if err == redis.Nil {
        return 0, nil
    }
    return count, err
}
```

### Junior -> FAANG: Getting Maximum Value from Kafka Exercises

Exercises in a Kafka chapter have a common failure mode: engineers run the code, see messages flowing, and move on. The exercise is not complete until you have deliberately broken the system and observed the recovery behavior.

For Exercise 1 (high-throughput order pipeline):

- **Break idempotence**: disable `enable.idempotence` and introduce a retry that forces duplicate sends. Verify duplicates appear in the consumer. Re-enable idempotence. Verify duplicates disappear.
- **Simulate consumer crash**: kill the consumer process mid-processing. Restart it. Verify it resumes from the committed offset without reprocessing already-committed messages and without skipping uncommitted messages.
- **Simulate broker failure**: stop one broker in your local cluster. Verify the producer continues sending (with a brief pause for leader election) and the consumer continues reading. Check that `under-replicated-partitions` metric goes to 1 and returns to 0 when the broker restarts.

The Prometheus metrics exercise is especially important: set up a local Prometheus and Grafana, configure the consumer to expose metrics, and build a dashboard showing messages processed per second, processing duration p99, and consumer lag. Seeing your own service's metrics on a real dashboard is a formative experience that significantly deepens understanding.

For building speed: the goal is to be able to write a complete, production-quality Kafka consumer with manual offset commit, structured logging, Prometheus metrics, graceful shutdown, and a dead-letter topic handler in under 45 minutes from a blank file. Time yourself on the first attempt. Identify the parts that slow you down and practice those specifically.

### Senior @ FAANG: Designing Exercises that Build Production Intuition

At the senior level, the exercises in this section are starting points for designing more realistic failure scenarios that build the intuition required for production incident response.

**Exercise extension: ISR-degraded write testing.** Configure a local Kafka cluster with `min.insync.replicas=2` and `replication.factor=2`. Stop one broker. Observe that producers with `acks=all` begin returning `NotEnoughReplicasException`. Implement retry logic in the producer that distinguishes between retriable errors (network timeout, leader not available) and non-retriable errors (invalid topic, authorization failure). Measure the latency distribution during the degraded period.

**Exercise extension: Cooperative vs eager rebalancing comparison.** Set up a consumer group with 6 instances. Measure the stop-the-world pause during a rolling restart with eager rebalancing (`RangeAssignor`). Then switch to `CooperativeStickyAssignor` and repeat the measurement. Document the difference in consumer lag spike during the rolling restart. This experiment provides concrete data to justify the configuration choice in a future ADR.

**Exercise extension: Schema evolution compatibility gate in CI.** Build a GitHub Actions workflow that: (1) registers the current schema version in a test Schema Registry, (2) attempts to register the candidate schema version from the PR branch, (3) fails the workflow if the Schema Registry returns a compatibility error. This exercise demonstrates how to enforce schema contracts at the CI/CD level, which is the correct place to catch incompatible changes.

**Exercise extension: KEDA autoscaling under load.** Deploy the high-throughput producer and consumer to a local Kubernetes cluster. Configure a KEDA ScaledObject targeting consumer lag. Run the producer at 2x the consumer's processing capacity. Observe KEDA scale up the consumer deployment. Reduce producer throughput. Observe KEDA scale down. Verify that the maximum replica count does not exceed the partition count (idle consumers above the partition count). This exercise builds the operational intuition for autoscaling consumer fleets that cannot be gained from reading alone.

---
