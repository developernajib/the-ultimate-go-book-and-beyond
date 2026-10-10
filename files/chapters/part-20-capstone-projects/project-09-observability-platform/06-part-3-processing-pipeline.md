## Part 3: Processing Pipeline

Once data enters the platform through the ingestion layer, it flows through a processing pipeline before being written to storage. The pipeline is a chain of composable processors that validate, enrich, sample, and aggregate data. This design follows the pipeline pattern common in stream processing systems: each processor receives a batch of data, transforms it, and passes it to the next stage. Using an interface-based design means you can add new processors (such as a rate limiter or a PII redactor) without modifying existing ones.

### 3.1 Pipeline Core

The pipeline core defines the `Processor` interface and the `Pipeline` struct that chains processors together. Each processor implements a simple `Process` method that takes a batch of data items and returns the transformed batch. The pipeline runs processors sequentially in the order they were registered, so you can control the exact order of operations: validate first, then enrich with metadata, then sample, then aggregate. If any processor returns an error, the pipeline stops processing that batch and reports the failure.

```go
// pkg/pipeline/pipeline.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"

    "observability/pkg/models"
    "observability/pkg/storage"
)

// Pipeline processes incoming telemetry data
type Pipeline struct {
    config PipelineConfig

    // Processors
    validators  []Validator
    enrichers   []Enricher
    samplers    []Sampler
    aggregators []Aggregator

    // Storage
    metricStore storage.MetricStore
    logStore    storage.LogStore
    traceStore  storage.TraceStore

    // Channels
    metricCh chan *models.Metric
    logCh    chan *models.LogEntry
    traceCh  chan *models.Span

    // Workers
    workers int

    // State
    mu      sync.RWMutex
    running bool
    stopCh  chan struct{}
    wg      sync.WaitGroup

    // Metrics
    metricsProcessed int64
    logsProcessed    int64
    tracesProcessed  int64
    errors           int64
}

// PipelineConfig configures the pipeline
type PipelineConfig struct {
    Workers       int
    BufferSize    int
    FlushInterval time.Duration
    MaxBatchSize  int
}

// NewPipeline creates a new processing pipeline
func NewPipeline(
    config PipelineConfig,
    metricStore storage.MetricStore,
    logStore storage.LogStore,
    traceStore storage.TraceStore,
) *Pipeline {
    return &Pipeline{
        config:      config,
        metricStore: metricStore,
        logStore:    logStore,
        traceStore:  traceStore,
        metricCh:    make(chan *models.Metric, config.BufferSize),
        logCh:       make(chan *models.LogEntry, config.BufferSize),
        traceCh:     make(chan *models.Span, config.BufferSize),
        workers:     config.Workers,
        validators:  make([]Validator, 0),
        enrichers:   make([]Enricher, 0),
        samplers:    make([]Sampler, 0),
        aggregators: make([]Aggregator, 0),
    }
}

// AddValidator adds a validator to the pipeline
func (p *Pipeline) AddValidator(v Validator) {
    p.validators = append(p.validators, v)
}

// AddEnricher adds an enricher to the pipeline
func (p *Pipeline) AddEnricher(e Enricher) {
    p.enrichers = append(p.enrichers, e)
}

// AddSampler adds a sampler to the pipeline
func (p *Pipeline) AddSampler(s Sampler) {
    p.samplers = append(p.samplers, s)
}

// AddAggregator adds an aggregator to the pipeline
func (p *Pipeline) AddAggregator(a Aggregator) {
    p.aggregators = append(p.aggregators, a)
}

// Start starts the pipeline
func (p *Pipeline) Start(ctx context.Context) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    if p.running {
        return fmt.Errorf("pipeline already running")
    }

    p.stopCh = make(chan struct{})
    p.running = true

    // Start metric workers
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.metricWorker()
    }

    // Start log workers
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.logWorker()
    }

    // Start trace workers
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.traceWorker()
    }

    // Start flusher
    p.wg.Add(1)
    go p.flusher()

    return nil
}

// ProcessMetric processes a metric
func (p *Pipeline) ProcessMetric(ctx context.Context, metric *models.Metric) error {
    select {
    case p.metricCh <- metric:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    default:
        // Channel full, apply back-pressure
        return fmt.Errorf("metric channel full")
    }
}

// ProcessLog processes a log entry
func (p *Pipeline) ProcessLog(ctx context.Context, entry *models.LogEntry) error {
    select {
    case p.logCh <- entry:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    default:
        return fmt.Errorf("log channel full")
    }
}

// ProcessTrace processes a span
func (p *Pipeline) ProcessTrace(ctx context.Context, span *models.Span) error {
    select {
    case p.traceCh <- span:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    default:
        return fmt.Errorf("trace channel full")
    }
}

// metricWorker processes metrics
func (p *Pipeline) metricWorker() {
    defer p.wg.Done()

    batch := make([]*models.Metric, 0, p.config.MaxBatchSize)

    for {
        select {
        case metric := <-p.metricCh:
            // Validate
            if err := p.validateMetric(metric); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Enrich
            if err := p.enrichMetric(metric); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Sample
            if !p.sampleMetric(metric) {
                continue
            }

            // Aggregate
            metric = p.aggregateMetric(metric)

            batch = append(batch, metric)

            // Flush if batch full
            if len(batch) >= p.config.MaxBatchSize {
                p.flushMetrics(batch)
                batch = make([]*models.Metric, 0, p.config.MaxBatchSize)
            }

            atomic.AddInt64(&p.metricsProcessed, 1)

        case <-p.stopCh:
            // Flush remaining
            if len(batch) > 0 {
                p.flushMetrics(batch)
            }
            return
        }
    }
}

// logWorker processes logs
func (p *Pipeline) logWorker() {
    defer p.wg.Done()

    batch := make([]*models.LogEntry, 0, p.config.MaxBatchSize)

    for {
        select {
        case entry := <-p.logCh:
            // Validate
            if err := p.validateLog(entry); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Enrich
            if err := p.enrichLog(entry); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Sample
            if !p.sampleLog(entry) {
                continue
            }

            batch = append(batch, entry)

            // Flush if batch full
            if len(batch) >= p.config.MaxBatchSize {
                p.flushLogs(batch)
                batch = make([]*models.LogEntry, 0, p.config.MaxBatchSize)
            }

            atomic.AddInt64(&p.logsProcessed, 1)

        case <-p.stopCh:
            // Flush remaining
            if len(batch) > 0 {
                p.flushLogs(batch)
            }
            return
        }
    }
}

// traceWorker processes traces
func (p *Pipeline) traceWorker() {
    defer p.wg.Done()

    batch := make([]*models.Span, 0, p.config.MaxBatchSize)

    for {
        select {
        case span := <-p.traceCh:
            // Validate
            if err := p.validateTrace(span); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Enrich
            if err := p.enrichTrace(span); err != nil {
                atomic.AddInt64(&p.errors, 1)
                continue
            }

            // Sample
            if !p.sampleTrace(span) {
                continue
            }

            batch = append(batch, span)

            // Flush if batch full
            if len(batch) >= p.config.MaxBatchSize {
                p.flushTraces(batch)
                batch = make([]*models.Span, 0, p.config.MaxBatchSize)
            }

            atomic.AddInt64(&p.tracesProcessed, 1)

        case <-p.stopCh:
            // Flush remaining
            if len(batch) > 0 {
                p.flushTraces(batch)
            }
            return
        }
    }
}

// flusher periodically flushes batches
func (p *Pipeline) flusher() {
    defer p.wg.Done()

    ticker := time.NewTicker(p.config.FlushInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            // Flush is handled by workers

        case <-p.stopCh:
            return
        }
    }
}

// validateMetric validates a metric
func (p *Pipeline) validateMetric(metric *models.Metric) error {
    for _, validator := range p.validators {
        if err := validator.ValidateMetric(metric); err != nil {
            return err
        }
    }
    return nil
}

// enrichMetric enriches a metric
func (p *Pipeline) enrichMetric(metric *models.Metric) error {
    for _, enricher := range p.enrichers {
        if err := enricher.EnrichMetric(metric); err != nil {
            return err
        }
    }
    return nil
}

// sampleMetric checks if metric should be sampled
func (p *Pipeline) sampleMetric(metric *models.Metric) bool {
    for _, sampler := range p.samplers {
        if !sampler.SampleMetric(metric) {
            return false
        }
    }
    return true
}

// aggregateMetric aggregates a metric
func (p *Pipeline) aggregateMetric(metric *models.Metric) *models.Metric {
    for _, aggregator := range p.aggregators {
        metric = aggregator.AggregateMetric(metric)
    }
    return metric
}

// validateLog validates a log entry
func (p *Pipeline) validateLog(entry *models.LogEntry) error {
    for _, validator := range p.validators {
        if err := validator.ValidateLog(entry); err != nil {
            return err
        }
    }
    return nil
}

// enrichLog enriches a log entry
func (p *Pipeline) enrichLog(entry *models.LogEntry) error {
    for _, enricher := range p.enrichers {
        if err := enricher.EnrichLog(entry); err != nil {
            return err
        }
    }
    return nil
}

// sampleLog checks if log should be sampled
func (p *Pipeline) sampleLog(entry *models.LogEntry) bool {
    for _, sampler := range p.samplers {
        if !sampler.SampleLog(entry) {
            return false
        }
    }
    return true
}

// validateTrace validates a span
func (p *Pipeline) validateTrace(span *models.Span) error {
    for _, validator := range p.validators {
        if err := validator.ValidateTrace(span); err != nil {
            return err
        }
    }
    return nil
}

// enrichTrace enriches a span
func (p *Pipeline) enrichTrace(span *models.Span) error {
    for _, enricher := range p.enrichers {
        if err := enricher.EnrichTrace(span); err != nil {
            return err
        }
    }
    return nil
}

// sampleTrace checks if span should be sampled
func (p *Pipeline) sampleTrace(span *models.Span) bool {
    for _, sampler := range p.samplers {
        if !sampler.SampleTrace(span) {
            return false
        }
    }
    return true
}

// flushMetrics flushes metrics to storage
func (p *Pipeline) flushMetrics(metrics []*models.Metric) {
    if len(metrics) == 0 {
        return
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := p.metricStore.Write(ctx, metrics); err != nil {
        atomic.AddInt64(&p.errors, 1)
    }
}

// flushLogs flushes logs to storage
func (p *Pipeline) flushLogs(logs []*models.LogEntry) {
    if len(logs) == 0 {
        return
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := p.logStore.Write(ctx, logs); err != nil {
        atomic.AddInt64(&p.errors, 1)
    }
}

// flushTraces flushes traces to storage
func (p *Pipeline) flushTraces(spans []*models.Span) {
    if len(spans) == 0 {
        return
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := p.traceStore.WriteSpans(ctx, spans); err != nil {
        atomic.AddInt64(&p.errors, 1)
    }
}

// Stop stops the pipeline
func (p *Pipeline) Stop(ctx context.Context) error {
    p.mu.Lock()
    if !p.running {
        p.mu.Unlock()
        return nil
    }
    p.running = false
    close(p.stopCh)
    p.mu.Unlock()

    p.wg.Wait()
    return nil
}

// Stats returns pipeline statistics
func (p *Pipeline) Stats() PipelineStats {
    return PipelineStats{
        MetricsProcessed: atomic.LoadInt64(&p.metricsProcessed),
        LogsProcessed:    atomic.LoadInt64(&p.logsProcessed),
        TracesProcessed:  atomic.LoadInt64(&p.tracesProcessed),
        Errors:           atomic.LoadInt64(&p.errors),
        MetricQueueSize:  len(p.metricCh),
        LogQueueSize:     len(p.logCh),
        TraceQueueSize:   len(p.traceCh),
    }
}

// PipelineStats represents pipeline statistics
type PipelineStats struct {
    MetricsProcessed int64
    LogsProcessed    int64
    TracesProcessed  int64
    Errors           int64
    MetricQueueSize  int
    LogQueueSize     int
    TraceQueueSize   int
}
```

### 3.2 Processors

These are the concrete processor implementations that plug into the pipeline. The validation processor rejects malformed data (such as metrics with empty names or timestamps in the future). The enrichment processor adds labels like hostname or environment. The sampling processor reduces data volume for high-cardinality series by keeping only a percentage of samples. Each processor is independently testable because it depends only on the `Processor` interface, not on the pipeline itself.

```go
// pkg/pipeline/processors.go
package pipeline

import (
    "fmt"
    "strings"

    "observability/pkg/models"
)

// Validator validates telemetry data
type Validator interface {
    ValidateMetric(*models.Metric) error
    ValidateLog(*models.LogEntry) error
    ValidateTrace(*models.Span) error
}

// Enricher enriches telemetry data
type Enricher interface {
    EnrichMetric(*models.Metric) error
    EnrichLog(*models.LogEntry) error
    EnrichTrace(*models.Span) error
}

// Sampler samples telemetry data
type Sampler interface {
    SampleMetric(*models.Metric) bool
    SampleLog(*models.LogEntry) bool
    SampleTrace(*models.Span) bool
}

// Aggregator aggregates telemetry data
type Aggregator interface {
    AggregateMetric(*models.Metric) *models.Metric
}

// BasicValidator validates basic fields
type BasicValidator struct{}

func (v *BasicValidator) ValidateMetric(m *models.Metric) error {
    if m.Name == "" {
        return fmt.Errorf("metric name is required")
    }
    if m.Timestamp.IsZero() {
        return fmt.Errorf("metric timestamp is required")
    }
    return nil
}

func (v *BasicValidator) ValidateLog(l *models.LogEntry) error {
    if l.Message == "" {
        return fmt.Errorf("log message is required")
    }
    if l.Timestamp.IsZero() {
        return fmt.Errorf("log timestamp is required")
    }
    return nil
}

func (v *BasicValidator) ValidateTrace(s *models.Span) error {
    if s.TraceID == "" {
        return fmt.Errorf("trace ID is required")
    }
    if s.SpanID == "" {
        return fmt.Errorf("span ID is required")
    }
    if s.StartTime.IsZero() {
        return fmt.Errorf("span start time is required")
    }
    return nil
}

// LabelEnricher adds labels to telemetry data
type LabelEnricher struct {
    Labels models.Labels
}

func (e *LabelEnricher) EnrichMetric(m *models.Metric) error {
    m.Labels = append(m.Labels, e.Labels...)
    return nil
}

func (e *LabelEnricher) EnrichLog(l *models.LogEntry) error {
    l.Labels = append(l.Labels, e.Labels...)
    return nil
}

func (e *LabelEnricher) EnrichTrace(s *models.Span) error {
    // Add as resource attributes
    for _, label := range e.Labels {
        s.Resource[label.Name] = label.Value
    }
    return nil
}

// RateSampler samples based on rate
type RateSampler struct {
    Rate    float64 // Sample rate (0-1)
    counter int64
}

func (s *RateSampler) SampleMetric(m *models.Metric) bool {
    s.counter++
    return float64(s.counter)* s.Rate >= 1.0
}

func (s *RateSampler) SampleLog(l *models.LogEntry) bool {
    s.counter++
    return float64(s.counter) * s.Rate >= 1.0
}

func (s *RateSampler) SampleTrace(span *models.Span) bool {
    s.counter++
    return float64(s.counter) * s.Rate >= 1.0
}

// TenantEnricher adds tenant ID
type TenantEnricher struct {
    TenantResolver func(any) string
}

func (e *TenantEnricher) EnrichMetric(m *models.Metric) error {
    if m.TenantID == "" {
        m.TenantID = e.TenantResolver(m)
    }
    return nil
}

func (e *TenantEnricher) EnrichLog(l *models.LogEntry) error {
    if l.TenantID == "" {
        l.TenantID = e.TenantResolver(l)
    }
    return nil
}

func (e *TenantEnricher) EnrichTrace(s *models.Span) error {
    if s.TenantID == "" {
        s.TenantID = e.TenantResolver(s)
    }
    return nil
}
```
