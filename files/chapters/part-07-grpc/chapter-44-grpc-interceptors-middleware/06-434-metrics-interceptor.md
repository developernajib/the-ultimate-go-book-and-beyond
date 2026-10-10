## 44.4 Metrics Interceptor

### Prometheus Metrics

Prometheus metrics are registered as global variables (counters, gauges, histograms, summaries) and updated by application code. Exposing them via `promhttp.Handler()` on `/metrics` allows the Prometheus server to scrape and store time-series data.

```go
package interceptor

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ServerMetrics holds Prometheus metrics
type ServerMetrics struct {
    requestsTotal    *prometheus.CounterVec
    requestDuration  *prometheus.HistogramVec
    requestsInFlight prometheus.Gauge
    messagesSent     *prometheus.CounterVec
    messagesReceived *prometheus.CounterVec
}

func NewServerMetrics(reg prometheus.Registerer) *ServerMetrics {
    m := &ServerMetrics{
        requestsTotal: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "grpc_server_requests_total",
                Help: "Total number of gRPC requests",
            },
            []string{"method", "code"},
        ),
        requestDuration: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "grpc_server_request_duration_seconds",
                Help:    "gRPC request duration in seconds",
                Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
            },
            []string{"method"},
        ),
        requestsInFlight: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "grpc_server_requests_in_flight",
                Help: "Number of gRPC requests currently being processed",
            },
        ),
        messagesSent: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "grpc_server_messages_sent_total",
                Help: "Total number of gRPC messages sent",
            },
            []string{"method"},
        ),
        messagesReceived: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "grpc_server_messages_received_total",
                Help: "Total number of gRPC messages received",
            },
            []string{"method"},
        ),
    }
    return m
}

// UnaryServerInterceptor returns a unary interceptor with metrics
func (m *ServerMetrics) UnaryServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        m.requestsInFlight.Inc()
        defer m.requestsInFlight.Dec()

        start := time.Now()

        resp, err := handler(ctx, req)

        duration := time.Since(start).Seconds()
        code := codeFromError(err)

        m.requestsTotal.WithLabelValues(info.FullMethod, code.String()).Inc()
        m.requestDuration.WithLabelValues(info.FullMethod).Observe(duration)

        return resp, err
    }
}

// StreamServerInterceptor returns a stream interceptor with metrics
func (m *ServerMetrics) StreamServerInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        m.requestsInFlight.Inc()
        defer m.requestsInFlight.Dec()

        start := time.Now()

        wrapped := &metricsServerStream{
            ServerStream: ss,
            method:       info.FullMethod,
            sent:         m.messagesSent,
            received:     m.messagesReceived,
        }

        err := handler(srv, wrapped)

        duration := time.Since(start).Seconds()
        code := codeFromError(err)

        m.requestsTotal.WithLabelValues(info.FullMethod, code.String()).Inc()
        m.requestDuration.WithLabelValues(info.FullMethod).Observe(duration)

        return err
    }
}

type metricsServerStream struct {
    grpc.ServerStream
    method   string
    sent     *prometheus.CounterVec
    received *prometheus.CounterVec
}

func (s *metricsServerStream) SendMsg(m any) error {
    err := s.ServerStream.SendMsg(m)
    if err == nil {
        s.sent.WithLabelValues(s.method).Inc()
    }
    return err
}

func (s *metricsServerStream) RecvMsg(m any) error {
    err := s.ServerStream.RecvMsg(m)
    if err == nil {
        s.received.WithLabelValues(s.method).Inc()
    }
    return err
}

func codeFromError(err error) codes.Code {
    if err == nil {
        return codes.OK
    }
    if st, ok := status.FromError(err); ok {
        return st.Code()
    }
    return codes.Unknown
}
```

### Production shortcut: `otelgrpc` unified metrics + traces

Hand-rolled Prometheus interceptors are worth understanding because they show exactly what the framework is doing, but in production most teams in 2026 delegate this to `go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc`. It emits RED metrics (Rate, Errors, Duration) and traces in one pass using the `stats.Handler` interface, which sees events the interceptor path cannot - connection establishment, per-message byte counts, transport-level errors.

```go
import (
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
)

func newServer() *grpc.Server {
    return grpc.NewServer(
        // StatsHandler-based instrumentation: metrics + traces in one hook.
        // Prefer this over otelgrpc.UnaryServerInterceptor, which is now deprecated.
        grpc.StatsHandler(otelgrpc.NewServerHandler()),
        grpc.ChainUnaryInterceptor(
            RecoveryInterceptor(logger),
            AuthInterceptor(authConfig),
            // ...business-logic-adjacent interceptors
        ),
    )
}
```

When to roll your own (as shown above) vs use `otelgrpc`:

- **Use `otelgrpc`** for cross-service standardized RED metrics, unified trace+metric correlation via `exemplars`, and automatic semantic-convention attribute names (`rpc.service`, `rpc.method`, `rpc.grpc.status_code`).
- **Roll your own** only when you need non-standard labels (tenant ID, feature flag), a metric name your org has standardized on, or you are exporting to a Prometheus-only stack that does not yet consume OTLP metrics.

The `grpc-ecosystem/go-grpc-middleware/v2/interceptors/metrics` package offers a middle ground: structured Prometheus metrics with hooks for custom labels, without requiring the OpenTelemetry pipeline.

### Junior -> FAANG: What Metrics to Collect and Why

Junior engineers often add metrics because they were told to, without understanding what each metric answers in production. Here is the mapping for the metrics in this section.

`grpc_server_requests_total` labeled by method and status code answers: "Which methods are failing and how often?" This is the E (errors) in RED metrics. Alerting on `code != OK` rate above a threshold pages on-call when error rate spikes.

`grpc_server_request_duration_seconds` as a histogram answers: "What is the latency distribution for each method?" This is the D (duration) in RED. You need a histogram (not a gauge or summary) because histograms support aggregation across replicas. The bucket boundaries matter: the default `{0.001, 0.005, 0.01, ...}` covers sub-millisecond to 10 seconds. If your SLA is 100ms p99, make sure you have a bucket at 0.1 seconds.

`grpc_server_requests_in_flight` answers: "Is the server overloaded right now?" An in-flight gauge that trends upward without a corresponding request rate increase indicates handler goroutines are blocking, often on a downstream dependency.

For FAANG interviews, be ready to explain the difference between a Prometheus counter and a gauge. A counter only goes up (resets to zero on restart). A gauge can go up or down. Request totals and message counts are counters. In-flight requests is a gauge. Getting this wrong is a signal that a candidate has used Prometheus without understanding it.

Also understand the difference between a histogram and a summary. Summaries compute quantiles client-side and cannot be aggregated across replicas. Histograms compute quantiles server-side from bucket counts and can be aggregated. For a multi-replica service, always use histograms.

### Senior @ FAANG: Metrics Infrastructure Decisions

**The otelgrpc vs hand-rolled decision at platform level:** The section correctly presents both approaches and when to use each. At platform level, this decision should be made once in an ADR and enforced by a linter or code scanner. If you allow teams to write hand-rolled metrics interceptors, you will end up with inconsistent metric names (`grpc_requests_total` in one service, `grpc_server_calls_count` in another), inconsistent label sets, and dashboards that only work for one service. The platform should own the metric names and label schema, and emit them uniformly across all services via a shared `stats.Handler`.

**Semantic conventions and alerting:** The OpenTelemetry semantic conventions for gRPC (`rpc.system`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`) are not optional decoration. Dashboards and alerting rules written against semantic convention attribute names work across all languages and frameworks. A Go service and a Java service using the same OTel semantic conventions can share the same Grafana dashboard. Deviating from semantic conventions means every service needs its own dashboard.

**Exemplars:** Prometheus histograms support exemplars: individual data points attached to histogram observations that carry a trace ID. An exemplar on a slow bucket links the latency histogram directly to the trace for the slow request. `otelgrpc` with an OTel-aware Prometheus exporter emits exemplars automatically. This is a significant operational improvement over scanning logs for slow requests. At L6/L7, knowing that exemplars exist and how they connect metrics to traces is a differentiator.

**Cardinality management:** Every label combination in a Prometheus metric creates a separate time series. A `grpc_requests_total` counter with labels `{method, code}` creates `(number of methods) * (number of gRPC codes)` time series. For a service with 200 methods and 16 possible gRPC codes, that is 3,200 time series for one counter. This is manageable. However, if a team adds a `user_id` label (as sometimes happens with per-user metrics), the cardinality explodes to millions of time series and can take down the Prometheus server. The platform should provide a review process for new metric labels and enforce cardinality limits via recording rules or label dropping at the collector level.

---
