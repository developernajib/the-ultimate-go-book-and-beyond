## 55.6 Metrics Ingestion Service

The ingestion service buffers incoming metric points in memory and flushes them to storage in batches, reducing the number of database round-trips by orders of magnitude compared to single-row inserts. A configurable batch size triggers immediate flushes when the buffer fills, while a timer-based flusher ensures partial batches don't sit in memory indefinitely. When the flush channel is full (meaning the write workers can't keep up) the processor drops the batch and increments a Prometheus counter labeled `backpressure`, giving operators a clear signal that ingestion capacity needs scaling.

```go
// backend/internal/ingestion/processor.go
package ingestion

import (
    "context"
    "log/slog"
    "sync"
    "time"

    "dashboard/internal/observability"
)

// MetricPoint represents a single data point
type MetricPoint struct {
    Name      string            `json:"name"`
    Value     float64           `json:"value"`
    Timestamp time.Time         `json:"timestamp"`
    Tags      map[string]string `json:"tags"`
}

// Batch represents a collection of metric points
type Batch struct {
    Points    []MetricPoint
    Received  time.Time
}

// Processor handles metric ingestion with batching
type Processor struct {
    batchSize     int
    flushInterval time.Duration
    buffer        []MetricPoint
    mu            sync.Mutex
    flushChan     chan Batch
    writer        BatchWriter
    metrics       *observability.DashboardMetrics
    logger        *slog.Logger
}

// BatchWriter interface for writing batches to storage
type BatchWriter interface {
    WriteBatch(ctx context.Context, batch Batch) error
}

func NewProcessor(
    batchSize int,
    flushInterval time.Duration,
    writer BatchWriter,
    metrics *observability.DashboardMetrics,
    logger *slog.Logger,
) *Processor {
    p := &Processor{
        batchSize:     batchSize,
        flushInterval: flushInterval,
        buffer:        make([]MetricPoint, 0, batchSize),
        flushChan:     make(chan Batch, 100),
        writer:        writer,
        metrics:       metrics,
        logger:        logger,
    }
    return p
}

// Start begins the processor's background workers
func (p *Processor) Start(ctx context.Context, workers int) {
    // Start flush workers
    for i := 0; i < workers; i++ {
        go p.flushWorker(ctx, i)
    }

    // Start timer-based flusher
    go p.timerFlusher(ctx)
}

// Ingest adds a metric point to the buffer
func (p *Processor) Ingest(point MetricPoint) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    p.buffer = append(p.buffer, point)
    p.metrics.MetricsIngested.Inc()

    // Flush if buffer is full
    if len(p.buffer) >= p.batchSize {
        p.flushLocked()
    }

    return nil
}

// IngestBatch adds multiple points at once
func (p *Processor) IngestBatch(points []MetricPoint) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    p.buffer = append(p.buffer, points...)
    p.metrics.IngestionBatchSize.Observe(float64(len(points)))

    // Flush if buffer exceeds threshold
    for len(p.buffer) >= p.batchSize {
        p.flushLocked()
    }

    return nil
}

func (p *Processor) flushLocked() {
    if len(p.buffer) == 0 {
        return
    }

    batch := Batch{
        Points:   make([]MetricPoint, len(p.buffer)),
        Received: time.Now(),
    }
    copy(batch.Points, p.buffer)

    // Try to send batch, with backpressure
    select {
    case p.flushChan <- batch:
        p.buffer = p.buffer[:0] // Reset buffer
    default:
        // Channel full - apply backpressure
        p.metrics.MetricsDropped.WithLabelValues("backpressure").Add(float64(len(p.buffer)))
        p.logger.Warn("flush channel full, dropping batch",
            "batch_size", len(p.buffer),
        )
        p.buffer = p.buffer[:0]
    }
}

func (p *Processor) timerFlusher(ctx context.Context) {
    ticker := time.NewTicker(p.flushInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            // Final flush on shutdown
            p.mu.Lock()
            p.flushLocked()
            p.mu.Unlock()
            return
        case <-ticker.C:
            p.mu.Lock()
            p.flushLocked()
            p.mu.Unlock()
        }
    }
}

func (p *Processor) flushWorker(ctx context.Context, id int) {
    for {
        select {
        case <-ctx.Done():
            return
        case batch := <-p.flushChan:
            start := time.Now()
            if err := p.writer.WriteBatch(ctx, batch); err != nil {
                p.logger.Error("failed to write batch",
                    "worker", id,
                    "error", err,
                    "batch_size", len(batch.Points),
                )
                p.metrics.MetricsDropped.WithLabelValues("write_error").Add(float64(len(batch.Points)))
            } else {
                p.metrics.IngestionLatency.Observe(time.Since(start).Seconds())
            }
        }
    }
}
```

---

### Junior -> FAANG: Understanding Backpressure as a Design Choice, Not an Error

Most junior engineers treat backpressure as a failure condition to be eliminated. It is not. It is a deliberate flow control mechanism. When the `flushChan` is full and the processor drops a batch, it is making the correct choice: drop data now and stay healthy, rather than buffer indefinitely and OOM later.

The key interview concept is the distinction between the three responses to an overloaded system: drop, buffer, or propagate the pressure upstream. The processor here drops. A message queue like Kafka propagates pressure upstream (producers slow down when the consumer lag grows). An unbounded in-memory queue buffers (and eventually OOMs). Each is correct in different contexts. For a metrics ingestion service, dropping a few data points during a spike is acceptable because metrics are statistical. For a payment processing service, dropping a transaction is not acceptable and you must propagate pressure upstream to the API caller.

First-job habit: any time you write a `make(chan T, N)`, ask yourself: what happens when this channel is full? If the answer is "I don't know," you have a latent production bug. The `default` branch in the flush select is the explicit answer here. Find the equivalent answer in every channel you write.

Worked example for interview prep: if `batchSize` is 1000, `flushInterval` is 100ms, and the ingest rate is 5000 points/second, you will see approximately 5 flush events per second. If each flush worker takes 50ms to write, a single worker processes 20 flushes per second, which is more than enough headroom. If the write time spikes to 300ms due to a slow database, a single worker can process only 3.3 flushes per second, creating backlog. Two workers handle 6.6, which is above the 5 needed. This is how you size workers: write rate divided by write latency, with a safety margin.

### Senior @ FAANG: Ingestion Service Reliability at Platform Scale

The processor here is a correct in-process batching implementation. At FAANG ingestion volumes (millions of data points per second), several additional concerns arise that a staff engineer must address.

**Durability vs throughput tradeoff:** The current implementation drops batches that cannot be flushed. This is appropriate for monitoring metrics where a few dropped points do not affect alert correctness. But if the ingestion service is handling billing events or user action logs, the drop policy is wrong. A durable ingestion pipeline uses a persistent queue (Kafka, Pulsar, or SQS) so that the processor can acknowledge individual batches only after they are written to storage. Go implementations of this pattern use a Kafka consumer group that commits offsets only after successful writes, with a dead-letter queue for batches that fail after N retries.

**Shutdown correctness under orchestration:** The `timerFlusher` performs a final flush on `ctx.Done()`. But Kubernetes sends `SIGTERM` and then waits `terminationGracePeriodSeconds` before sending `SIGKILL`. If the final flush takes longer than that period (e.g., a large in-flight batch writing to a slow database), the process is killed with data in the buffer. The correct pattern is to extend the grace period in the pod spec to be longer than the maximum expected flush time, and to instrument flush duration so that if a flush exceeds a threshold, an alert fires before the next deployment.

**Idempotency for write retries:** The `flushWorker` retries writes by dropping them (recording an error metric) rather than retrying. A more resilient design retries with exponential backoff for transient errors (network timeout, temporary database unavailability) while dropping for permanent errors (schema mismatch, malformed data). Retries require that the `WriteBatch` operation be idempotent, meaning writing the same batch twice produces the same result. For time-series data with unique (name, timestamp, tags) combinations, a database `ON CONFLICT DO NOTHING` or `INSERT OR IGNORE` handles idempotency at the storage layer.

**Cardinality at the ingestion boundary:** The `MetricPoint` struct accepts arbitrary `Tags map[string]string`. Without enforcement at the ingestion boundary, a client that sends user IDs as tag values will create a new time series per user, exploding cardinality. The processor should apply a `CardinalityLimiter` (as shown in the Datadog case study) before flushing to storage, not after. Enforcing cardinality at the boundary is cheaper than cleaning up the storage layer after the fact, and it gives the client an immediate signal (the tag value was replaced with `__other__`) rather than a silent data quality problem discovered weeks later.
