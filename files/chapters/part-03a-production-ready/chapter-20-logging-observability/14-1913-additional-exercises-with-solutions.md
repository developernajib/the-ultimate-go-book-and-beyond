## 20.13 Additional Exercises with Solutions

### Exercise 4: Build a Log Aggregation Pipeline

**Problem**: Create a log aggregation system that collects logs from multiple services, enriches them with metadata, and forwards them to a storage backend.

**Solution:**

The pipeline buffers incoming log entries and flushes them in batches, either when the buffer fills or on a timer, whichever comes first. Each entry passes through a chain of `Processor` implementations (enrichment, redaction, sampling) before being written to one or more `Sink` backends (file, HTTP endpoint). This design decouples ingestion throughput from backend write latency.

```go
// logpipeline/pipeline.go
package logpipeline

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "sync"
    "time"
)

// LogEntry represents a structured log entry
type LogEntry struct {
    Timestamp   time.Time              `json:"timestamp"`
    Level       string                 `json:"level"`
    Message     string                 `json:"message"`
    Service     string                 `json:"service"`
    TraceID     string                 `json:"trace_id,omitempty"`
    SpanID      string                 `json:"span_id,omitempty"`
    Host        string                 `json:"host"`
    Environment string                 `json:"environment"`
    Attributes  map[string]any `json:"attributes,omitempty"`
}

// Processor transforms log entries
type Processor interface {
    Process(entry *LogEntry) error
}

// Sink writes log entries to a destination
type Sink interface {
    Write(entries []LogEntry) error
    Close() error
}

// Pipeline aggregates, processes, and forwards logs
type Pipeline struct {
    processors []Processor
    sinks      []Sink
    buffer     []LogEntry
    bufferSize int
    flushInterval time.Duration

    mu      sync.Mutex
    wg      sync.WaitGroup
    done    chan struct{}
}

// NewPipeline creates a new log pipeline
func NewPipeline(bufferSize int, flushInterval time.Duration) *Pipeline {
    p := &Pipeline{
        bufferSize:    bufferSize,
        flushInterval: flushInterval,
        buffer:        make([]LogEntry, 0, bufferSize),
        done:          make(chan struct{}),
    }
    p.startFlusher()
    return p
}

// AddProcessor adds a processor to the pipeline
func (p *Pipeline) AddProcessor(proc Processor) {
    p.processors = append(p.processors, proc)
}

// AddSink adds a sink to the pipeline
func (p *Pipeline) AddSink(sink Sink) {
    p.sinks = append(p.sinks, sink)
}

// Ingest adds a log entry to the pipeline
func (p *Pipeline) Ingest(entry LogEntry) error {
    // Run processors
    for _, proc := range p.processors {
        if err := proc.Process(&entry); err != nil {
            return fmt.Errorf("processor error: %w", err)
        }
    }

    p.mu.Lock()
    p.buffer = append(p.buffer, entry)
    shouldFlush := len(p.buffer) >= p.bufferSize
    p.mu.Unlock()

    if shouldFlush {
        p.flush()
    }

    return nil
}

func (p *Pipeline) startFlusher() {
    p.wg.Add(1)
    go func() {
        defer p.wg.Done()
        ticker := time.NewTicker(p.flushInterval)
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                p.flush()
            case <-p.done:
                p.flush() // Final flush
                return
            }
        }
    }()
}

func (p *Pipeline) flush() {
    p.mu.Lock()
    if len(p.buffer) == 0 {
        p.mu.Unlock()
        return
    }

    entries := p.buffer
    p.buffer = make([]LogEntry, 0, p.bufferSize)
    p.mu.Unlock()

    // Write to all sinks
    for _, sink := range p.sinks {
        if err := sink.Write(entries); err != nil {
            fmt.Fprintf(os.Stderr, "sink error: %v\n", err)
        }
    }
}

// Close shuts down the pipeline
func (p *Pipeline) Close() error {
    close(p.done)
    p.wg.Wait()

    for _, sink := range p.sinks {
        sink.Close()
    }
    return nil
}

// ============================================================================
// PROCESSORS
// ============================================================================

// EnrichmentProcessor adds metadata to log entries
type EnrichmentProcessor struct {
    Host        string
    Environment string
    Service     string
}

func (p *EnrichmentProcessor) Process(entry *LogEntry) error {
    entry.Host = p.Host
    entry.Environment = p.Environment
    if entry.Service == "" {
        entry.Service = p.Service
    }
    return nil
}

// SensitiveDataProcessor redacts sensitive fields
type SensitiveDataProcessor struct {
    SensitiveFields map[string]bool
}

func (p *SensitiveDataProcessor) Process(entry *LogEntry) error {
    if entry.Attributes == nil {
        return nil
    }

    for key := range entry.Attributes {
        if p.SensitiveFields[key] {
            entry.Attributes[key] = "[REDACTED]"
        }
    }
    return nil
}

// SamplingProcessor samples log entries by level
type SamplingProcessor struct {
    SampleRates map[string]float64 // level -> sample rate
    counter     uint64
}

func (p *SamplingProcessor) Process(entry *LogEntry) error {
    rate, ok := p.SampleRates[entry.Level]
    if !ok {
        rate = 1.0 // Default: keep all
    }

    p.counter++
    if float64(p.counter%100)/100.0 > rate {
        return fmt.Errorf("sampled out")
    }

    return nil
}

// ============================================================================
// SINKS
// ============================================================================

// FileSink writes logs to a file
type FileSink struct {
    file *os.File
    mu   sync.Mutex
}

func NewFileSink(path string) (*FileSink, error) {
    f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    if err != nil {
        return nil, err
    }
    return &FileSink{file: f}, nil
}

func (s *FileSink) Write(entries []LogEntry) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    encoder := json.NewEncoder(s.file)
    for _, entry := range entries {
        if err := encoder.Encode(entry); err != nil {
            return err
        }
    }
    return nil
}

func (s *FileSink) Close() error {
    return s.file.Close()
}

// HTTPSink sends logs to an HTTP endpoint
type HTTPSink struct {
    endpoint string
    client   *http.Client
}

func NewHTTPSink(endpoint string) *HTTPSink {
    return &HTTPSink{
        endpoint: endpoint,
        client: &http.Client{
            Timeout: 10 * time.Second,
        },
    }
}

func (s *HTTPSink) Write(entries []LogEntry) error {
    data, err := json.Marshal(entries)
    if err != nil {
        return err
    }

    resp, err := s.client.Post(s.endpoint, "application/json", bytes.NewReader(data))
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
    }

    return nil
}

func (s *HTTPSink) Close() error {
    s.client.CloseIdleConnections()
    return nil
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

func Example() {
    // Create pipeline
    pipeline := NewPipeline(100, time.Second)

    // Add processors
    pipeline.AddProcessor(&EnrichmentProcessor{
        Host:        "web-server-1",
        Environment: "production",
        Service:     "api-gateway",
    })

    pipeline.AddProcessor(&SensitiveDataProcessor{
        SensitiveFields: map[string]bool{
            "password": true,
            "token":    true,
            "ssn":      true,
        },
    })

    // Add sinks
    fileSink, _ := NewFileSink("/var/log/app.jsonl")
    pipeline.AddSink(fileSink)

    httpSink := NewHTTPSink("http://loki:3100/loki/api/v1/push")
    pipeline.AddSink(httpSink)

    // Ingest logs
    pipeline.Ingest(LogEntry{
        Timestamp: time.Now(),
        Level:     "INFO",
        Message:   "User logged in",
        TraceID:   "abc123",
        Attributes: map[string]any{
            "user_id": "user-456",
            "ip":      "192.168.1.1",
        },
    })

    // Graceful shutdown
    pipeline.Close()
}
```

---

### Exercise 5: Implement Metrics Cardinality Guard

**Problem**: Create a metrics wrapper that prevents high-cardinality label combinations from crashing Prometheus.

**Solution:**

The `CardinalityGuard` tracks unique label combinations using a hash set and rejects new combinations once a configurable limit is reached. Rejected observations fall through to a dedicated fallback metric, ensuring data is never silently lost while the primary metric stays within safe cardinality bounds. A periodic cleanup goroutine evicts stale combinations so the guard can recover after a burst of unusual labels.

```go
// cardinalityguard/guard.go
package cardinalityguard

import (
    "fmt"
    "hash/fnv"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// CardinalityGuard wraps Prometheus metrics with cardinality protection
type CardinalityGuard struct {
    maxCardinality int
    windowDuration time.Duration

    mu       sync.RWMutex
    counters map[uint64]int64 // hash -> count
    windows  map[uint64]time.Time // hash -> first seen
    dropped  int64 // label combinations rejected at the limit
}

// NewCardinalityGuard creates a new cardinality guard
func NewCardinalityGuard(maxCardinality int, windowDuration time.Duration) *CardinalityGuard {
    cg := &CardinalityGuard{
        maxCardinality: maxCardinality,
        windowDuration: windowDuration,
        counters:       make(map[uint64]int64),
        windows:        make(map[uint64]time.Time),
    }
    go cg.cleanup()
    return cg
}

// hashLabels creates a hash from label values
func hashLabels(labels []string) uint64 {
    h := fnv.New64a()
    for _, label := range labels {
        h.Write([]byte(label))
        h.Write([]byte{0}) // separator
    }
    return h.Sum64()
}

// AllowLabels checks if label combination is allowed
func (cg *CardinalityGuard) AllowLabels(labels []string) bool {
    hash := hashLabels(labels)

    cg.mu.Lock()
    defer cg.mu.Unlock()

    // Already tracking this combination
    if _, exists := cg.counters[hash]; exists {
        cg.counters[hash]++
        return true
    }

    // Check if we've hit cardinality limit
    if len(cg.counters) >= cg.maxCardinality {
        cg.dropped++
        return false
    }

    // Track new combination
    cg.counters[hash] = 1
    cg.windows[hash] = time.Now()
    return true
}

func (cg *CardinalityGuard) cleanup() {
    ticker := time.NewTicker(cg.windowDuration / 2)
    defer ticker.Stop()

    for range ticker.C {
        cg.mu.Lock()
        now := time.Now()
        for hash, firstSeen := range cg.windows {
            if now.Sub(firstSeen) > cg.windowDuration {
                delete(cg.counters, hash)
                delete(cg.windows, hash)
            }
        }
        cg.mu.Unlock()
    }
}

// Stats returns the number of label combinations currently tracked, the
// number of observations rejected at the limit, and the remaining headroom.
func (cg *CardinalityGuard) Stats() (unique int, dropped int64, remaining int) {
    cg.mu.RLock()
    defer cg.mu.RUnlock()
    return len(cg.counters), cg.dropped, cg.maxCardinality - len(cg.counters)
}

// ============================================================================
// GUARDED COUNTER
// ============================================================================

// GuardedCounter is a Counter with cardinality protection
type GuardedCounter struct {
    counter     *prometheus.CounterVec
    guard       *CardinalityGuard
    fallback    prometheus.Counter
    droppedVec  prometheus.Counter
}

// NewGuardedCounter creates a guarded counter
func NewGuardedCounter(opts prometheus.CounterOpts, labels []string, maxCardinality int) *GuardedCounter {
    gc := &GuardedCounter{
        counter: prometheus.NewCounterVec(opts, labels),
        guard:   NewCardinalityGuard(maxCardinality, time.Hour),
        fallback: prometheus.NewCounter(prometheus.CounterOpts{
            Name: opts.Name + "_fallback",
            Help: "Fallback counter for dropped high-cardinality labels",
        }),
        droppedVec: prometheus.NewCounter(prometheus.CounterOpts{
            Name: opts.Name + "_dropped_total",
            Help: "Counter of dropped label combinations due to cardinality limit",
        }),
    }
    prometheus.MustRegister(gc.counter, gc.fallback, gc.droppedVec)
    return gc
}

// WithLabelValues records with cardinality check
func (gc *GuardedCounter) WithLabelValues(labels ...string) prometheus.Counter {
    if gc.guard.AllowLabels(labels) {
        return gc.counter.WithLabelValues(labels...)
    }

    gc.droppedVec.Inc()
    return gc.fallback
}

// Inc increments with cardinality check
func (gc *GuardedCounter) Inc(labels ...string) {
    gc.WithLabelValues(labels...).Inc()
}

// ============================================================================
// GUARDED HISTOGRAM
// ============================================================================

// GuardedHistogram is a Histogram with cardinality protection
type GuardedHistogram struct {
    histogram   *prometheus.HistogramVec
    guard       *CardinalityGuard
    fallback    prometheus.Histogram
}

// NewGuardedHistogram creates a guarded histogram
func NewGuardedHistogram(opts prometheus.HistogramOpts, labels []string, maxCardinality int) *GuardedHistogram {
    gh := &GuardedHistogram{
        histogram: prometheus.NewHistogramVec(opts, labels),
        guard:     NewCardinalityGuard(maxCardinality, time.Hour),
        fallback: prometheus.NewHistogram(prometheus.HistogramOpts{
            Name:    opts.Name + "_fallback",
            Help:    "Fallback histogram for dropped high-cardinality labels",
            Buckets: opts.Buckets,
        }),
    }
    prometheus.MustRegister(gh.histogram, gh.fallback)
    return gh
}

// WithLabelValues records with cardinality check
func (gh *GuardedHistogram) WithLabelValues(labels ...string) prometheus.Observer {
    if gh.guard.AllowLabels(labels) {
        return gh.histogram.WithLabelValues(labels...)
    }
    return gh.fallback
}

// Observe records with cardinality check
func (gh *GuardedHistogram) Observe(value float64, labels ...string) {
    gh.WithLabelValues(labels...).Observe(value)
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

func Example() {
    // Create guarded counter with max 1000 unique label combinations
    requestCounter := NewGuardedCounter(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests",
        },
        []string{"method", "path", "status"},
        1000, // Max cardinality
    )

    // Safe to use with any labels - high cardinality is automatically handled
    requestCounter.Inc("GET", "/api/users/123", "200")    // Tracked
    requestCounter.Inc("GET", "/api/users/456", "200")    // Tracked
    // ... after 1000 unique combinations ...
    requestCounter.Inc("GET", "/api/users/99999", "200")  // Goes to fallback

    // Create guarded histogram
    latencyHistogram := NewGuardedHistogram(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
        500,
    )

    latencyHistogram.Observe(0.123, "GET", "/api/users/123")
}
```

**Know what this guard does and does not protect.** It is a genuine safety net, and it is not a substitute for labelling metrics correctly in the first place. The usage example above is deliberately labelling with `/api/users/123`, a raw path, which is the very mistake that makes the guard necessary. In real code, use the route template and the guard becomes a backstop that never fires.

Two limitations are worth understanding before you rely on it.

**The guard's bookkeeping and Prometheus's series are separate.** `cleanup` deletes entries from `cg.counters` once a window expires, but it does not delete anything from the underlying `CounterVec`. Prometheus still holds every series it was ever given. Once a hash is forgotten, that same label combination is admitted again, is already registered, and consumes no *new* Prometheus memory, so this is safe. But it does mean the guard's `unique` count is a count of *recently active* combinations, not of live Prometheus series, and the two drift apart. If you want to actually release memory, call `DeleteLabelValues` on the vec in `cleanup` as well.

**The first N combinations win, not the most important ones.** The limit is enforced by arrival order. If an attacker (or a bad deploy) floods you with unique labels at startup, they fill the budget and your *legitimate* routes get sent to the fallback for the rest of the window. That is the correct trade against an out-of-memory Prometheus, and it is still a degraded state. This is why `dropped` must be a real counter, as fixed above: it is the signal that tells you the guard is active and your labels need attention. Alert on it being non-zero. A cardinality guard that silently absorbs the problem just relocates it.

---

### Exercise 6: Build an Anomaly Detection System for Metrics

**Problem**: Create a system that detects anomalies in time-series metrics using statistical methods.

**Solution:**

Two detection strategies are implemented below. The `Detector` uses a sliding window of recent data points to compute a z-score for each new observation, values beyond the configured threshold are flagged as anomalies. The `EWMADetector` offers a lighter-weight alternative using an exponentially weighted moving average that adapts to gradual trends while still flagging sudden spikes. An `AlertManager` ties both approaches to alerting rules that require anomalies to persist for a minimum duration before firing.

```go
// anomaly/detector.go
package anomaly

import (
    "context"
    "fmt"
    "math"
    "sync"
    "time"
)

// DataPoint represents a time-series data point
type DataPoint struct {
    Timestamp time.Time
    Value     float64
    Labels    map[string]string
}

// Anomaly represents a detected anomaly
type Anomaly struct {
    DataPoint
    Score       float64  // How anomalous (z-score)
    Expected    float64  // Expected value
    Description string
}

// Detector detects anomalies in time-series data
type Detector struct {
    windowSize    int
    threshold     float64 // z-score threshold
    seasonality   time.Duration

    mu            sync.RWMutex
    history       map[string][]DataPoint // metric key -> history
    baselines     map[string]*Baseline
    anomalies     []Anomaly
}

// Baseline represents historical statistics
type Baseline struct {
    Mean       float64
    StdDev     float64
    Min        float64
    Max        float64
    Count      int64
    LastUpdate time.Time
}

// NewDetector creates a new anomaly detector
func NewDetector(windowSize int, threshold float64, seasonality time.Duration) *Detector {
    return &Detector{
        windowSize:  windowSize,
        threshold:   threshold,
        seasonality: seasonality,
        history:     make(map[string][]DataPoint),
        baselines:   make(map[string]*Baseline),
    }
}

// metricKey generates a unique key for a metric + labels combination
func metricKey(metric string, labels map[string]string) string {
    key := metric
    for k, v := range labels {
        key += fmt.Sprintf(";%s=%s", k, v)
    }
    return key
}

// Ingest adds a data point and checks for anomalies
func (d *Detector) Ingest(metric string, point DataPoint) *Anomaly {
    key := metricKey(metric, point.Labels)

    d.mu.Lock()
    defer d.mu.Unlock()

    // Add to history
    history := d.history[key]
    history = append(history, point)

    // Trim history to window size
    if len(history) > d.windowSize {
        history = history[len(history)-d.windowSize:]
    }
    d.history[key] = history

    // Need minimum data points for detection
    if len(history) < 10 {
        return nil
    }

    // Calculate baseline
    baseline := d.calculateBaseline(history)
    d.baselines[key] = baseline

    // Check for anomaly using z-score
    zScore := (point.Value - baseline.Mean) / baseline.StdDev
    if math.IsNaN(zScore) || math.IsInf(zScore, 0) {
        return nil
    }

    if math.Abs(zScore) > d.threshold {
        anomaly := &Anomaly{
            DataPoint:   point,
            Score:       zScore,
            Expected:    baseline.Mean,
            Description: d.describeAnomaly(point.Value, baseline, zScore),
        }
        d.anomalies = append(d.anomalies, *anomaly)
        return anomaly
    }

    return nil
}

// calculateBaseline computes statistical baseline from history
func (d *Detector) calculateBaseline(history []DataPoint) *Baseline {
    n := len(history)
    if n == 0 {
        return &Baseline{}
    }

    // Calculate mean
    var sum float64
    min := history[0].Value
    max := history[0].Value

    for _, dp := range history {
        sum += dp.Value
        if dp.Value < min {
            min = dp.Value
        }
        if dp.Value > max {
            max = dp.Value
        }
    }
    mean := sum / float64(n)

    // Calculate standard deviation
    var variance float64
    for _, dp := range history {
        diff := dp.Value - mean
        variance += diff * diff
    }
    variance /= float64(n)
    stdDev := math.Sqrt(variance)

    // Minimum stdDev to avoid division by zero
    if stdDev < 0.001 {
        stdDev = 0.001
    }

    return &Baseline{
        Mean:       mean,
        StdDev:     stdDev,
        Min:        min,
        Max:        max,
        Count:      int64(n),
        LastUpdate: time.Now(),
    }
}

func (d *Detector) describeAnomaly(value float64, baseline *Baseline, zScore float64) string {
    direction := "higher"
    if zScore < 0 {
        direction = "lower"
    }

    percentDiff := math.Abs(value-baseline.Mean) / baseline.Mean * 100
    return fmt.Sprintf("Value %.2f is %.1f%% %s than expected (mean: %.2f, z-score: %.2f)",
        value, percentDiff, direction, baseline.Mean, zScore)
}

// GetRecentAnomalies returns anomalies from the last duration
func (d *Detector) GetRecentAnomalies(since time.Duration) []Anomaly {
    d.mu.RLock()
    defer d.mu.RUnlock()

    cutoff := time.Now().Add(-since)
    var recent []Anomaly
    for _, a := range d.anomalies {
        if a.Timestamp.After(cutoff) {
            recent = append(recent, a)
        }
    }
    return recent
}

// GetBaseline returns the baseline for a metric
func (d *Detector) GetBaseline(metric string, labels map[string]string) *Baseline {
    key := metricKey(metric, labels)

    d.mu.RLock()
    defer d.mu.RUnlock()

    return d.baselines[key]
}

// ============================================================================
// MOVING AVERAGE DETECTOR (Alternative approach)
// ============================================================================

// EWMADetector uses Exponentially Weighted Moving Average
type EWMADetector struct {
    alpha     float64 // Smoothing factor (0-1)
    threshold float64 // Deviation threshold

    mu     sync.RWMutex
    ewma   map[string]float64
    ewmVar map[string]float64 // Exponential weighted variance
}

// NewEWMADetector creates a new EWMA-based detector
func NewEWMADetector(alpha, threshold float64) *EWMADetector {
    return &EWMADetector{
        alpha:     alpha,
        threshold: threshold,
        ewma:      make(map[string]float64),
        ewmVar:    make(map[string]float64),
    }
}

// Ingest checks a new value for anomalies using EWMA
func (d *EWMADetector) Ingest(metric string, value float64, labels map[string]string) *Anomaly {
    key := metricKey(metric, labels)

    d.mu.Lock()
    defer d.mu.Unlock()

    // Initialize if first value
    if _, exists := d.ewma[key]; !exists {
        d.ewma[key] = value
        d.ewmVar[key] = 0
        return nil
    }

    // Get current EWMA and variance
    currentEWMA := d.ewma[key]
    currentVar := d.ewmVar[key]

    // Calculate deviation
    diff := value - currentEWMA
    stdDev := math.Sqrt(currentVar)
    if stdDev < 0.001 {
        stdDev = 0.001
    }
    zScore := diff / stdDev

    // Update EWMA and variance
    d.ewma[key] = d.alpha*value + (1-d.alpha)*currentEWMA
    d.ewmVar[key] = d.alpha*(diff*diff) + (1-d.alpha)*currentVar

    // Check for anomaly
    if math.Abs(zScore) > d.threshold {
        return &Anomaly{
            DataPoint: DataPoint{
                Timestamp: time.Now(),
                Value:     value,
                Labels:    labels,
            },
            Score:       zScore,
            Expected:    currentEWMA,
            Description: fmt.Sprintf("EWMA anomaly: value %.2f, expected %.2f (z=%.2f)", value, currentEWMA, zScore),
        }
    }

    return nil
}

// ============================================================================
// ALERTING INTEGRATION
// ============================================================================

// AlertRule defines when to alert
type AlertRule struct {
    Name        string
    Metric      string
    Threshold   float64
    Duration    time.Duration
    Labels      map[string]string
    Annotations map[string]string
}

// AlertManager manages anomaly alerts
type AlertManager struct {
    detector *Detector
    rules    []AlertRule
    handler  func(Anomaly, AlertRule)

    activeAlerts map[string]time.Time // alert key -> first trigger
    mu           sync.RWMutex
}

func NewAlertManager(detector *Detector, handler func(Anomaly, AlertRule)) *AlertManager {
    return &AlertManager{
        detector:     detector,
        handler:      handler,
        activeAlerts: make(map[string]time.Time),
    }
}

func (am *AlertManager) AddRule(rule AlertRule) {
    am.rules = append(am.rules, rule)
}

func (am *AlertManager) Check(ctx context.Context) {
    anomalies := am.detector.GetRecentAnomalies(5 * time.Minute)

    for _, anomaly := range anomalies {
        for _, rule := range am.rules {
            if am.matchesRule(anomaly, rule) {
                am.handleAnomaly(anomaly, rule)
            }
        }
    }
}

func (am *AlertManager) matchesRule(anomaly Anomaly, rule AlertRule) bool {
    if math.Abs(anomaly.Score) < rule.Threshold {
        return false
    }

    for k, v := range rule.Labels {
        if anomaly.Labels[k] != v {
            return false
        }
    }

    return true
}

func (am *AlertManager) handleAnomaly(anomaly Anomaly, rule AlertRule) {
    key := fmt.Sprintf("%s:%v", rule.Name, anomaly.Labels)

    am.mu.Lock()
    defer am.mu.Unlock()

    firstTrigger, exists := am.activeAlerts[key]
    if !exists {
        am.activeAlerts[key] = anomaly.Timestamp
        return
    }

    // Alert if condition persists for required duration
    if time.Since(firstTrigger) >= rule.Duration {
        am.handler(anomaly, rule)
        delete(am.activeAlerts, key) // Reset after firing
    }
}
```

### Staff Lens: Advanced Observability Is Often Simpler Than It Looks

The exercises above build sophisticated observability systems. In practice, most teams do not need to build them. Use existing tools: Prometheus, Grafana, OpenTelemetry, Jaeger. Hand-rolling observability infrastructure is rarely the right use of engineering time. Adopt, configure, operate. Do not build.

---
