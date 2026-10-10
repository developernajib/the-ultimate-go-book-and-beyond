## Part 7: Production Considerations & Deployment

Building the individual components is only half the work. This part shows how to wire everything together into a single deployable application, configure it for a real environment, and package it as a Docker container. Production readiness means handling graceful shutdown so in-flight data is not lost, exposing health check endpoints for orchestrators like Kubernetes, and structuring the application so that each subsystem can be started and stopped independently.

### 7.1 Main Application

The main application is the entry point that initializes all subsystems (ingestion, processing, storage, query, alerting) and wires them together using dependency injection. It loads configuration, sets up signal handling for graceful shutdown, and starts HTTP and gRPC servers. Notice how the `run` function returns an error rather than calling `os.Exit` directly, which makes the startup logic testable. Each component is started in a goroutine, and a `sync.WaitGroup` or error group ensures all components shut down cleanly when the process receives a termination signal.

```go
// cmd/observability/main.go
package main

import (
    "context"
    "flag"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "observability/pkg/config"
    "observability/pkg/ingestion/logs"
    "observability/pkg/ingestion/otlp"
    "observability/pkg/ingestion/prometheus"
    "observability/pkg/ingestion/statsd"
    "observability/pkg/pipeline"
    "observability/pkg/storage/logs"
    "observability/pkg/storage/metrics"
    "observability/pkg/storage/traces"
    "observability/pkg/alerting"
    "observability/pkg/query"
)

func main() {
    configPath := flag.String("config", "config.yaml", "path to config file")
    flag.Parse()

    // Load configuration
    cfg, err := config.LoadConfig(*configPath)
    if err != nil {
        log.Fatalf("loading config: %v", err)
    }

    // Initialize storage
    metricStore, err := metrics.NewPrometheusStore(
        cfg.Storage.Metrics.Path,
        cfg.Storage.Metrics.RetentionTime,
    )
    if err != nil {
        log.Fatalf("creating metric store: %v", err)
    }
    defer metricStore.Close()

    logStore, err := logs.NewClickHouseStore(
        cfg.Storage.Logs.DSN,
        cfg.Storage.Logs.Database,
        cfg.Storage.Logs.Table,
    )
    if err != nil {
        log.Fatalf("creating log store: %v", err)
    }
    defer logStore.Close()

    traceStore, err := traces.NewClickHouseStore(
        cfg.Storage.Traces.DSN,
        cfg.Storage.Traces.Database,
        cfg.Storage.Traces.SpansTable,
        cfg.Storage.Traces.IndexTable,
    )
    if err != nil {
        log.Fatalf("creating trace store: %v", err)
    }
    defer traceStore.Close()

    // Initialize pipeline
    pipelineCfg := pipeline.PipelineConfig{
        Workers:       cfg.Ingestion.Workers,
        BufferSize:    cfg.Ingestion.BufferSize,
        FlushInterval: cfg.Ingestion.FlushInterval,
        MaxBatchSize:  cfg.Ingestion.MaxBatchSize,
    }

    pipe := pipeline.NewPipeline(pipelineCfg, metricStore, logStore, traceStore)

    // Add processors
    pipe.AddValidator(&pipeline.BasicValidator{})
    pipe.AddEnricher(&pipeline.LabelEnricher{
        Labels: models.Labels{
            {Name: "platform", Value: "observability"},
        },
    })

    if err := pipe.Start(context.Background()); err != nil {
        log.Fatalf("starting pipeline: %v", err)
    }
    defer pipe.Stop(context.Background())

    // Initialize ingestion receivers
    if cfg.Ingestion.OTLP.Enabled {
        otlpReceiver := otlp.NewReceiver(cfg.Ingestion.OTLP.GRPCAddr, pipe)
        if err := otlpReceiver.Start(context.Background()); err != nil {
            log.Fatalf("starting OTLP receiver: %v", err)
        }
        defer otlpReceiver.Stop(context.Background())
    }

    if cfg.Ingestion.Prometheus.Enabled {
        // Load scrape targets
        targets := []*prometheus.Target{
            // Configure from config file
        }
        promScraper := prometheus.NewScraper(targets, pipe)
        if err := promScraper.Start(context.Background()); err != nil {
            log.Fatalf("starting Prometheus scraper: %v", err)
        }
        defer promScraper.Stop(context.Background())
    }

    if cfg.Ingestion.StatsD.Enabled {
        statsdReceiver := statsd.NewReceiver(
            cfg.Ingestion.StatsD.UDPAddr,
            cfg.Ingestion.StatsD.TCPAddr,
            pipe,
        )
        if err := statsdReceiver.Start(context.Background()); err != nil {
            log.Fatalf("starting StatsD receiver: %v", err)
        }
        defer statsdReceiver.Stop(context.Background())
    }

    if cfg.Ingestion.Logs.Enabled {
        logCollector := logs.NewCollector(
            cfg.Ingestion.Logs.SyslogAddr,
            cfg.Ingestion.Logs.FilePaths,
            cfg.Ingestion.Logs.ParseJSON,
            pipe,
        )
        if err := logCollector.Start(context.Background()); err != nil {
            log.Fatalf("starting log collector: %v", err)
        }
        defer logCollector.Stop(context.Background())
    }

    // Initialize query engine
    queryEngine := query.NewEngine(
        metricStore,
        cfg.Query.MaxSamples,
        cfg.Query.QueryTimeout,
    )

    // Initialize alerting
    if cfg.Alerting.Enabled {
        alertEngine := alerting.NewEngine(queryEngine, cfg.Alerting.EvaluationInterval)

        // Add notifiers
        for _, notifierCfg := range cfg.Alerting.Notifiers {
            switch notifierCfg.Type {
            case "email":
                // Configure email notifier
            case "slack":
                // Configure Slack notifier
            case "pagerduty":
                // Configure PagerDuty notifier
            }
        }

        if err := alertEngine.LoadRules(cfg.Alerting.RulesFile); err != nil {
            log.Fatalf("loading alert rules: %v", err)
        }

        if err := alertEngine.Start(context.Background()); err != nil {
            log.Fatalf("starting alert engine: %v", err)
        }
        defer alertEngine.Stop(context.Background())
    }

    // Start HTTP server for queries and UI
    http.HandleFunc("/api/v1/query", handleQuery(queryEngine))
    http.HandleFunc("/api/v1/query_range", handleQueryRange(queryEngine))
    http.HandleFunc("/health", handleHealth)
    http.HandleFunc("/metrics", handleMetrics(pipe))

    server := &http.Server{
        Addr:         cfg.Server.HTTPAddr,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    go func() {
        log.Printf("Starting HTTP server on %s", cfg.Server.HTTPAddr)
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("HTTP server error: %v", err)
        }
    }()

    // Wait for shutdown signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
    <-sigCh

    log.Println("Shutting down gracefully...")

    // Graceful shutdown
    shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.GracefulTimeout)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
    }

    log.Println("Shutdown complete")
}

func handleQuery(engine *query.Engine) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        query := r.URL.Query().Get("query")
        if query == "" {
            http.Error(w, "query parameter required", http.StatusBadRequest)
            return
        }

        timestamp := time.Now()
        if t := r.URL.Query().Get("time"); t != "" {
            parsed, err := time.Parse(time.RFC3339, t)
            if err == nil {
                timestamp = parsed
            }
        }

        result, err := engine.Query(r.Context(), query, timestamp)
        if err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(result)
    }
}

func handleQueryRange(engine *query.Engine) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        query := r.URL.Query().Get("query")
        if query == "" {
            http.Error(w, "query parameter required", http.StatusBadRequest)
            return
        }

        start, _ := time.Parse(time.RFC3339, r.URL.Query().Get("start"))
        end, _ := time.Parse(time.RFC3339, r.URL.Query().Get("end"))
        step, _ := time.ParseDuration(r.URL.Query().Get("step"))

        if start.IsZero() || end.IsZero() || step == 0 {
            http.Error(w, "start, end, and step parameters required", http.StatusBadRequest)
            return
        }

        result, err := engine.QueryRange(r.Context(), query, start, end, step)
        if err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(result)
    }
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

func handleMetrics(pipe *pipeline.Pipeline) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        stats := pipe.Stats()

        w.Header().Set("Content-Type", "text/plain")
        fmt.Fprintf(w, "# HELP metrics_processed_total Total metrics processed\n")
        fmt.Fprintf(w, "# TYPE metrics_processed_total counter\n")
        fmt.Fprintf(w, "metrics_processed_total %d\n", stats.MetricsProcessed)

        fmt.Fprintf(w, "# HELP logs_processed_total Total logs processed\n")
        fmt.Fprintf(w, "# TYPE logs_processed_total counter\n")
        fmt.Fprintf(w, "logs_processed_total %d\n", stats.LogsProcessed)

        fmt.Fprintf(w, "# HELP traces_processed_total Total traces processed\n")
        fmt.Fprintf(w, "# TYPE traces_processed_total counter\n")
        fmt.Fprintf(w, "traces_processed_total %d\n", stats.TracesProcessed)
    }
}
```

### 7.2 Configuration Example

This YAML file shows a complete configuration for a development or staging deployment. It enables all ingestion protocols, points storage at local ClickHouse and Prometheus TSDB instances, and configures a Slack notifier for alerts. In production, you would adjust buffer sizes, retention periods, and replica counts based on your data volume. Environment-specific secrets like API tokens should be injected through environment variables rather than stored in this file.

```yaml
# config.yaml
server:
  http_addr: ":8080"
  grpc_addr: ":9090"
  metrics_addr: ":9091"
  graceful_timeout: 30s

ingestion:
  otlp:
    enabled: true
    grpc_addr: ":4317"
    http_addr: ":4318"

  prometheus:
    enabled: true
    scrape_interval: 15s
    scrape_timeout: 10s
    config_file: "prometheus.yaml"

  statsd:
    enabled: true
    udp_addr: ":8125"
    tcp_addr: ":8126"

  logs:
    enabled: true
    syslog_addr: ":514"
    file_paths:
      - "/var/log/app/*.log"
    parse_json: true

  workers: 10
  buffer_size: 10000
  flush_interval: 10s
  max_batch_size: 1000

storage:
  metrics:
    type: "prometheus"
    path: "/data/metrics"
    retention_time: 360h  # 15 days

  logs:
    type: "clickhouse"
    dsn: "tcp://localhost:9000"
    database: "observability"
    table: "logs"

  traces:
    type: "clickhouse"
    dsn: "tcp://localhost:9000"
    database: "observability"
    spans_table: "spans"
    index_table: "trace_index"

  long_term:
    enabled: true
    type: "s3"
    bucket: "observability-data"
    region: "us-east-1"

query:
  max_concurrent_queries: 20
  query_timeout: 2m
  max_samples: 50000000
  cache_enabled: true
  cache_ttl: 5m

alerting:
  enabled: true
  rules_file: "alerts.yaml"
  evaluation_interval: 30s
  notifiers:
    - type: "email"
      config:
        smtp_host: "smtp.example.com"
        smtp_port: "587"
        from: "alerts@example.com"
        to:
          - "oncall@example.com"

    - type: "slack"
      config:
        webhook_url: "https://hooks.slack.com/services/..."
        channel: "#alerts"

dashboard:
  enabled: true
  storage_type: "postgres"
  dsn: "postgres://user:pass@localhost/dashboards"

auth:
  enabled: true
  type: "jwt"
  jwt_secret: "change-me"
  token_expiry: 24h

retention:
  metrics:
    raw_data: 360h        # 15 days
    downsampled_5m: 720h  # 30 days
    downsampled_1h: 2160h # 90 days

  logs:
    raw_data: 720h        # 30 days

  traces:
    raw_data: 168h        # 7 days
```

### 7.3 Docker Deployment

Packaging the platform as a Docker container makes it portable across development machines, CI pipelines, and production clusters. The Dockerfile uses a multi-stage build: the first stage compiles the Go binary with all optimizations, and the second stage copies only the binary into a minimal base image. This keeps the final image small and reduces the attack surface. The Docker Compose file below also sets up the required dependencies (ClickHouse, NATS) so you can run the entire stack locally with a single command.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o observability ./cmd/observability

# Final image
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy binary
COPY --from=builder /build/observability .

# Copy config
COPY config.yaml .

EXPOSE 8080 9090 4317 4318 8125 514

CMD ["./observability", "-config", "config.yaml"]
```

```yaml
# docker-compose.yml
name: observability-platform

services:
  observability:
    build: .
    ports:
      - "8080:8080"   # HTTP API
      - "9090:9090"   # gRPC
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8125:8125/udp" # StatsD
      - "514:514"     # Syslog
    depends_on:
      - clickhouse
      - prometheus
    volumes:
      - ./config.yaml:/app/config.yaml
      - metrics-data:/data/metrics
    environment:
      - LOG_LEVEL=info

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    ports:
      - "9000:9000"
      - "8123:8123"
    volumes:
      - clickhouse-data:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9091:9090"
    volumes:
      - prometheus-data:/prometheus
      - ./prometheus.yaml:/etc/prometheus/prometheus.yml

volumes:
  metrics-data:
  clickhouse-data:
  prometheus-data:
```
