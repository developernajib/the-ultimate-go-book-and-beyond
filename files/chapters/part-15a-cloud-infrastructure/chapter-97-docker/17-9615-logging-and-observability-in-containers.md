## 97.17 Logging and Observability in Containers

### Structured Logging for Docker

Inside containers, logs should be written to stdout and stderr in JSON format rather than plain text. Docker captures stdout/stderr output automatically and forwards it to whatever log driver is configured. JSON-formatted logs are machine-parseable, which means log aggregation tools like Elasticsearch, Datadog, and CloudWatch can index and search individual fields (like request path, status code, or duration) without complex regex parsing. The `zap` library from Uber is a popular choice for high-performance structured logging in Go.

```go
package logging

import (
    "os"
    "time"

    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func NewLogger() (*zap.Logger, error) {
    // Determine log level from environment
    level := zap.InfoLevel
    if lvl := os.Getenv("LOG_LEVEL"); lvl != "" {
        if err := level.UnmarshalText([]byte(lvl)); err != nil {
            return nil, err
        }
    }

    // Use JSON format for containers (easy parsing by log aggregators)
    encoderConfig := zapcore.EncoderConfig{
        TimeKey:        "timestamp",
        LevelKey:       "level",
        NameKey:        "logger",
        CallerKey:      "caller",
        FunctionKey:    zapcore.OmitKey,
        MessageKey:     "message",
        StacktraceKey:  "stacktrace",
        LineEnding:     zapcore.DefaultLineEnding,
        EncodeLevel:    zapcore.LowercaseLevelEncoder,
        EncodeTime:     zapcore.ISO8601TimeEncoder,
        EncodeDuration: zapcore.MillisDurationEncoder,
        EncodeCaller:   zapcore.ShortCallerEncoder,
    }

    config := zap.Config{
        Level:            zap.NewAtomicLevelAt(level),
        Development:      os.Getenv("GO_ENV") == "development",
        Encoding:         "json",
        EncoderConfig:    encoderConfig,
        OutputPaths:      []string{"stdout"},
        ErrorOutputPaths: []string{"stderr"},
    }

    return config.Build()
}

// Example usage with request context
func LogRequest(logger *zap.Logger, method, path string, statusCode int, duration time.Duration) {
    logger.Info("http_request",
        zap.String("method", method),
        zap.String("path", path),
        zap.Int("status_code", statusCode),
        zap.Duration("duration", duration),
        zap.String("container_id", os.Getenv("HOSTNAME")),
    )
}
```

### Docker Log Drivers

Docker supports multiple log drivers that control where container logs are sent. The default `json-file` driver writes logs to local JSON files on the host, which is fine for development but can fill up disk space in production without rotation settings. You can configure `max-size` and `max-file` options to limit log file growth. For production systems, you can switch to drivers like `fluentd` or `awslogs` that ship logs directly to a centralized aggregation service.

```yaml
# docker-compose.yml with log configuration
version: '3.8'

services:
  api:
    image: myapp:latest
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
        labels: "service,version"
    labels:
      service: myapp
      version: "1.0.0"

  # Alternative: Send directly to log aggregator
  api-with-fluentd:
    image: myapp:latest
    logging:
      driver: fluentd
      options:
        fluentd-address: "localhost:24224"
        tag: "docker.{{.Name}}"
```

### Container Metrics Export

Prometheus is the industry standard for collecting metrics from containerized applications. Your Go service exposes an HTTP endpoint (typically `/metrics`) that Prometheus scrapes at regular intervals. The Prometheus client library for Go makes it easy to track request counts, latency histograms, and custom gauges like memory usage and goroutine counts. These metrics feed into dashboards (Grafana) and alerting rules that notify your team when something goes wrong.

```go
package metrics

import (
    "net/http"
    "runtime"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    requestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    requestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "Duration of HTTP requests",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )

    // Container-specific metrics
    goMemoryUsage = promauto.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "go_memory_alloc_bytes",
            Help: "Current Go memory allocation in bytes",
        },
        func() float64 {
            var m runtime.MemStats
            runtime.ReadMemStats(&m)
            return float64(m.Alloc)
        },
    )

    goGoroutines = promauto.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "go_goroutines",
            Help: "Number of active goroutines",
        },
        func() float64 {
            return float64(runtime.NumGoroutine())
        },
    )
)

func MetricsHandler() http.Handler {
    return promhttp.Handler()
}

func RecordRequest(method, path string, statusCode int, duration time.Duration) {
    requestsTotal.WithLabelValues(method, path, http.StatusText(statusCode)).Inc()
    requestDuration.WithLabelValues(method, path).Observe(duration.Seconds())
}
```

---

### Junior → FAANG: Logging That Is Actually Useful in Production

The gap between development logging and production logging is large and often not appreciated until the first on-call incident. In development, unstructured log lines are readable because you have context: you know what you just did, the logs are recent, and there is only one service running. In production, you have hundreds of containers, millions of log lines per hour, and no context. Structured JSON logs with consistent field names are not a preference. They are a requirement for operational sanity.

The concrete fields that every log line from a Go service should include: timestamp (RFC3339), log level, service name, version, request ID (for correlating logs across a request lifecycle), and the event-specific fields. The request ID should flow through the entire request lifecycle via context, so that every log line emitted during a request can be found by filtering on that single ID.

First-job habit: use `zap` or `slog` (Go 1.21+) from day one. Never use `log.Println` in a production service. The difference in debuggability during an incident is dramatic.

### Senior @ FAANG: Observability Architecture and the Cost of Cardinality

At staff level, logging and observability are engineering problems with cost implications that can grow to be significant. Log volume at scale is expensive: a service emitting 1 KB per request at 10,000 requests per second generates 864 GB of logs per day, per service. At $0.50/GB for ingestion and storage in a managed logging platform, that is $432/day for one service. Observability cost governance is a real budget concern at FAANG scale.

The architectural tools for managing observability cost are: log sampling for high-volume low-signal events (DEBUG logs should almost never be sent to the central platform in production), metric cardinality management (a Prometheus label with user ID as a value will create millions of time series and can crash a Prometheus server), and trace sampling strategies (head-based sampling misses tail latency events, tail-based sampling requires buffering all spans until the decision can be made).

The senior design pattern for metrics is to define a small set of high-value signals per service: the four golden signals (latency, traffic, errors, saturation) are the baseline. Adding additional metrics requires a justification and an owner. Unlimited metric creation leads to a metrics sprawl problem where the cardinality budget is exhausted and the system becomes unreliable.

At L6/L7, the observability investment decision requires thinking about the ROI for each signal type. Distributed tracing has high value (makes root cause analysis fast) but high cost (storage, sampling infrastructure). The staff engineer role is to design a tiered observability strategy: all services get structured logging and the golden signals metrics automatically. Services that handle user-facing traffic or process financial data get mandatory distributed tracing. All other services get tracing by opt-in. This tiered approach controls cost while ensuring that the services where observability matters most are fully instrumented.
