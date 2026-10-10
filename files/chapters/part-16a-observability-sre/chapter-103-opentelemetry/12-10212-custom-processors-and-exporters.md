## 103.12 Custom Processors and Exporters

### Custom Span Processor

Custom span processors implement the `sdktrace.SpanProcessor` interface and are inserted into the SDK's processing chain before the exporter. There is a catch: `OnEnd` receives a `ReadOnlySpan`, so a processor cannot rewrite attributes on ended spans. The working pattern for in-process redaction is `RedactingExporter` below, which wraps the real exporter and overrides `Attributes()` on each span, applying compiled regex patterns and field-name matches to replace sensitive values with a redaction placeholder before anything leaves the process boundary.

```go
package processor

import (
    "context"
    "regexp"
    "sync"

    "go.opentelemetry.io/otel/attribute"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// SensitiveDataProcessor redacts sensitive information from spans
type SensitiveDataProcessor struct {
    patterns []*regexp.Regexp
    fields   []string
}

func NewSensitiveDataProcessor(patterns []string, fields []string) *SensitiveDataProcessor {
    compiled := make([]*regexp.Regexp, 0, len(patterns))
    for _, p := range patterns {
        if re, err := regexp.Compile(p); err == nil {
            compiled = append(compiled, re)
        }
    }

    return &SensitiveDataProcessor{
        patterns: compiled,
        fields:   fields,
    }
}

// OnStart is called when a span is started
func (p *SensitiveDataProcessor) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {
    // Can modify span attributes on start if needed
}

// OnEnd is called when a span ends
func (p *SensitiveDataProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
    // Note: ReadOnlySpan cannot be modified
    // For modification, use a custom exporter or collector processor
}

// Shutdown gracefully shuts down the processor
func (p *SensitiveDataProcessor) Shutdown(ctx context.Context) error {
    return nil
}

// ForceFlush forces pending spans to be exported
func (p *SensitiveDataProcessor) ForceFlush(ctx context.Context) error {
    return nil
}

// RedactingExporter wraps an exporter to redact sensitive data
type RedactingExporter struct {
    wrapped  sdktrace.SpanExporter
    patterns []*regexp.Regexp
    fields   map[string]bool
}

func NewRedactingExporter(wrapped sdktrace.SpanExporter, patterns []string, fields []string) *RedactingExporter {
    compiled := make([]*regexp.Regexp, 0, len(patterns))
    for _, p := range patterns {
        if re, err := regexp.Compile(p); err == nil {
            compiled = append(compiled, re)
        }
    }

    fieldSet := make(map[string]bool)
    for _, f := range fields {
        fieldSet[f] = true
    }

    return &RedactingExporter{
        wrapped:  wrapped,
        patterns: compiled,
        fields:   fieldSet,
    }
}

func (e *RedactingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
    // Create redacted copies
    redacted := make([]sdktrace.ReadOnlySpan, len(spans))
    for i, span := range spans {
        redacted[i] = e.redactSpan(span)
    }
    return e.wrapped.ExportSpans(ctx, redacted)
}

func (e *RedactingExporter) redactSpan(span sdktrace.ReadOnlySpan) sdktrace.ReadOnlySpan {
    // Create wrapper that redacts attributes
    return &redactedSpan{
        ReadOnlySpan: span,
        exporter:     e,
    }
}

func (e *RedactingExporter) Shutdown(ctx context.Context) error {
    return e.wrapped.Shutdown(ctx)
}

type redactedSpan struct {
    sdktrace.ReadOnlySpan
    exporter *RedactingExporter
}

func (s *redactedSpan) Attributes() []attribute.KeyValue {
    original := s.ReadOnlySpan.Attributes()
    redacted := make([]attribute.KeyValue, len(original))

    for i, attr := range original {
        if s.exporter.fields[string(attr.Key)] {
            redacted[i] = attribute.String(string(attr.Key), "[REDACTED]")
        } else if attr.Value.Type() == attribute.STRING {
            val := attr.Value.AsString()
            for _, pattern := range s.exporter.patterns {
                val = pattern.ReplaceAllString(val, "[REDACTED]")
            }
            redacted[i] = attribute.String(string(attr.Key), val)
        } else {
            redacted[i] = attr
        }
    }

    return redacted
}

// BatchingProcessor implements batched span processing with custom logic
type BatchingProcessor struct {
    mu          sync.Mutex
    buffer      []sdktrace.ReadOnlySpan
    batchSize   int
    flushFunc   func([]sdktrace.ReadOnlySpan) error
    stopCh      chan struct{}
}

func NewBatchingProcessor(batchSize int, flushFunc func([]sdktrace.ReadOnlySpan) error) *BatchingProcessor {
    return &BatchingProcessor{
        buffer:    make([]sdktrace.ReadOnlySpan, 0, batchSize),
        batchSize: batchSize,
        flushFunc: flushFunc,
        stopCh:    make(chan struct{}),
    }
}

func (p *BatchingProcessor) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {}

func (p *BatchingProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
    p.mu.Lock()
    defer p.mu.Unlock()

    p.buffer = append(p.buffer, s)

    if len(p.buffer) >= p.batchSize {
        p.flush()
    }
}

func (p *BatchingProcessor) flush() {
    if len(p.buffer) == 0 {
        return
    }

    batch := p.buffer
    p.buffer = make([]sdktrace.ReadOnlySpan, 0, p.batchSize)

    go func() {
        if err := p.flushFunc(batch); err != nil {
            // Handle error (log, retry, etc.)
        }
    }()
}

func (p *BatchingProcessor) Shutdown(ctx context.Context) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    close(p.stopCh)
    p.flush()
    return nil
}

func (p *BatchingProcessor) ForceFlush(ctx context.Context) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    p.flush()
    return nil
}
```

### Custom Metrics Exporter

When the built-in OTLP and Prometheus exporters do not match your backend's ingestion format, you can implement a custom `metric.Exporter` that converts OTel metric data points into your backend's wire protocol. The example below implements a custom exporter that writes metric data to a custom HTTP endpoint in JSON format.

```go
package exporter

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// WebhookExporter sends metrics to a webhook endpoint
type WebhookExporter struct {
    endpoint string
    client   *http.Client
    headers  map[string]string
}

func NewWebhookExporter(endpoint string, headers map[string]string) *WebhookExporter {
    return &WebhookExporter{
        endpoint: endpoint,
        client: &http.Client{
            Timeout: 30 * time.Second,
        },
        headers: headers,
    }
}

// Temporality returns the temporality for each instrument kind
func (e *WebhookExporter) Temporality(kind metric.InstrumentKind) metricdata.Temporality {
    switch kind {
    case metric.InstrumentKindCounter, metric.InstrumentKindHistogram:
        return metricdata.DeltaTemporality
    default:
        return metricdata.CumulativeTemporality
    }
}

// Aggregation returns the aggregation for each instrument kind
func (e *WebhookExporter) Aggregation(kind metric.InstrumentKind) metric.Aggregation {
    return metric.DefaultAggregationSelector(kind)
}

// Export sends metrics to the webhook endpoint
func (e *WebhookExporter) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
    payload := e.transformMetrics(rm)

    data, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshal metrics: %w", err)
    }

    req, err := http.NewRequestWithContext(ctx, "POST", e.endpoint, bytes.NewReader(data))
    if err != nil {
        return fmt.Errorf("create request: %w", err)
    }

    req.Header.Set("Content-Type", "application/json")
    for k, v := range e.headers {
        req.Header.Set(k, v)
    }

    resp, err := e.client.Do(req)
    if err != nil {
        return fmt.Errorf("send metrics: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        return fmt.Errorf("webhook returned status %d", resp.StatusCode)
    }

    return nil
}

func (e *WebhookExporter) transformMetrics(rm *metricdata.ResourceMetrics) map[string]any {
    metrics := make([]map[string]any, 0)

    for _, sm := range rm.ScopeMetrics {
        for _, m := range sm.Metrics {
            metric := map[string]any{
                "name":        m.Name,
                "description": m.Description,
                "unit":        m.Unit,
            }

            switch data := m.Data.(type) {
            case metricdata.Sum[int64]:
                metric["type"] = "counter"
                points := make([]map[string]any, 0)
                for _, dp := range data.DataPoints {
                    points = append(points, map[string]any{
                        "value":      dp.Value,
                        "attributes": dp.Attributes.ToSlice(),
                        "start_time": dp.StartTime,
                        "time":       dp.Time,
                    })
                }
                metric["data_points"] = points

            case metricdata.Histogram[float64]:
                metric["type"] = "histogram"
                points := make([]map[string]any, 0)
                for _, dp := range data.DataPoints {
                    points = append(points, map[string]any{
                        "count":          dp.Count,
                        "sum":            dp.Sum,
                        "min":            dp.Min,
                        "max":            dp.Max,
                        "bounds":         dp.Bounds,
                        "bucket_counts":  dp.BucketCounts,
                        "attributes":     dp.Attributes.ToSlice(),
                    })
                }
                metric["data_points"] = points
            }

            metrics = append(metrics, metric)
        }
    }

    return map[string]any{
        "resource": rm.Resource.Attributes(),
        "metrics":  metrics,
    }
}

// ForceFlush flushes any pending metrics
func (e *WebhookExporter) ForceFlush(ctx context.Context) error {
    return nil
}

// Shutdown shuts down the exporter
func (e *WebhookExporter) Shutdown(ctx context.Context) error {
    return nil
}
```

### Junior → FAANG: When and Why to Build Custom Processors

Most engineers should use the standard Collector processors (batch, memory limiter, attribute filter, probabilistic sampler) and never need to write a custom one. Custom processors and exporters are warranted in three specific cases: you need to transform telemetry data in a way no existing processor supports, you need to export to a proprietary internal backend with no existing exporter, or you are contributing a new processor to the OTel Collector contrib repository.

For a first job, focus on understanding the existing processor ecosystem before reaching for a custom implementation. The `transform` processor (using OTTL, the OpenTelemetry Transformation Language) handles most attribute manipulation without writing Go code.

Interview entry point: "What is the difference between a processor and an exporter in the OTel Collector?" A processor transforms or filters telemetry in flight. An exporter serializes and sends telemetry to a backend. Processors run in sequence in the pipeline. Exporters run at the end.

### Senior @ FAANG: Custom Processor Design, OTTL, and Collector Extension Governance

**OTTL as the preferred alternative.** Before writing a custom Go processor, evaluate whether the OpenTelemetry Transformation Language (OTTL) can achieve the same result. OTTL expressions run inside the `transform` processor and support attribute manipulation, filtering, and span renaming without compilation. For common use cases (scrubbing a specific attribute, renaming a metric, filtering spans by service name), OTTL is the correct choice because it is configuration, not code, and can be changed without recompiling the Collector binary.

**Custom exporter as a migration bridge.** When migrating from an internal proprietary telemetry system to OTel, a custom exporter that writes to the legacy backend enables incremental migration: services adopt OTel instrumentation first, while the legacy backend continues to receive data via the custom exporter. Once all services are instrumented and the legacy backend is decommissioned, the exporter is replaced with a standard OTLP exporter. This migration pattern prevents the "big bang" cutover that has high risk in production systems.

**Collector extensibility governance.** Custom processors and exporters are compiled into a custom Collector binary, which means the platform team owns the build, test, and release pipeline for that binary. An L6 engineer establishes a governance process: each custom component must have unit tests with >80% coverage, a documented configuration schema, a CHANGELOG, and a deprecation notice before removal. Without this process, the custom Collector binary becomes a maintenance burden that no team owns and nobody understands.

**Performance characteristics of custom processors.** A custom processor that performs external calls (HTTP lookups, database queries) inside `ProcessTraces()` introduces latency into the Collector pipeline. At 100,000 spans per second, even a 1ms external call creates a 100 QPS load on the external system and risks saturating the Collector's processing pipeline. Custom processors should be async where possible, using a local cache with TTL for external lookups rather than making a call per span.

---
