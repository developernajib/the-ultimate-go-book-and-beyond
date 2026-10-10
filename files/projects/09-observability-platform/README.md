# Project 09: Observability Platform

A unified observability backend that ingests metrics, logs, and traces from multiple sources, stores them efficiently, evaluates alert rules, and exposes a query API compatible with PromQL and LogQL patterns.

## Architecture Overview

```
Ingestion Sources
  ├── OTLP gRPC/HTTP  (OpenTelemetry)
  ├── Prometheus scraper
  ├── StatsD UDP/TCP
  └── Syslog / file tail

         ↓
   [Ingestion Pipeline]
   validate → enrich → batch → flush

         ↓
  ┌──────────────────────────────┐
  │  Metrics: Prometheus TSDB   │
  │  Logs:    ClickHouse        │
  │  Traces:  ClickHouse        │
  └──────────────────────────────┘

         ↓
  [Query Engine]   [Alert Engine]
  PromQL / LogQL   evaluates rules

         ↓
  HTTP API :8080
    /api/v1/query
    /api/v1/query_range
    /health
    /metrics
```

**Key packages:**
- `pkg/config` - YAML configuration loader with defaults and validation
- `pkg/models` - shared types: `Metric`, `Log`, `Trace`
- `pkg/pipeline` - concurrent ingestion pipeline: validators, enrichers, batched writers
- `pkg/ingestion/otlp` - OpenTelemetry Protocol gRPC receiver
- `pkg/ingestion/prometheus` - Prometheus target scraper
- `pkg/ingestion/statsd` - StatsD UDP/TCP receiver
- `pkg/ingestion/logs` - Syslog and file-based log collector
- `pkg/storage/metrics` - Prometheus TSDB storage adapter
- `pkg/storage/logs` - ClickHouse log store
- `pkg/storage/traces` - ClickHouse trace store
- `pkg/query` - PromQL query engine wrapper
- `pkg/query/promql` - PromQL evaluation
- `pkg/query/logql` - LogQL parser
- `pkg/alerting` - alert rule evaluation engine and notifiers
- `pkg/errors` - typed error helpers

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.27+ | Build toolchain |
| Docker | 24+ | Run ClickHouse and Prometheus |
| Docker Compose | 2.x | Local infrastructure |
| Make | any | Convenience targets |

---

## Step-by-Step Build Guide

### Step 1 - Understand the Ingestion Pipeline

**Files:** `pkg/pipeline/pipeline.go`, `pkg/pipeline/processors.go`

The `Pipeline` is the central data bus. All ingestion sources push `Metric`, `Log`, and `Trace` records into the pipeline's buffered channels. A pool of worker goroutines dequeues records, runs them through processors (validators then enrichers), and flushes batches to the storage backends.

Configuration (set in `config.yaml`):
```yaml
ingestion:
  workers: 10
  buffer_size: 10000
  flush_interval: 10s
  max_batch_size: 1000
```

`BasicValidator` rejects records with empty metric names or missing timestamps.
`LabelEnricher` adds static labels (e.g., `platform=observability`) to all incoming metrics.

**What to test:** Push 100 metrics into the pipeline. Assert `pipe.Stats().MetricsProcessed == 100` after flushing. Push a metric with an empty name and assert the validator rejects it.

### Step 2 - Understand the Storage Backends

**Files:** `pkg/storage/metrics/prometheus.go`, `pkg/storage/logs/clickhouse.go`, `pkg/storage/traces/clickhouse.go`, `pkg/storage/storage.go`

Three storage adapters implement the `storage.Store` interface:

**Metrics - Prometheus TSDB**
Opens a local TSDB directory (`storage.metrics.path`). Metrics are appended using the TSDB appender API. Queries use the TSDB querier. Retention is enforced by the TSDB engine itself (`storage.metrics.retention_time`).

**Logs - ClickHouse**
Inserts log records into a ClickHouse table with columns: `timestamp`, `level`, `message`, `labels` (Map), `trace_id`. Queries use SQL with time-range and label filters.

**Traces - ClickHouse**
Two tables: a spans table (full span data) and an index table (trace ID → time range lookup). Traces are queried by trace ID or by service name + time range.

**What to test:** Use a test TSDB directory for the metrics store. Write a metric and query it back - assert the value matches. Mock ClickHouse for log and trace store unit tests.

### Step 3 - Understand the Ingestion Receivers

**Files:**
- `pkg/ingestion/otlp/receiver.go` - gRPC server implementing the OTLP collector protocol
- `pkg/ingestion/prometheus/scraper.go` - periodically scrapes Prometheus `/metrics` endpoints
- `pkg/ingestion/statsd/receiver.go` - UDP and TCP listener for the StatsD line protocol
- `pkg/ingestion/logs/collector.go` - syslog listener and file tailer

Each receiver implements a `Start(ctx) / Stop(ctx)` interface. They all push received data into the pipeline.

**OTLP receiver** accepts metrics, traces, and logs over gRPC from any OpenTelemetry SDK instrumented application.

**Prometheus scraper** reads a list of target URLs, scrapes the exposition format, and converts to the internal `Metric` model.

**StatsD receiver** parses the `metric.name:value|type` line protocol (counters, gauges, timers, histograms).

**Log collector** tails files using `fsnotify` and listens for syslog over UDP/TCP.

**What to test:** Send a valid StatsD line to the test server. Assert the pipeline receives one metric with the correct name and value. Send an invalid line and assert it is dropped without crashing.

### Step 4 - Understand the Query Engine

**Files:** `pkg/query/query.go`, `pkg/query/promql/engine.go`, `pkg/query/logql/parser.go`

The `Engine` wraps Prometheus's PromQL engine and the TSDB storage to execute metric queries.

**Instant query** - evaluates a PromQL expression at a single timestamp:
```
GET /api/v1/query?query=up{job="my-service"}&time=2024-01-01T00:00:00Z
```

**Range query** - evaluates a PromQL expression across a time range:
```
GET /api/v1/query_range?query=rate(http_requests_total[5m])&start=...&end=...&step=1m
```

The LogQL parser (`logql/parser.go`) provides basic stream selection and filter expressions for log queries.

**What to test:** Write a metric to the TSDB store. Execute an instant query for that metric name. Assert the result contains one sample with the expected value.

### Step 5 - Understand the Alerting Engine

**Files:** `pkg/alerting/engine.go`, `pkg/alerting/notifiers.go`

The `Engine` loads alert rules from a YAML file:
```yaml
groups:
  - name: infrastructure
    rules:
      - alert: HighErrorRate
        expr: rate(http_errors_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Error rate is above 1%"
```

On each evaluation interval (default 60s), the engine executes each rule's PromQL expression. If the result is non-empty and the `for` duration has elapsed, the alert fires. Active alerts are sent to notifiers (Slack, email, PagerDuty).

**Notifiers** (`notifiers.go`) implement a `Notifier` interface with a `Notify(ctx, alert)` method. The Slack notifier posts to a webhook URL. The email notifier uses SMTP. PagerDuty uses the Events API v2.

**What to test:** Create an alert rule that always fires (`1 > 0`). Start the engine. Assert the notifier receives a call within two evaluation intervals.

### Step 6 - Understand the Log Pipeline

**File:** `pkg/ingestion/logs/collector.go`

The log collector:
1. Listens for syslog messages (RFC 3164/5424) on UDP/TCP
2. Tails log files using `fsnotify` - reads new lines as they are appended
3. Optionally parses JSON log lines to extract structured fields
4. Pushes each line as a `Log` record into the pipeline

**What to test:** Write a line to a temporary file. Assert the collector emits a `Log` record with the correct message. Write a JSON line with `{"level":"error","msg":"failed"}` and assert the parsed level is set.

### Step 7 - Understand the API Server

**File:** `cmd/observability/main.go`

The HTTP server exposes four endpoints using the standard `net/http` package:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/query` | Instant PromQL query |
| GET | `/api/v1/query_range` | Range PromQL query |
| GET | `/health` | Liveness check |
| GET | `/metrics` | Pipeline stats in Prometheus text format |

Configuration is loaded from `config.yaml` (path set with `-config` flag). All components are started before the server, and all are stopped gracefully on `SIGTERM`.

**What to test:** Run `go build ./...` with no errors. Start the server with `make run` and hit `GET /health`.

---

## Running the Project

### 1. Start infrastructure

```bash
make infra-up
```

Starts ClickHouse (port 9000/8123) and Prometheus (port 9090) via Docker Compose.

### 2. Copy and edit the config

```bash
cp configs/config.example.yaml configs/config.yaml
```

Edit `configs/config.yaml` to match your ClickHouse DSN and storage path.

### 3. Copy environment file (optional overrides)

```bash
cp .env.example .env
```

### 4. Run the platform

```bash
make run
```

### 5. Run tests

```bash
make test
```

### 6. Build binary

```bash
make build
```

### 7. Docker build

```bash
make docker-build
```

---

## API Endpoints

### Instant Query (PromQL)

```
GET /api/v1/query?query=<promql>&time=<RFC3339>
→ 200 {"resultType": "vector", "result": [...]}
```

### Range Query (PromQL)

```
GET /api/v1/query_range?query=<promql>&start=<RFC3339>&end=<RFC3339>&step=<duration>
→ 200 {"resultType": "matrix", "result": [...]}
```

### Health

```
GET /health
→ 200 OK
```

### Internal Metrics

```
GET /metrics
→ 200 Prometheus text format with pipeline counters
```

---

## Configuration File

The platform reads `configs/config.yaml` at startup (`-config` flag). Key sections:

```yaml
server:
  http_addr: ":8080"
  grpc_addr: ":9090"
  graceful_timeout: 30s

ingestion:
  workers: 10
  buffer_size: 10000
  flush_interval: 10s
  max_batch_size: 1000
  otlp:
    enabled: true
    grpc_addr: ":4317"
  statsd:
    enabled: true
    udp_addr: ":8125"
  logs:
    enabled: true
    syslog_addr: ":514"
    parse_json: true

storage:
  metrics:
    path: /data/tsdb
    retention_time: 360h   # 15 days
  logs:
    dsn: "clickhouse://localhost:9000/default"
    database: observability
    table: logs
  traces:
    dsn: "clickhouse://localhost:9000/default"
    database: observability
    spans_table: spans
    index_table: traces_index

query:
  max_samples: 50000000
  query_timeout: 2m

alerting:
  enabled: true
  rules_file: configs/alerts.yaml
  evaluation_interval: 60s
```

---

## Environment Variables

See `.env.example` for the full list with descriptions.

---

## Project Structure

```
09-observability-platform/
├── cmd/
│   └── observability/
│       └── main.go             # Server entrypoint
├── pkg/
│   ├── alerting/
│   │   ├── engine.go           # Alert rule evaluation loop
│   │   └── notifiers.go        # Slack, email, PagerDuty notifiers
│   ├── config/
│   │   └── config.go           # YAML config loader
│   ├── errors/
│   │   └── errors.go           # Typed error helpers
│   ├── ingestion/
│   │   ├── logs/collector.go   # Syslog + file tail collector
│   │   ├── otlp/receiver.go    # OpenTelemetry gRPC receiver
│   │   ├── prometheus/scraper.go # Prometheus target scraper
│   │   └── statsd/receiver.go  # StatsD UDP/TCP receiver
│   ├── models/
│   │   ├── metric.go           # Metric type
│   │   ├── log.go              # Log type
│   │   └── trace.go            # Trace/Span types
│   ├── pipeline/
│   │   ├── pipeline.go         # Worker pool + batch flusher
│   │   └── processors.go       # Validators and enrichers
│   ├── query/
│   │   ├── query.go            # Engine entry point
│   │   ├── promql/engine.go    # PromQL evaluation
│   │   └── logql/parser.go     # LogQL parser
│   └── storage/
│       ├── storage.go          # Store interface
│       ├── metrics/prometheus.go # TSDB adapter
│       ├── logs/clickhouse.go  # ClickHouse log store
│       └── traces/clickhouse.go # ClickHouse trace store
├── configs/
│   ├── config.example.yaml
│   └── alerts.yaml
├── docker-compose.yml
├── Makefile
└── .env.example
```
