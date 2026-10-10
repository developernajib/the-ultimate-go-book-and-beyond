## Part 9: Monitoring and Metrics

You cannot operate a data pipeline reliably without knowing what is happening inside it. This part builds a metrics system with three fundamental metric types: counters (cumulative totals like "elements processed"), gauges (current values like "buffer size"), and histograms (distributions like "processing latency"). A console reporter periodically prints these metrics, and the checkpoint coordinator ensures pipeline progress is saved for fault tolerance.

### Metrics System

The `MetricsCollector` is a thread-safe registry of all pipeline metrics. You request a counter, gauge, or histogram by name, and the collector either returns an existing one or creates a new one. All metric types use atomic operations for lock-free concurrent updates from multiple goroutines. The `Histogram` tracks value distributions using configurable buckets and can compute percentiles (P50, P95, P99) and means. The `ConsoleReporter` periodically calls `Report()` on the collector to print a human-readable summary of all metrics.

```go
// pkg/pipeline/metrics.go
package pipeline

import (
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

// MetricsCollector gathers pipeline metrics
type MetricsCollector struct {
    mu         sync.RWMutex
    counters   map[string]*Counter
    gauges     map[string]*Gauge
    histograms map[string]*Histogram
}

func NewMetricsCollector() *MetricsCollector {
    return &MetricsCollector{
        counters:   make(map[string]*Counter),
        gauges:     make(map[string]*Gauge),
        histograms: make(map[string]*Histogram),
    }
}

// Counter tracks cumulative values
type Counter struct {
    value int64
}

func (c *Counter) Inc() {
    atomic.AddInt64(&c.value, 1)
}

func (c *Counter) Add(delta int64) {
    atomic.AddInt64(&c.value, delta)
}

func (c *Counter) Value() int64 {
    return atomic.LoadInt64(&c.value)
}

// Gauge tracks current values
type Gauge struct {
    value int64
}

func (g *Gauge) Set(value int64) {
    atomic.StoreInt64(&g.value, value)
}

func (g *Gauge) Inc() {
    atomic.AddInt64(&g.value, 1)
}

func (g *Gauge) Dec() {
    atomic.AddInt64(&g.value, -1)
}

func (g *Gauge) Value() int64 {
    return atomic.LoadInt64(&g.value)
}

// Histogram tracks distribution of values
type Histogram struct {
    mu      sync.RWMutex
    buckets []float64
    counts  []int64
    sum     float64
    count   int64
}

func NewHistogram(buckets []float64) *Histogram {
    return &Histogram{
        buckets: buckets,
        counts:  make([]int64, len(buckets)+1),
    }
}

func (h *Histogram) Observe(value float64) {
    h.mu.Lock()
    defer h.mu.Unlock()

    h.sum += value
    h.count++

    // Find bucket
    bucketIdx := len(h.buckets)
    for i, boundary := range h.buckets {
        if value <= boundary {
            bucketIdx = i
            break
        }
    }

    h.counts[bucketIdx]++
}

func (h *Histogram) Percentile(p float64) float64 {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if h.count == 0 {
        return 0
    }

    targetCount := float64(h.count) * p
    cumCount := int64(0)

    for i, count := range h.counts {
        cumCount += count
        if float64(cumCount) >= targetCount {
            if i >= len(h.buckets) {
                return h.buckets[len(h.buckets)-1]
            }
            return h.buckets[i]
        }
    }

    return 0
}

func (h *Histogram) Mean() float64 {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if h.count == 0 {
        return 0
    }

    return h.sum / float64(h.count)
}

func (h *Histogram) Count() int64 {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return h.count
}

// MetricsCollector methods

func (m *MetricsCollector) Counter(name string) *Counter {
    m.mu.Lock()
    defer m.mu.Unlock()

    if counter, exists := m.counters[name]; exists {
        return counter
    }

    counter := &Counter{}
    m.counters[name] = counter
    return counter
}

func (m *MetricsCollector) Gauge(name string) *Gauge {
    m.mu.Lock()
    defer m.mu.Unlock()

    if gauge, exists := m.gauges[name]; exists {
        return gauge
    }

    gauge := &Gauge{}
    m.gauges[name] = gauge
    return gauge
}

func (m *MetricsCollector) Histogram(name string, buckets []float64) *Histogram {
    m.mu.Lock()
    defer m.mu.Unlock()

    if histogram, exists := m.histograms[name]; exists {
        return histogram
    }

    histogram := NewHistogram(buckets)
    m.histograms[name] = histogram
    return histogram
}

func (m *MetricsCollector) Report() string {
    m.mu.RLock()
    defer m.mu.RUnlock()

    report := "Pipeline Metrics\n"
    report += "================\n\n"

    // Counters
    if len(m.counters) > 0 {
        report += "Counters:\n"
        for name, counter := range m.counters {
            report += fmt.Sprintf("  %s: %d\n", name, counter.Value())
        }
        report += "\n"
    }

    // Gauges
    if len(m.gauges) > 0 {
        report += "Gauges:\n"
        for name, gauge := range m.gauges {
            report += fmt.Sprintf("  %s: %d\n", name, gauge.Value())
        }
        report += "\n"
    }

    // Histograms
    if len(m.histograms) > 0 {
        report += "Histograms:\n"
        for name, histogram := range m.histograms {
            report += fmt.Sprintf("  %s:\n", name)
            report += fmt.Sprintf("    Count: %d\n", histogram.Count())
            report += fmt.Sprintf("    Mean: %.2f\n", histogram.Mean())
            report += fmt.Sprintf("    P50: %.2f\n", histogram.Percentile(0.5))
            report += fmt.Sprintf("    P95: %.2f\n", histogram.Percentile(0.95))
            report += fmt.Sprintf("    P99: %.2f\n", histogram.Percentile(0.99))
        }
        report += "\n"
    }

    return report
}

// MetricsReporter exports metrics
type MetricsReporter interface {
    Report(collector *MetricsCollector) error
}

// ConsoleReporter prints metrics to console
type ConsoleReporter struct {
    interval time.Duration
}

func NewConsoleReporter(interval time.Duration) *ConsoleReporter {
    return &ConsoleReporter{interval: interval}
}

func (r *ConsoleReporter) Start(collector *MetricsCollector, done <-chan struct{}) {
    ticker := time.NewTicker(r.interval)
    defer ticker.Stop()

    for {
        select {
        case <-done:
            return
        case <-ticker.C:
            fmt.Println(collector.Report())
        }
    }
}
```

### Checkpoint Coordinator

The `CheckpointCoordinator` periodically triggers state snapshots so the pipeline can recover from failures. It runs on a configurable interval (defaulting to one minute), asks the state backend to create a checkpoint, and keeps metadata about the last 10 checkpoints. If a failure occurs, you can call `RestoreLatest` to roll back to the most recent checkpoint and resume processing from that point. This gives the pipeline at-least-once processing guarantees without requiring manual intervention.

```go
// pkg/pipeline/checkpoint.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// CheckpointCoordinator manages checkpoints
type CheckpointCoordinator struct {
    mu             sync.Mutex
    backend        StateBackend
    interval       time.Duration
    lastCheckpoint time.Time
    checkpoints    []CheckpointMetadata
}

type CheckpointMetadata struct {
    ID        CheckpointID
    Timestamp time.Time
    Size      int64
}

func NewCheckpointCoordinator(backend StateBackend) *CheckpointCoordinator {
    return &CheckpointCoordinator{
        backend:     backend,
        interval:    time.Minute,
        checkpoints: make([]CheckpointMetadata, 0),
    }
}

func (c *CheckpointCoordinator) WithInterval(interval time.Duration) *CheckpointCoordinator {
    c.interval = interval
    return c
}

func (c *CheckpointCoordinator) Start(ctx context.Context) error {
    ticker := time.NewTicker(c.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := c.TriggerCheckpoint(ctx); err != nil {
                // Log error but continue
                fmt.Printf("Checkpoint error: %v\n", err)
            }
        }
    }
}

func (c *CheckpointCoordinator) TriggerCheckpoint(ctx context.Context) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Create checkpoint
    checkpointID, err := c.backend.Checkpoint(ctx)
    if err != nil {
        return fmt.Errorf("failed to create checkpoint: %w", err)
    }

    // Record metadata
    metadata := CheckpointMetadata{
        ID:        checkpointID,
        Timestamp: time.Now(),
    }

    c.checkpoints = append(c.checkpoints, metadata)
    c.lastCheckpoint = time.Now()

    // Keep only recent checkpoints
    if len(c.checkpoints) > 10 {
        c.checkpoints = c.checkpoints[len(c.checkpoints)-10:]
    }

    return nil
}

func (c *CheckpointCoordinator) RestoreLatest(ctx context.Context) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    if len(c.checkpoints) == 0 {
        return fmt.Errorf("no checkpoints available")
    }

    latest := c.checkpoints[len(c.checkpoints)-1]

    if err := c.backend.Restore(ctx, latest.ID); err != nil {
        return fmt.Errorf("failed to restore checkpoint: %w", err)
    }

    return nil
}

func (c *CheckpointCoordinator) ListCheckpoints() []CheckpointMetadata {
    c.mu.Lock()
    defer c.mu.Unlock()

    result := make([]CheckpointMetadata, len(c.checkpoints))
    copy(result, c.checkpoints)
    return result
}
```
