## 52F.9 Kafka at Scale

### Handling 1M+ Messages Per Second

Achieving millions of messages per second requires careful tuning across every layer of the Kafka stack:

```
┌───────────────────────────────────────────────────────────────┐
│           High-Throughput Architecture                        │
│                                                               │
│  Producers (20 instances)                                     │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                      │
│  │ P1  │ │ P2  │ │ P3  │ │ ... │ │ P20 │                      │
│  │batch│ │batch│ │batch│ │     │ │batch│                      │
│  │lz4  │ │lz4  │ │lz4  │ │     │ │lz4  │                      │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘                      │
│     │       │       │       │       │                         │
│     └───────┴───────┴───┬───┴───────┘                         │
│                         ▼                                     │
│  Kafka Cluster (12 brokers, 3 racks)                          │
│  ┌────────────────────────────────────────┐                   │
│  │  Topic: events (120 partitions, RF=3)  │                   │
│  │                                        │                   │
│  │  Rack A: B1  B2  B3  B4                │                   │
│  │  Rack B: B5  B6  B7  B8                │                   │
│  │  Rack C: B9  B10 B11 B12               │                   │
│  └────────────────────────────────────────┘                   │
│                         │                                     │
│     ┌───────┬───────┬───┴───┬───────┐                         │
│     ▼       ▼       ▼       ▼       ▼                         │
│  Consumers (40 instances across 4 groups)                     │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                      │
│  │ C1  │ │ C2  │ │ C3  │ │ ... │ │ C40 │                      │
│  │ 3p  │ │ 3p  │ │ 3p  │ │     │ │ 3p  │                      │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘                      │
└───────────────────────────────────────────────────────────────┘
```

**Partition count guidelines for high throughput:**

| Target Throughput | Partitions | Brokers | Replication Factor | Notes |
|-------------------|------------|---------|-------------------|-------|
| 100K msgs/s | 12-24 | 3 | 3 | Small cluster |
| 500K msgs/s | 48-60 | 6 | 3 | Medium cluster |
| 1M msgs/s | 90-120 | 9-12 | 3 | Large cluster |
| 5M msgs/s | 300-500 | 20-30 | 3 | Very large cluster |
| 10M+ msgs/s | 500-1000 | 30+ | 3 | Mega cluster, consider multi-cluster |

**Producer batching for throughput:**

```
Without batching (linger.ms=0):
  Request 1: [msg1]  →  Kafka
  Request 2: [msg2]  →  Kafka
  Request 3: [msg3]  →  Kafka
  Network overhead: 3 round trips

With batching (linger.ms=20, batch.size=512KB):
  Request 1: [msg1, msg2, msg3, ... msg500]  →  Kafka
  Network overhead: 1 round trip
  Throughput improvement: 10-50x
```

### Multi-Datacenter Replication with MirrorMaker 2

MirrorMaker 2 (MM2) is built on Kafka Connect and provides continuous replication between Kafka clusters:

```
┌────────────────────────────┐         ┌────────────────────────────┐
│    US-East Cluster         │          │    EU-West Cluster        │
│                            │         │                            │
│  topics:                   │  MM2    │  topics:                   │
│    orders                  │ ──────► │    us-east.orders          │
│    payments                │         │    us-east.payments        │
│    users                   │         │    us-east.users           │
│                            │         │                            │
│  topics:                   │  MM2    │  topics:                   │
│    eu-west.inventory       │ ◄────── │    inventory               │
│    eu-west.shipments       │         │    shipments               │
│                            │         │                            │
└────────────────────────────┘         └────────────────────────────┘
         │                                        │
         │         ┌──────────────────┐           │
         └────────►│  Asia Cluster    │◄──────────┘
           MM2     │                  │    MM2
                   │  us-east.orders  │
                   │eu-west.inventory │
                   │  local-events    │
                   └──────────────────┘

Key features of MirrorMaker 2:
  • Automatic topic renaming with source prefix
  • Consumer offset translation between clusters
  • ACL and config replication
  • Cycle detection (prevents replication loops)
  • Exactly-once delivery semantics
```

**MirrorMaker 2 configuration:**

```properties
# mm2.properties
clusters = us-east, eu-west

us-east.bootstrap.servers = kafka-us-east-1:9092,kafka-us-east-2:9092
eu-west.bootstrap.servers = kafka-eu-west-1:9092,kafka-eu-west-2:9092

# Replicate from US-East to EU-West
us-east->eu-west.enabled = true
us-east->eu-west.topics = orders, payments, users
us-east->eu-west.groups = .*

# Replicate from EU-West to US-East
eu-west->us-east.enabled = true
eu-west->us-east.topics = inventory, shipments
eu-west->us-east.groups = .*

# Replication settings
replication.factor = 3
sync.topic.configs.enabled = true
sync.topic.acls.enabled = true
emit.heartbeats.enabled = true
emit.checkpoints.enabled = true
emit.checkpoints.interval.seconds = 10
refresh.topics.interval.seconds = 30
refresh.groups.interval.seconds = 30

# Performance tuning
tasks.max = 10
producer.batch.size = 524288
producer.linger.ms = 10
producer.compression.type = lz4
consumer.fetch.min.bytes = 65536
```

### Tiered Storage

Tiered storage separates recent (hot) data on local broker disks from older (warm/cold) data on remote storage like S3 or HDFS:

```
┌───────────────────────────────────────────────────────────┐
│                  Tiered Storage Architecture              │
│                                                           │
│  ┌─────────────────────────────────────────────────┐      │
│  │  HOT Tier (Local NVMe SSD)                      │      │
│  │  Last 2 hours of data                           │      │
│  │  ┌──────┬──────┬──────┬──────┬──────┐           │      │
│  │  │Seg 20│Seg 21│Seg 22│Seg 23│Active│           │      │
│  │  └──────┴──────┴──────┴──────┴──────┘           │      │
│  │  Fast reads, low latency (<5ms)                 │      │
│  └─────────────────────────────────────────────────┘      │
│                         │                                 │
│                    Upload to                              │
│                    remote store                           │
│                         ▼                                 │
│  ┌─────────────────────────────────────────────────┐      │
│  │  WARM Tier (Amazon S3 / GCS / Azure Blob)       │      │
│  │  2 hours to 30 days                             │      │
│  │  ┌──────┬──────┬──────┬──────┬──────┬──────┐    │      │
│  │  │Seg 1 │Seg 2 │ ...  │Seg 18│Seg 19│Seg 20│    │      │
│  │  └──────┴──────┴──────┴──────┴──────┴──────┘    │      │
│  │  Moderate latency (50-200ms), very low cost     │      │
│  └─────────────────────────────────────────────────┘      │
│                         │                                 │
│                    Archive                                │
│                         ▼                                 │
│  ┌─────────────────────────────────────────────────┐      │
│  │  COLD Tier (S3 Glacier / Archive)               │      │
│  │  30+ days, compliance/audit requirements        │      │
│  │  Very high latency, lowest cost                 │      │
│  └─────────────────────────────────────────────────┘      │
│                                                           │
│  Benefits:                                                │
│  • 10x-50x cost reduction for long-retention topics       │
│  • Brokers need much less local disk                      │
│  • Infinite retention becomes practical                   │
│  • Broker recovery is faster (less data to replicate)     │
└───────────────────────────────────────────────────────────┘
```

### Topic Design Patterns for High Throughput

Partition count and key selection are the primary knobs for scaling Kafka throughput: too few partitions bottleneck parallelism, while poor key distribution creates hot partitions that saturate individual brokers. The following patterns guide topic design for workloads that must sustain millions of messages per second.

```
Pattern 1: Single Topic with Key-Based Partitioning
  Topic: events (120 partitions)
  Key: user_id → consistent hashing → partition
  Best for: ordered processing per user, moderate cardinality

Pattern 2: Topic-per-Entity-Type
  Topics: user-events (30p), order-events (60p), payment-events (30p)
  Best for: different retention, different consumer groups, schema isolation

Pattern 3: Topic-per-Region with Aggregation
  Topics: events-us-east, events-eu-west, events-asia
  Aggregation topic: events-global (via MirrorMaker or stream processor)
  Best for: geo-distributed systems, regional compliance

Pattern 4: Hot/Cold Topic Split
  Topic: events-recent (high partition count, short retention)
  Topic: events-archive (lower partition count, long retention, compacted)
  Stream processor copies from recent → archive
  Best for: different access patterns, cost optimization

Pattern 5: Priority Queues via Multiple Topics
  Topics: orders-high (30p), orders-medium (30p), orders-low (15p)
  Consumers: more instances on high-priority topic
  Best for: SLA-differentiated processing
```

### Go Code: High-Throughput Producer with Benchmarks

Maximizing Kafka producer throughput in Go requires tuning batch size, linger time, compression codec, and the number of concurrent writer goroutines in concert. The following benchmark harness measures messages-per-second and bytes-per-second under varying configurations so you can identify the optimal settings for your hardware and message size distribution.

```go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// Event represents a high-throughput event message.
type Event struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Type      string `json:"type"`
	Payload   string `json:"payload"`
	Timestamp int64  `json:"timestamp"`
}

// ProducerMetrics tracks production statistics.
type ProducerMetrics struct {
	MessagesSent   atomic.Int64
	BytesSent      atomic.Int64
	Errors         atomic.Int64
	BatchesSent    atomic.Int64
	AvgLatencyNs   atomic.Int64
	latencySum     atomic.Int64
	latencyCount   atomic.Int64
}

// Report returns a formatted metrics report.
func (m *ProducerMetrics) Report(elapsed time.Duration) string {
	sent := m.MessagesSent.Load()
	bytes := m.BytesSent.Load()
	errors := m.Errors.Load()
	batches := m.BatchesSent.Load()
	secs := elapsed.Seconds()

	var avgLatency time.Duration
	count := m.latencyCount.Load()
	if count > 0 {
		avgLatency = time.Duration(m.latencySum.Load() / count)
	}

	return fmt.Sprintf(
		"Messages: %d (%.0f/s) | Bytes: %.2f MB (%.2f MB/s) | Errors: %d | Batches: %d | Avg Latency: %v",
		sent,
		float64(sent)/secs,
		float64(bytes)/(1024*1024),
		float64(bytes)/(1024*1024)/secs,
		errors,
		batches,
		avgLatency,
	)
}

func (m *ProducerMetrics) recordLatency(d time.Duration) {
	m.latencySum.Add(int64(d))
	m.latencyCount.Add(1)
}

// HighThroughputProducer is optimized for maximum message throughput.
type HighThroughputProducer struct {
	producer sarama.AsyncProducer
	metrics  *ProducerMetrics
	logger   *slog.Logger
	topic    string
	wg       sync.WaitGroup
}

// HighThroughputProducerConfig holds configuration for the producer.
type HighThroughputProducerConfig struct {
	Brokers []string
	Topic   string
	Logger  *slog.Logger
}

// NewHighThroughputProducer creates a producer optimized for throughput.
func NewHighThroughputProducer(cfg HighThroughputProducerConfig) (*HighThroughputProducer, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0

	// Throughput-optimized settings.
	config.Producer.Return.Successes = true
	config.Producer.Return.Errors = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Compression = sarama.CompressionLZ4
	config.Producer.Flush.Frequency = 20 * time.Millisecond
	config.Producer.Flush.Bytes = 512 * 1024           // 512 KB
	config.Producer.Flush.Messages = 1000
	config.Producer.Flush.MaxMessages = 5000
	config.Producer.MaxMessageBytes = 1048576           // 1 MB
	config.Producer.Retry.Max = 5
	config.Producer.Retry.Backoff = 100 * time.Millisecond

	// Channel buffer sizes for async producer.
	config.ChannelBufferSize = 10000

	// Network settings.
	config.Net.MaxOpenRequests = 5
	config.Net.DialTimeout = 10 * time.Second
	config.Net.ReadTimeout = 30 * time.Second
	config.Net.WriteTimeout = 30 * time.Second

	// Metadata refresh.
	config.Metadata.RefreshFrequency = 5 * time.Minute

	producer, err := sarama.NewAsyncProducer(cfg.Brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating async producer: %w", err)
	}

	p := &HighThroughputProducer{
		producer: producer,
		metrics:  &ProducerMetrics{},
		logger:   cfg.Logger,
		topic:    cfg.Topic,
	}

	// Start success and error handlers.
	p.wg.Add(2)
	go p.handleSuccesses()
	go p.handleErrors()

	return p, nil
}

func (p *HighThroughputProducer) handleSuccesses() {
	defer p.wg.Done()
	for range p.producer.Successes() {
		p.metrics.MessagesSent.Add(1)
		p.metrics.BatchesSent.Add(1)
	}
}

func (p *HighThroughputProducer) handleErrors() {
	defer p.wg.Done()
	for err := range p.producer.Errors() {
		p.metrics.Errors.Add(1)
		p.logger.Error("producer error",
			"error", err.Err,
			"topic", err.Msg.Topic,
		)
	}
}

// Send enqueues a message for async production.
func (p *HighThroughputProducer) Send(key string, event Event) {
	value, err := json.Marshal(event)
	if err != nil {
		p.metrics.Errors.Add(1)
		p.logger.Error("failed to marshal event", "error", err)
		return
	}

	msg := &sarama.ProducerMessage{
		Topic:     p.topic,
		Key:       sarama.StringEncoder(key),
		Value:     sarama.ByteEncoder(value),
		Timestamp: time.Now(),
	}

	p.producer.Input() <- msg
	p.metrics.BytesSent.Add(int64(len(value)))
}

// Close shuts down the producer and waits for pending messages.
func (p *HighThroughputProducer) Close() error {
	p.producer.AsyncClose()
	p.wg.Wait()
	return nil
}

// Metrics returns the current producer metrics.
func (p *HighThroughputProducer) Metrics() *ProducerMetrics {
	return p.metrics
}

// generateRandomID creates a random hex ID.
func generateRandomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// BenchmarkResult holds results from a throughput benchmark.
type BenchmarkResult struct {
	Duration       time.Duration `json:"duration"`
	MessageCount   int64         `json:"message_count"`
	ByteCount      int64         `json:"byte_count"`
	MessagesPerSec float64       `json:"messages_per_sec"`
	MBPerSec       float64       `json:"mb_per_sec"`
	ErrorCount     int64         `json:"error_count"`
	Goroutines     int           `json:"goroutines_used"`
}

// RunBenchmark executes a throughput benchmark with the given parameters.
func RunBenchmark(
	ctx context.Context,
	producer *HighThroughputProducer,
	numGoroutines int,
	duration time.Duration,
	logger *slog.Logger,
) BenchmarkResult {
	logger.Info("starting benchmark",
		"goroutines", numGoroutines,
		"duration", duration,
	)

	start := time.Now()
	deadline := start.Add(duration)

	var wg sync.WaitGroup
	eventTypes := []string{"click", "view", "purchase", "signup", "search"}

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()

			userPrefix := fmt.Sprintf("user-%d", workerID)

			for time.Now().Before(deadline) {
				if ctx.Err() != nil {
					return
				}

				event := Event{
					ID:        generateRandomID(),
					UserID:    fmt.Sprintf("%s-%d", userPrefix, time.Now().UnixNano()%10000),
					Type:      eventTypes[time.Now().UnixNano()%int64(len(eventTypes))],
					Payload:   `{"page":"/products","action":"view","session":"abc123"}`,
					Timestamp: time.Now().UnixMilli(),
				}

				producer.Send(event.UserID, event)
			}
		}(i)
	}

	wg.Wait()

	// Allow time for async delivery to complete.
	time.Sleep(2 * time.Second)

	elapsed := time.Since(start)
	metrics := producer.Metrics()
	sent := metrics.MessagesSent.Load()
	bytes := metrics.BytesSent.Load()

	result := BenchmarkResult{
		Duration:       elapsed,
		MessageCount:   sent,
		ByteCount:      bytes,
		MessagesPerSec: float64(sent) / elapsed.Seconds(),
		MBPerSec:       float64(bytes) / (1024 * 1024) / elapsed.Seconds(),
		ErrorCount:     metrics.Errors.Load(),
		Goroutines:     numGoroutines,
	}

	logger.Info("benchmark complete",
		"messages_sent", result.MessageCount,
		"messages_per_sec", fmt.Sprintf("%.0f", result.MessagesPerSec),
		"mb_per_sec", fmt.Sprintf("%.2f", result.MBPerSec),
		"errors", result.ErrorCount,
		"duration", result.Duration,
	)

	return result
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	runtime.GOMAXPROCS(runtime.NumCPU())

	producer, err := NewHighThroughputProducer(HighThroughputProducerConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "high-throughput-events",
		Logger:  logger,
	})
	if err != nil {
		logger.Error("failed to create producer", "error", err)
		os.Exit(1)
	}
	defer producer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	// Run benchmarks with different goroutine counts.
	benchmarks := []struct {
		goroutines int
		duration   time.Duration
	}{
		{goroutines: 1, duration: 10 * time.Second},
		{goroutines: 4, duration: 10 * time.Second},
		{goroutines: 8, duration: 10 * time.Second},
		{goroutines: 16, duration: 10 * time.Second},
	}

	var results []BenchmarkResult
	for _, b := range benchmarks {
		if ctx.Err() != nil {
			break
		}

		// Create a fresh producer for each benchmark.
		p, err := NewHighThroughputProducer(HighThroughputProducerConfig{
			Brokers: []string{"localhost:9092"},
			Topic:   "high-throughput-events",
			Logger:  logger,
		})
		if err != nil {
			logger.Error("failed to create producer for benchmark", "error", err)
			continue
		}

		result := RunBenchmark(ctx, p, b.goroutines, b.duration, logger)
		results = append(results, result)
		p.Close()

		// Brief pause between benchmarks.
		time.Sleep(3 * time.Second)
	}

	// Print summary.
	logger.Info("=== Benchmark Summary ===")
	for _, r := range results {
		logger.Info("result",
			"goroutines", r.Goroutines,
			"msgs_per_sec", fmt.Sprintf("%.0f", r.MessagesPerSec),
			"mb_per_sec", fmt.Sprintf("%.2f", r.MBPerSec),
			"total_messages", r.MessageCount,
			"errors", r.ErrorCount,
		)
	}
}
```

> **Scaling Wisdom**: Reaching millions of messages per second requires systematic optimization across the entire pipeline, not a single configuration change. Partition counts are determined by target throughput divided by per-partition throughput (typically 10-30 MB/s). Producers batch aggressively with LZ4 compression. Consumers run with `max.poll.records=1000` and process batches concurrently. Every topic needs a clearly defined SLA for throughput, latency, and durability that drives its configuration.

### Junior -> FAANG: Approaching Throughput Problems Systematically

When a system design interviewer asks "how would you handle 1 million messages per second in Kafka," the wrong answer is "add more partitions." The right answer walks through each layer of the stack and explains the lever at each layer:

**Producer layer:** Increase `linger.ms` (5-20ms) to allow batches to fill, increase `batch.size` (512KB to 1MB), use LZ4 compression, and consider multiple concurrent producer goroutines sending to different partition ranges.

**Broker layer:** Ensure enough partitions to distribute load (rule: target throughput divided by per-partition capacity, typically 10-30 MB/s per partition), ensure brokers are sized for the I/O (NVMe SSDs, 10 Gbps NICs), and distribute partitions across racks for fault tolerance.

**Consumer layer:** Use async processing (fan-out to worker goroutines after fetch), increase `max.poll.records` to batch-process messages, commit offsets in batches rather than per-message, and scale consumer instances to match partition count.

The `HighThroughputProducer` benchmark in this section is a starting point for measuring your actual throughput, not a production-ready producer by itself. Run the benchmark against your actual broker hardware before committing to partition counts in your topic design.

The async producer pattern (producer sends to `producer.Input()` channel without blocking, success and error handlers run in separate goroutines) is the correct approach for throughput-critical producers. The tradeoff: you lose per-message error handling in the send path, so errors must be tracked through the delivery report channel.

### Senior @ FAANG: Multi-Datacenter Kafka Architecture at the Staff Level

At the staff level, "Kafka at scale" means multi-datacenter topology, not just a large single cluster. The decisions in this section affect reliability during regional outages, compliance with data residency requirements, and cost of cross-region data transfer.

**Active-active vs active-passive topology tradeoffs.** MirrorMaker 2 supports both active-active (both clusters accept writes, each replicates to the other) and active-passive (one cluster accepts writes, the other is a read-only standby). Active-active enables regional producers to write to their nearest cluster without cross-region latency. The cost is that a consumer group in one region sees messages from both regions interleaved and offset management becomes complex (offset translation via the `__checkpoint` topic). Active-passive is simpler operationally: no offset translation, no interleaving. The cost is that all writes must go to the primary region, adding 50-150ms round-trip latency for producers in remote regions.

**Offset translation as a correctness requirement for failover.** During an active-passive failover, consumer groups in the standby region must resume from the equivalent position in the standby cluster. MirrorMaker 2's checkpoint consumer (`__checkpoint.internal` topic) stores translated offsets that map primary cluster offsets to equivalent standby cluster offsets. The kafka-consumer-groups tool with `--bootstrap-server standbycluster:9092` can be used to reset consumer group offsets to the translated checkpoint after failover. Automate this step in your failover runbook. Manual offset reset under pressure during an incident is where mistakes happen.

**Tiered storage cost modeling for the platform budget.** The tiered storage architecture in this section shows three tiers: hot (local NVMe), warm (S3), cold (S3 Glacier). For the platform team, tiered storage is a cost governance decision: which topics get tiered storage, what is the hot tier retention (determines local disk sizing), and what is the S3 retrieval SLA (determines whether cold tier access is acceptable for operational use cases or only for compliance/audit). Document per-topic tiered storage configuration as part of the topic provisioning form. Topics with latency-sensitive consumers should keep more data in the hot tier. Topics with long retention for compliance should push to cold tier after 30 days.

**MirrorMaker 2 throughput sizing.** MM2 is a Kafka Connect cluster. Size it for the peak replication throughput plus 50% headroom. A common mistake is sizing MM2 based on average throughput, which leaves no capacity for catch-up replication after a MM2 restart or a brief lag spike. Monitor MM2 consumer lag (the lag of MM2's internal consumer against the source cluster) as a replication health signal. If MM2 lag grows, replication is falling behind and the standby cluster is diverging from the primary.

---
