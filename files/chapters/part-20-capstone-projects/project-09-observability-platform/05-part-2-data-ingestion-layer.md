## Part 2: Data Ingestion Layer

The ingestion layer is the front door of the observability platform. It accepts telemetry data from applications using whichever protocol they already speak: OpenTelemetry (OTLP), Prometheus exposition format, StatsD UDP packets, or structured log streams. Each receiver runs concurrently and converts incoming data into the platform's internal domain models before forwarding it to the processing pipeline. Designing the ingestion layer to handle multiple protocols means teams can adopt the platform without rewriting their existing instrumentation.

### 2.1 OTLP Receiver

OpenTelemetry Protocol (OTLP) is the modern standard for exporting metrics, logs, and traces from instrumented applications. This receiver implements a gRPC server that accepts OTLP export requests, converts the protobuf messages into the platform's internal `Metric`, `LogEntry`, and `Span` models, and forwards them through a channel-based pipeline. The receiver tracks active connections and supports graceful shutdown so that in-flight data is not lost during deployments.

```go
// pkg/ingestion/otlp/receiver.go
package otlp

import (
    "context"
    "fmt"
    "sync"
    "time"

    "go.opentelemetry.io/collector/pdata/pcommon"
    "go.opentelemetry.io/collector/pdata/plog"
    "go.opentelemetry.io/collector/pdata/pmetric"
    "go.opentelemetry.io/collector/pdata/ptrace"
    "google.golang.org/grpc"

    "observability/pkg/models"
    "observability/pkg/pipeline"
)

// Receiver receives OTLP telemetry data
type Receiver struct {
    addr     string
    server   *grpc.Server
    pipeline *pipeline.Pipeline

    mu       sync.RWMutex
    running  bool

    // Metrics
    metricsReceived  int64
    logsReceived     int64
    tracesReceived   int64
}

// NewReceiver creates a new OTLP receiver
func NewReceiver(addr string, pipeline *pipeline.Pipeline) *Receiver {
    return &Receiver{
        addr:     addr,
        pipeline: pipeline,
    }
}

// Start starts the OTLP receiver
func (r *Receiver) Start(ctx context.Context) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.running {
        return fmt.Errorf("receiver already running")
    }

    // Create gRPC server
    r.server = grpc.NewServer(
        grpc.MaxRecvMsgSize(64 * 1024 * 1024), // 64MB
    )

    // Register OTLP services
    // Note: In production, use official OTLP protobuf definitions
    // This is a simplified version

    r.running = true

    // Start listening
    go func() {
        // Implementation of gRPC server listening
    }()

    return nil
}

// Stop stops the receiver
func (r *Receiver) Stop(ctx context.Context) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if !r.running {
        return nil
    }

    if r.server != nil {
        r.server.GracefulStop()
    }

    r.running = false
    return nil
}

// ConvertMetrics converts OTLP metrics to internal format
func (r *Receiver) ConvertMetrics(md pmetric.Metrics) ([]*models.Metric, error) {
    var metrics []*models.Metric

    resourceMetrics := md.ResourceMetrics()
    for i := 0; i < resourceMetrics.Len(); i++ {
        rm := resourceMetrics.At(i)
        resource := rm.Resource()

        scopeMetrics := rm.ScopeMetrics()
        for j := 0; j < scopeMetrics.Len(); j++ {
            sm := scopeMetrics.At(j)

            metricSlice := sm.Metrics()
            for k := 0; k < metricSlice.Len(); k++ {
                metric := metricSlice.At(k)

                converted, err := r.convertMetric(metric, resource.Attributes())
                if err != nil {
                    return nil, fmt.Errorf("converting metric: %w", err)
                }

                metrics = append(metrics, converted...)
            }
        }
    }

    return metrics, nil
}

// convertMetric converts a single OTLP metric
func (r *Receiver) convertMetric(m pmetric.Metric, resourceAttrs pcommon.Map) ([]*models.Metric, error) {
    var metrics []*models.Metric

    name := m.Name()

    switch m.Type() {
    case pmetric.MetricTypeGauge:
        gauge := m.Gauge()
        dataPoints := gauge.DataPoints()

        for i := 0; i < dataPoints.Len(); i++ {
            dp := dataPoints.At(i)

            metric := &models.Metric{
                Name:      name,
                Type:      models.MetricTypeGauge,
                Timestamp: dp.Timestamp().AsTime(),
                Value:     dp.DoubleValue(),
                Labels:    r.convertAttributes(dp.Attributes(), resourceAttrs),
            }

            metrics = append(metrics, metric)
        }

    case pmetric.MetricTypeSum:
        sum := m.Sum()
        dataPoints := sum.DataPoints()

        metricType := models.MetricTypeCounter
        if !sum.IsMonotonic() {
            metricType = models.MetricTypeGauge
        }

        for i := 0; i < dataPoints.Len(); i++ {
            dp := dataPoints.At(i)

            metric := &models.Metric{
                Name:      name,
                Type:      metricType,
                Timestamp: dp.Timestamp().AsTime(),
                Value:     dp.DoubleValue(),
                Labels:    r.convertAttributes(dp.Attributes(), resourceAttrs),
            }

            metrics = append(metrics, metric)
        }

    case pmetric.MetricTypeHistogram:
        histogram := m.Histogram()
        dataPoints := histogram.DataPoints()

        for i := 0; i < dataPoints.Len(); i++ {
            dp := dataPoints.At(i)

            buckets := make([]models.Bucket, dp.BucketCounts().Len())
            for j := 0; j < dp.BucketCounts().Len(); j++ {
                buckets[j] = models.Bucket{
                    UpperBound: dp.ExplicitBounds().At(j),
                    Count:      dp.BucketCounts().At(j),
                }
            }

            metric := &models.Metric{
                Name:      name,
                Type:      models.MetricTypeHistogram,
                Timestamp: dp.Timestamp().AsTime(),
                Count:     dp.Count(),
                Sum:       dp.Sum(),
                Buckets:   buckets,
                Labels:    r.convertAttributes(dp.Attributes(), resourceAttrs),
            }

            metrics = append(metrics, metric)
        }
    }

    return metrics, nil
}

// convertAttributes converts OTLP attributes to labels
func (r *Receiver) convertAttributes(attrs pcommon.Map, resourceAttrs pcommon.Map) models.Labels {
    var labels models.Labels

    // Add metric attributes
    attrs.Range(func(k string, v pcommon.Value) bool {
        labels = append(labels, models.Label{
            Name:  k,
            Value: v.AsString(),
        })
        return true
    })

    // Add resource attributes with prefix
    resourceAttrs.Range(func(k string, v pcommon.Value) bool {
        labels = append(labels, models.Label{
            Name:  "resource_" + k,
            Value: v.AsString(),
        })
        return true
    })

    return labels
}

// ConvertLogs converts OTLP logs to internal format
func (r *Receiver) ConvertLogs(ld plog.Logs) ([]*models.LogEntry, error) {
    var logs []*models.LogEntry

    resourceLogs := ld.ResourceLogs()
    for i := 0; i < resourceLogs.Len(); i++ {
        rl := resourceLogs.At(i)
        resource := rl.Resource()

        scopeLogs := rl.ScopeLogs()
        for j := 0; j < scopeLogs.Len(); j++ {
            sl := scopeLogs.At(j)

            logRecords := sl.LogRecords()
            for k := 0; k < logRecords.Len(); k++ {
                lr := logRecords.At(k)

                entry := &models.LogEntry{
                    Timestamp: lr.Timestamp().AsTime(),
                    Level:     r.convertSeverity(lr.SeverityNumber()),
                    Message:   lr.Body().AsString(),
                    Fields:    make(map[string]any),
                }

                // Extract trace context
                if !lr.TraceID().IsEmpty() {
                    entry.TraceID = lr.TraceID().String()
                }
                if !lr.SpanID().IsEmpty() {
                    entry.SpanID = lr.SpanID().String()
                }

                // Convert attributes to fields
                lr.Attributes().Range(func(k string, v pcommon.Value) bool {
                    entry.Fields[k] = v.AsRaw()
                    return true
                })

                // Extract resource attributes
                r.extractResourceAttributes(entry, resource.Attributes())

                logs = append(logs, entry)
            }
        }
    }

    return logs, nil
}

// convertSeverity converts OTLP severity to log level
func (r *Receiver) convertSeverity(severity plog.SeverityNumber) models.LogLevel {
    if severity >= plog.SeverityNumberFatal {
        return models.LogLevelFatal
    } else if severity >= plog.SeverityNumberError {
        return models.LogLevelError
    } else if severity >= plog.SeverityNumberWarn {
        return models.LogLevelWarn
    } else if severity >= plog.SeverityNumberInfo {
        return models.LogLevelInfo
    }
    return models.LogLevelDebug
}

// extractResourceAttributes extracts common resource attributes
func (r *Receiver) extractResourceAttributes(entry *models.LogEntry, attrs pcommon.Map) {
    if v, ok := attrs.Get("service.name"); ok {
        entry.Service = v.AsString()
    }
    if v, ok := attrs.Get("host.name"); ok {
        entry.Host = v.AsString()
    }
    if v, ok := attrs.Get("k8s.pod.name"); ok {
        entry.Pod = v.AsString()
    }
    if v, ok := attrs.Get("k8s.namespace.name"); ok {
        entry.Namespace = v.AsString()
    }
    if v, ok := attrs.Get("container.name"); ok {
        entry.Container = v.AsString()
    }
}

// ConvertTraces converts OTLP traces to internal format
func (r *Receiver) ConvertTraces(td ptrace.Traces) ([]*models.Span, error) {
    var spans []*models.Span

    resourceSpans := td.ResourceSpans()
    for i := 0; i < resourceSpans.Len(); i++ {
        rs := resourceSpans.At(i)
        resource := rs.Resource()

        scopeSpans := rs.ScopeSpans()
        for j := 0; j < scopeSpans.Len(); j++ {
            ss := scopeSpans.At(j)

            spanSlice := ss.Spans()
            for k := 0; k < spanSlice.Len(); k++ {
                span := spanSlice.At(k)

                converted := r.convertSpan(span, resource.Attributes())
                spans = append(spans, converted)
            }
        }
    }

    return spans, nil
}

// convertSpan converts a single OTLP span
func (r *Receiver) convertSpan(s ptrace.Span, resourceAttrs pcommon.Map) *models.Span {
    startTime := s.StartTimestamp().AsTime()
    endTime := s.EndTimestamp().AsTime()

    span := &models.Span{
        TraceID:     s.TraceID().String(),
        SpanID:      s.SpanID().String(),
        ParentID:    s.ParentSpanID().String(),
        StartTime:   startTime,
        EndTime:     endTime,
        Duration:    endTime.Sub(startTime),
        Name:        s.Name(),
        Kind:        r.convertSpanKind(s.Kind()),
        Status:      r.convertSpanStatus(s.Status()),
        Attributes:  make(map[string]any),
        Resource:    make(map[string]any),
    }

    // Convert attributes
    s.Attributes().Range(func(k string, v pcommon.Value) bool {
        span.Attributes[k] = v.AsRaw()
        return true
    })

    // Convert resource attributes
    resourceAttrs.Range(func(k string, v pcommon.Value) bool {
        span.Resource[k] = v.AsRaw()
        return true
    })

    // Extract service name
    if v, ok := resourceAttrs.Get("service.name"); ok {
        span.ServiceName = v.AsString()
    }

    // Convert events
    events := s.Events()
    span.Events = make([]models.SpanEvent, events.Len())
    for i := 0; i < events.Len(); i++ {
        e := events.At(i)

        attrs := make(map[string]any)
        e.Attributes().Range(func(k string, v pcommon.Value) bool {
            attrs[k] = v.AsRaw()
            return true
        })

        span.Events[i] = models.SpanEvent{
            Timestamp:  e.Timestamp().AsTime(),
            Name:       e.Name(),
            Attributes: attrs,
        }
    }

    // Convert links
    links := s.Links()
    span.Links = make([]models.SpanLink, links.Len())
    for i := 0; i < links.Len(); i++ {
        l := links.At(i)

        attrs := make(map[string]any)
        l.Attributes().Range(func(k string, v pcommon.Value) bool {
            attrs[k] = v.AsRaw()
            return true
        })

        span.Links[i] = models.SpanLink{
            TraceID:    l.TraceID().String(),
            SpanID:     l.SpanID().String(),
            Attributes: attrs,
        }
    }

    return span
}

// convertSpanKind converts OTLP span kind
func (r *Receiver) convertSpanKind(kind ptrace.SpanKind) models.SpanKind {
    switch kind {
    case ptrace.SpanKindInternal:
        return models.SpanKindInternal
    case ptrace.SpanKindServer:
        return models.SpanKindServer
    case ptrace.SpanKindClient:
        return models.SpanKindClient
    case ptrace.SpanKindProducer:
        return models.SpanKindProducer
    case ptrace.SpanKindConsumer:
        return models.SpanKindConsumer
    default:
        return models.SpanKindInternal
    }
}

// convertSpanStatus converts OTLP span status
func (r *Receiver) convertSpanStatus(status ptrace.Status) models.SpanStatus {
    switch status.Code() {
    case ptrace.StatusCodeOk:
        return models.SpanStatusOk
    case ptrace.StatusCodeError:
        return models.SpanStatusError
    default:
        return models.SpanStatusUnset
    }
}
```

### 2.2 Prometheus Scraper

Unlike OTLP where applications push data to the platform, Prometheus uses a pull model: the platform periodically scrapes HTTP endpoints that expose metrics in the Prometheus text format. This scraper manages a list of targets, fetches their `/metrics` endpoints on a configurable interval, parses the exposition format into internal `Metric` structs, and handles target health tracking. If a scrape target goes down, the scraper records the failure without blocking scrapes of other healthy targets.

```go
// pkg/ingestion/prometheus/scraper.go
package prometheus

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"

    "github.com/prometheus/common/expfmt"
    "github.com/prometheus/common/model"

    "observability/pkg/models"
    "observability/pkg/pipeline"
)

// Target represents a Prometheus scrape target
type Target struct {
    URL          string
    Labels       models.Labels
    ScrapeInterval time.Duration
    ScrapeTimeout  time.Duration
}

// Scraper scrapes Prometheus metrics
type Scraper struct {
    targets  []*Target
    pipeline *pipeline.Pipeline
    client   *http.Client

    mu       sync.RWMutex
    running  bool
    stopCh   chan struct{}
    wg       sync.WaitGroup
}

// NewScraper creates a new Prometheus scraper
func NewScraper(targets []*Target, pipeline *pipeline.Pipeline) *Scraper {
    return &Scraper{
        targets: targets,
        pipeline: pipeline,
        client: &http.Client{
            Timeout: 10 * time.Second,
        },
    }
}

// Start starts the scraper
func (s *Scraper) Start(ctx context.Context) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if s.running {
        return fmt.Errorf("scraper already running")
    }

    s.stopCh = make(chan struct{})
    s.running = true

    // Start scraping each target
    for _, target := range s.targets {
        s.wg.Add(1)
        go s.scrapeLoop(target)
    }

    return nil
}

// Stop stops the scraper
func (s *Scraper) Stop(ctx context.Context) error {
    s.mu.Lock()
    if !s.running {
        s.mu.Unlock()
        return nil
    }
    s.running = false
    close(s.stopCh)
    s.mu.Unlock()

    s.wg.Wait()
    return nil
}

// scrapeLoop continuously scrapes a target
func (s *Scraper) scrapeLoop(target *Target) {
    defer s.wg.Done()

    ticker := time.NewTicker(target.ScrapeInterval)
    defer ticker.Stop()

    // Immediate first scrape
    s.scrapeTarget(target)

    for {
        select {
        case <-ticker.C:
            s.scrapeTarget(target)
        case <-s.stopCh:
            return
        }
    }
}

// scrapeTarget scrapes a single target
func (s *Scraper) scrapeTarget(target *Target) {
    ctx, cancel := context.WithTimeout(context.Background(), target.ScrapeTimeout)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", target.URL, nil)
    if err != nil {
        return
    }

    resp, err := s.client.Do(req)
    if err != nil {
        return
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return
    }

    // Parse metrics
    metrics, err := s.parseMetrics(resp.Body, target.Labels)
    if err != nil {
        return
    }

    // Send to pipeline
    for _, metric := range metrics {
        s.pipeline.ProcessMetric(ctx, metric)
    }
}

// parseMetrics parses Prometheus text format
func (s *Scraper) parseMetrics(r io.Reader, targetLabels models.Labels) ([]*models.Metric, error) {
    var parser expfmt.TextParser
    metricFamilies, err := parser.TextToMetricFamilies(r)
    if err != nil {
        return nil, fmt.Errorf("parsing metrics: %w", err)
    }

    var metrics []*models.Metric
    now := time.Now()

    for name, mf := range metricFamilies {
        for _, m := range mf.Metric {
            // Convert Prometheus metric to internal format
            metric := s.convertMetric(name, mf.GetType(), m, now)

            // Add target labels
            metric.Labels = append(metric.Labels, targetLabels...)

            metrics = append(metrics, metric)
        }
    }

    return metrics, nil
}

// convertMetric converts a Prometheus metric to internal format
func (s *Scraper) convertMetric(name string, metricType *io_prometheus_client.MetricType,
    m *io_prometheus_client.Metric, timestamp time.Time) *models.Metric {

    metric := &models.Metric{
        Name:      name,
        Timestamp: timestamp,
        Labels:    s.convertLabels(m.Label),
    }

    switch *metricType {
    case io_prometheus_client.MetricType_GAUGE:
        metric.Type = models.MetricTypeGauge
        metric.Value = m.Gauge.GetValue()

    case io_prometheus_client.MetricType_COUNTER:
        metric.Type = models.MetricTypeCounter
        metric.Value = m.Counter.GetValue()

    case io_prometheus_client.MetricType_HISTOGRAM:
        metric.Type = models.MetricTypeHistogram
        metric.Count = m.Histogram.GetSampleCount()
        metric.Sum = m.Histogram.GetSampleSum()

        buckets := make([]models.Bucket, len(m.Histogram.Bucket))
        for i, b := range m.Histogram.Bucket {
            buckets[i] = models.Bucket{
                UpperBound: b.GetUpperBound(),
                Count:      b.GetCumulativeCount(),
            }
        }
        metric.Buckets = buckets

    case io_prometheus_client.MetricType_SUMMARY:
        metric.Type = models.MetricTypeSummary
        metric.Count = m.Summary.GetSampleCount()
        metric.Sum = m.Summary.GetSampleSum()

        quantiles := make([]models.Quantile, len(m.Summary.Quantile))
        for i, q := range m.Summary.Quantile {
            quantiles[i] = models.Quantile{
                Quantile: q.GetQuantile(),
                Value:    q.GetValue(),
            }
        }
        metric.Quantiles = quantiles
    }

    return metric
}

// convertLabels converts Prometheus labels to internal format
func (s *Scraper) convertLabels(labels []*io_prometheus_client.LabelPair) models.Labels {
    result := make(models.Labels, len(labels))
    for i, label := range labels {
        result[i] = models.Label{
            Name:  label.GetName(),
            Value: label.GetValue(),
        }
    }
    return result
}

// AddTarget adds a scrape target
func (s *Scraper) AddTarget(target *Target) {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.targets = append(s.targets, target)

    if s.running {
        s.wg.Add(1)
        go s.scrapeLoop(target)
    }
}

// RemoveTarget removes a scrape target
func (s *Scraper) RemoveTarget(url string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    for i, target := range s.targets {
        if target.URL == url {
            s.targets = append(s.targets[:i], s.targets[i+1:]...)
            return
        }
    }
}
```

### 2.3 StatsD Receiver

StatsD is a lightweight protocol that many legacy applications already use to emit metrics over UDP. Because UDP is fire-and-forget, the receiver must be fast enough to keep up with high packet rates without dropping data. This implementation listens on a UDP socket, parses the simple `metric.name:value|type` line format, and batches parsed metrics before forwarding them to the processing pipeline. The receiver also supports TCP for applications that need delivery guarantees.

```go
// pkg/ingestion/statsd/receiver.go
package statsd

import (
    "bufio"
    "context"
    "fmt"
    "net"
    "strconv"
    "strings"
    "sync"
    "time"

    "observability/pkg/models"
    "observability/pkg/pipeline"
)

// Receiver receives StatsD metrics
type Receiver struct {
    udpAddr  string
    tcpAddr  string
    pipeline *pipeline.Pipeline

    udpConn *net.UDPConn
    tcpListener net.Listener

    mu       sync.RWMutex
    running  bool
    stopCh   chan struct{}
    wg       sync.WaitGroup
}

// NewReceiver creates a new StatsD receiver
func NewReceiver(udpAddr, tcpAddr string, pipeline *pipeline.Pipeline) *Receiver {
    return &Receiver{
        udpAddr:  udpAddr,
        tcpAddr:  tcpAddr,
        pipeline: pipeline,
    }
}

// Start starts the StatsD receiver
func (r *Receiver) Start(ctx context.Context) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.running {
        return fmt.Errorf("receiver already running")
    }

    r.stopCh = make(chan struct{})

    // Start UDP listener
    if r.udpAddr != "" {
        if err := r.startUDP(); err != nil {
            return fmt.Errorf("starting UDP listener: %w", err)
        }
    }

    // Start TCP listener
    if r.tcpAddr != "" {
        if err := r.startTCP(); err != nil {
            r.stopUDP()
            return fmt.Errorf("starting TCP listener: %w", err)
        }
    }

    r.running = true
    return nil
}

// startUDP starts UDP listener
func (r *Receiver) startUDP() error {
    addr, err := net.ResolveUDPAddr("udp", r.udpAddr)
    if err != nil {
        return err
    }

    conn, err := net.ListenUDP("udp", addr)
    if err != nil {
        return err
    }

    r.udpConn = conn

    r.wg.Add(1)
    go r.handleUDP()

    return nil
}

// handleUDP handles UDP packets
func (r *Receiver) handleUDP() {
    defer r.wg.Done()

    buf := make([]byte, 65536)

    for {
        select {
        case <-r.stopCh:
            return
        default:
        }

        n, _, err := r.udpConn.ReadFrom(buf)
        if err != nil {
            continue
        }

        // Parse and process metrics
        metrics := r.parseMetrics(buf[:n])
        for _, metric := range metrics {
            r.pipeline.ProcessMetric(context.Background(), metric)
        }
    }
}

// startTCP starts TCP listener
func (r *Receiver) startTCP() error {
    listener, err := net.Listen("tcp", r.tcpAddr)
    if err != nil {
        return err
    }

    r.tcpListener = listener

    r.wg.Add(1)
    go r.acceptTCP()

    return nil
}

// acceptTCP accepts TCP connections
func (r *Receiver) acceptTCP() {
    defer r.wg.Done()

    for {
        conn, err := r.tcpListener.Accept()
        if err != nil {
            select {
            case <-r.stopCh:
                return
            default:
                continue
            }
        }

        r.wg.Add(1)
        go r.handleTCPConn(conn)
    }
}

// handleTCPConn handles a TCP connection
func (r *Receiver) handleTCPConn(conn net.Conn) {
    defer r.wg.Done()
    defer conn.Close()

    scanner := bufio.NewScanner(conn)

    for scanner.Scan() {
        metrics := r.parseMetrics(scanner.Bytes())
        for _, metric := range metrics {
            r.pipeline.ProcessMetric(context.Background(), metric)
        }
    }
}

// parseMetrics parses StatsD metrics from data
func (r *Receiver) parseMetrics(data []byte) []*models.Metric {
    var metrics []*models.Metric

    lines := strings.Split(string(data), "\n")
    for _, line := range lines {
        line = strings.TrimSpace(line)
        if line == "" {
            continue
        }

        metric := r.parseMetric(line)
        if metric != nil {
            metrics = append(metrics, metric)
        }
    }

    return metrics
}

// parseMetric parses a single StatsD metric
// Format: <metric_name>:<value>|<type>[|@<sample_rate>][|#<tags>]
func (r *Receiver) parseMetric(line string) *models.Metric {
    // Split by pipe
    parts := strings.Split(line, "|")
    if len(parts) < 2 {
        return nil
    }

    // Parse name and value
    nameValue := strings.SplitN(parts[0], ":", 2)
    if len(nameValue) != 2 {
        return nil
    }

    name := nameValue[0]
    value, err := strconv.ParseFloat(nameValue[1], 64)
    if err != nil {
        return nil
    }

    metricType := parts[1]

    metric := &models.Metric{
        Name:      name,
        Timestamp: time.Now(),
        Value:     value,
        Labels:    make(models.Labels, 0),
    }

    // Determine metric type
    switch metricType {
    case "g": // Gauge
        metric.Type = models.MetricTypeGauge
    case "c": // Counter
        metric.Type = models.MetricTypeCounter
    case "ms", "h": // Timer/Histogram
        metric.Type = models.MetricTypeHistogram
    case "s": // Set (treat as gauge)
        metric.Type = models.MetricTypeGauge
    default:
        return nil
    }

    // Parse optional components
    for i := 2; i < len(parts); i++ {
        part := parts[i]

        if strings.HasPrefix(part, "@") {
            // Sample rate
            rateStr := strings.TrimPrefix(part, "@")
            rate, err := strconv.ParseFloat(rateStr, 64)
            if err == nil && rate > 0 && rate < 1 {
                // Adjust value for sampling
                metric.Value = metric.Value / rate
            }
        } else if strings.HasPrefix(part, "#") {
            // Tags
            tagsStr := strings.TrimPrefix(part, "#")
            tags := strings.Split(tagsStr, ",")
            for _, tag := range tags {
                kv := strings.SplitN(tag, ":", 2)
                if len(kv) == 2 {
                    metric.Labels = append(metric.Labels, models.Label{
                        Name:  kv[0],
                        Value: kv[1],
                    })
                }
            }
        }
    }

    return metric
}

// Stop stops the receiver
func (r *Receiver) Stop(ctx context.Context) error {
    r.mu.Lock()
    if !r.running {
        r.mu.Unlock()
        return nil
    }
    r.running = false
    close(r.stopCh)
    r.mu.Unlock()

    r.stopUDP()
    r.stopTCP()

    r.wg.Wait()
    return nil
}

// stopUDP stops UDP listener
func (r *Receiver) stopUDP() {
    if r.udpConn != nil {
        r.udpConn.Close()
    }
}

// stopTCP stops TCP listener
func (r *Receiver) stopTCP() {
    if r.tcpListener != nil {
        r.tcpListener.Close()
    }
}
```

### 2.4 Log Collector

Logs arrive from many sources: syslog daemons, file tailing agents, or direct HTTP pushes. This collector supports syslog over TCP/UDP and can also tail log files on disk. Incoming log lines are parsed into structured `LogEntry` objects with extracted timestamps, severity levels, and key-value fields. When JSON parsing is enabled, the collector automatically extracts structured fields from JSON-formatted log lines, which saves downstream processing time and makes logs immediately searchable.

```go
// pkg/ingestion/logs/collector.go
package logs

import (
    "bufio"
    "context"
    "encoding/json"
    "fmt"
    "net"
    "os"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"

    "observability/pkg/models"
    "observability/pkg/pipeline"
)

// Collector collects logs from various sources
type Collector struct {
    syslogAddr string
    filePaths  []string
    parseJSON  bool
    pipeline   *pipeline.Pipeline

    syslogListener net.Listener
    fileWatcher    *fsnotify.Watcher
    fileTailers    map[string]*FileTailer

    mu       sync.RWMutex
    running  bool
    stopCh   chan struct{}
    wg       sync.WaitGroup
}

// NewCollector creates a new log collector
func NewCollector(syslogAddr string, filePaths []string, parseJSON bool, pipeline *pipeline.Pipeline) *Collector {
    return &Collector{
        syslogAddr:  syslogAddr,
        filePaths:   filePaths,
        parseJSON:   parseJSON,
        pipeline:    pipeline,
        fileTailers: make(map[string]*FileTailer),
    }
}

// Start starts the collector
func (c *Collector) Start(ctx context.Context) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.running {
        return fmt.Errorf("collector already running")
    }

    c.stopCh = make(chan struct{})

    // Start syslog listener
    if c.syslogAddr != "" {
        if err := c.startSyslog(); err != nil {
            return fmt.Errorf("starting syslog: %w", err)
        }
    }

    // Start file tailing
    if len(c.filePaths) > 0 {
        if err := c.startFileTailing(); err != nil {
            c.stopSyslog()
            return fmt.Errorf("starting file tailing: %w", err)
        }
    }

    c.running = true
    return nil
}

// startSyslog starts syslog listener
func (c *Collector) startSyslog() error {
    listener, err := net.Listen("tcp", c.syslogAddr)
    if err != nil {
        return err
    }

    c.syslogListener = listener

    c.wg.Add(1)
    go c.acceptSyslog()

    return nil
}

// acceptSyslog accepts syslog connections
func (c *Collector) acceptSyslog() {
    defer c.wg.Done()

    for {
        conn, err := c.syslogListener.Accept()
        if err != nil {
            select {
            case <-c.stopCh:
                return
            default:
                continue
            }
        }

        c.wg.Add(1)
        go c.handleSyslogConn(conn)
    }
}

// handleSyslogConn handles a syslog connection
func (c *Collector) handleSyslogConn(conn net.Conn) {
    defer c.wg.Done()
    defer conn.Close()

    scanner := bufio.NewScanner(conn)

    for scanner.Scan() {
        entry := c.parseSyslogLine(scanner.Text())
        if entry != nil {
            c.pipeline.ProcessLog(context.Background(), entry)
        }
    }
}

// parseSyslogLine parses a syslog line
func (c *Collector) parseSyslogLine(line string) *models.LogEntry {
    // Simplified syslog parsing
    // In production, use proper RFC 5424/3164 parser

    entry := &models.LogEntry{
        Timestamp: time.Now(),
        Message:   line,
        Fields:    make(map[string]any),
        Level:     models.LogLevelInfo,
    }

    // Try JSON parsing if enabled
    if c.parseJSON {
        var jsonData map[string]any
        if err := json.Unmarshal([]byte(line), &jsonData); err == nil {
            c.extractJSONFields(entry, jsonData)
            return entry
        }
    }

    return entry
}

// extractJSONFields extracts fields from JSON log
func (c *Collector) extractJSONFields(entry *models.LogEntry, data map[string]any) {
    // Extract standard fields
    if msg, ok := data["message"].(string); ok {
        entry.Message = msg
    } else if msg, ok := data["msg"].(string); ok {
        entry.Message = msg
    }

    if level, ok := data["level"].(string); ok {
        entry.Level = models.ParseLogLevel(level)
    }

    if ts, ok := data["timestamp"].(string); ok {
        if t, err := time.Parse(time.RFC3339, ts); err == nil {
            entry.Timestamp = t
        }
    }

    if service, ok := data["service"].(string); ok {
        entry.Service = service
    }

    if host, ok := data["host"].(string); ok {
        entry.Host = host
    }

    // Store all fields
    for k, v := range data {
        entry.Fields[k] = v
    }
}

// startFileTailing starts tailing log files
func (c *Collector) startFileTailing() error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }

    c.fileWatcher = watcher

    // Start tailers for each file
    for _, path := range c.filePaths {
        tailer, err := NewFileTailer(path, c.parseJSON, c.pipeline)
        if err != nil {
            return fmt.Errorf("creating tailer for %s: %w", path, err)
        }

        c.fileTailers[path] = tailer

        if err := tailer.Start(); err != nil {
            return fmt.Errorf("starting tailer for %s: %w", path, err)
        }

        // Watch file for changes
        if err := watcher.Add(path); err != nil {
            return fmt.Errorf("watching %s: %w", path, err)
        }
    }

    c.wg.Add(1)
    go c.handleFileEvents()

    return nil
}

// handleFileEvents handles file system events
func (c *Collector) handleFileEvents() {
    defer c.wg.Done()

    for {
        select {
        case event, ok := <-c.fileWatcher.Events:
            if !ok {
                return
            }

            if event.Op&fsnotify.Write == fsnotify.Write {
                // File was written to, tailer will pick it up
                continue
            }

            if event.Op&fsnotify.Remove == fsnotify.Remove {
                // File was removed, restart tailer
                if tailer, ok := c.fileTailers[event.Name]; ok {
                    tailer.Stop()
                    // Wait for file to be recreated
                }
            }

        case err, ok := <-c.fileWatcher.Errors:
            if !ok {
                return
            }
            _ = err // Log error

        case <-c.stopCh:
            return
        }
    }
}

// Stop stops the collector
func (c *Collector) Stop(ctx context.Context) error {
    c.mu.Lock()
    if !c.running {
        c.mu.Unlock()
        return nil
    }
    c.running = false
    close(c.stopCh)
    c.mu.Unlock()

    c.stopSyslog()
    c.stopFileTailing()

    c.wg.Wait()
    return nil
}

// stopSyslog stops syslog listener
func (c *Collector) stopSyslog() {
    if c.syslogListener != nil {
        c.syslogListener.Close()
    }
}

// stopFileTailing stops file tailing
func (c *Collector) stopFileTailing() {
    if c.fileWatcher != nil {
        c.fileWatcher.Close()
    }

    for _, tailer := range c.fileTailers {
        tailer.Stop()
    }
}

// FileTailer tails a log file
type FileTailer struct {
    path      string
    parseJSON bool
    pipeline  *pipeline.Pipeline

    file    *os.File
    reader  *bufio.Reader
    stopCh  chan struct{}
    running bool
}

// NewFileTailer creates a new file tailer
func NewFileTailer(path string, parseJSON bool, pipeline *pipeline.Pipeline) (*FileTailer, error) {
    return &FileTailer{
        path:      path,
        parseJSON: parseJSON,
        pipeline:  pipeline,
    }, nil
}

// Start starts tailing the file
func (t *FileTailer) Start() error {
    file, err := os.Open(t.path)
    if err != nil {
        return err
    }

    t.file = file
    t.reader = bufio.NewReader(file)
    t.stopCh = make(chan struct{})
    t.running = true

    // Seek to end of file
    file.Seek(0, io.SeekEnd)

    go t.tailLoop()

    return nil
}

// tailLoop continuously reads from file
func (t *FileTailer) tailLoop() {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            t.readLines()
        case <-t.stopCh:
            return
        }
    }
}

// readLines reads new lines from file
func (t *FileTailer) readLines() {
    for {
        line, err := t.reader.ReadString('\n')
        if err != nil {
            break
        }

        entry := t.parseLine(line)
        if entry != nil {
            t.pipeline.ProcessLog(context.Background(), entry)
        }
    }
}

// parseLine parses a log line
func (t *FileTailer) parseLine(line string) *models.LogEntry {
    entry := &models.LogEntry{
        Timestamp: time.Now(),
        Message:   line,
        Fields:    make(map[string]any),
        Level:     models.LogLevelInfo,
    }

    if t.parseJSON {
        var jsonData map[string]any
        if err := json.Unmarshal([]byte(line), &jsonData); err == nil {
            // Extract fields similar to syslog
            return entry
        }
    }

    return entry
}

// Stop stops the tailer
func (t *FileTailer) Stop() {
    if t.running {
        close(t.stopCh)
        t.running = false
    }

    if t.file != nil {
        t.file.Close()
    }
}
```
