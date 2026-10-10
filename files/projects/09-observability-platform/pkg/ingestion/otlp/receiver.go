// pkg/ingestion/otlp/receiver.go
package otlp

import (
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"google.golang.org/grpc"

	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/pipeline"
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
