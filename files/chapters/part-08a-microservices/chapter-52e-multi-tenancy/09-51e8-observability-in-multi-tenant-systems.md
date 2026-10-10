## 52E.8 Observability in Multi-Tenant Systems

### Tenant ID in All Logs, Traces, and Metrics

Every log line, trace span, and metric label must include the tenant ID. Without this dimension, debugging a customer complaint means searching through undifferentiated log lines with no way to filter by customer. The middleware below injects tenant attributes into both structured logs and distributed tracing spans:

```go
// Structured logging middleware that adds tenant to every log in the request scope
func TenantLoggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        t, ok := tenant.FromContext(r.Context())
        if !ok {
            next.ServeHTTP(w, r)
            return
        }

        // Add tenant to logger in context
        logger := slog.With(
            "tenant_id", t.ID,
            "tenant_slug", t.Slug,
            "tenant_plan", t.Plan,
        )

        ctx := WithLogger(r.Context(), logger)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Distributed tracing: add tenant to every span
func TenantTracingMiddleware(tracer trace.Tracer) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            t, ok := tenant.FromContext(r.Context())
            if !ok {
                next.ServeHTTP(w, r)
                return
            }

            span := trace.SpanFromContext(r.Context())
            span.SetAttributes(
                attribute.String("tenant.id", t.ID.String()),
                attribute.String("tenant.slug", t.Slug),
                attribute.String("tenant.plan", t.Plan),
            )

            next.ServeHTTP(w, r)
        })
    }
}
```

### Per-Tenant Metrics

Prometheus metrics require careful label design in multi-tenant systems. Using `tenant_id` as a label creates unbounded cardinality that will overwhelm Prometheus at scale - 50,000 tenants multiplied across a handful of other labels (status, method, path) produces millions of time series, and a single Prometheus instance tips over long before that. The rule of thumb:

- **Metrics**: use low-cardinality labels only - `tenant_plan`, `tenant_tier`, `tenant_shard`. Not `tenant_id`.
- **Logs**: include `tenant_id` on every line. Loki, Elasticsearch, and ClickHouse-backed log stacks index it cheaply.
- **Traces**: include `tenant.id` as a span attribute. Traces are sampled, so cardinality is bounded by the sampling rate, not by tenant count.
- **Per-tenant usage / billing**: write to a columnar time-series store (ClickHouse, TimescaleDB, or a data warehouse) that is built for high-cardinality dimensions. Query it ad-hoc for support tickets. Never scrape it as Prometheus metrics.

```go
// Prometheus metrics with tenant label
var (
    httpRequestsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests",
        },
        []string{"method", "path", "status", "tenant_plan"},
        // Note: using tenant_plan, NOT tenant_id for metrics
        // Using tenant_id creates unbounded label cardinality (one per tenant)
        // Use tenant_plan or tenant_tier instead
    )

    httpRequestDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path", "tenant_plan"},
    )

    // Per-tenant resource usage (for billing/capacity planning)
    // Store in a separate time-series DB, not Prometheus
    // Prometheus with per-tenant labels explodes at scale
)

// For detailed per-tenant metrics: write to ClickHouse or TimescaleDB
type TenantMetricsWriter struct {
    writer *timeseries.MetricsWriter
}

func (w *TenantMetricsWriter) RecordRequest(ctx context.Context, duration time.Duration, statusCode int) {
    t, ok := tenant.FromContext(ctx)
    if !ok {
        return
    }

    w.writer.Write(ctx, timeseries.MetricPoint{
        Name: "api_request",
        Tags: map[string]string{
            "tenant_id": t.ID.String(),
            "plan":      t.Plan,
        },
        Fields: map[string]any{
            "duration_ms":  duration.Milliseconds(),
            "status_code":  statusCode,
            "is_error":     statusCode >= 400,
        },
        Time: time.Now(),
    })
}
```

### Noisy Neighbor Detection

A noisy neighbor is a tenant whose workload degrades performance for co-hosted tenants. The detector below queries per-tenant request rates over a five-minute window and alerts when any tenant exceeds ten times the median rate. The `PERCENTILE_CONT` window function computes the median in PostgreSQL, avoiding the need to fetch all rows into Go:

```go
// Detect tenants consuming disproportionate resources
type NoisyNeighborDetector struct {
    db      *pgxpool.Pool
    alerter Alerter
    logger  *slog.Logger
}

func (d *NoisyNeighborDetector) RunDetection(ctx context.Context) error {
    // Query: find tenants whose request rate exceeds 10x the median
    rows, err := d.db.Query(ctx, `
        WITH tenant_rates AS (
            SELECT
                tenant_id,
                count(*) AS request_count,
                avg(duration_ms) AS avg_duration_ms,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_duration_ms
            FROM api_requests
            WHERE created_at > now() - interval '5 minutes'
            GROUP BY tenant_id
        ),
        stats AS (
            SELECT
                percentile_cont(0.5) WITHIN GROUP (ORDER BY request_count) AS median_count
            FROM tenant_rates
        )
        SELECT tr.tenant_id, tr.request_count, tr.avg_duration_ms, s.median_count
        FROM tenant_rates tr, stats s
        WHERE tr.request_count > s.median_count * 10
        ORDER BY tr.request_count DESC
    `)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var tenantID uuid.UUID
        var reqCount int64
        var avgDuration float64
        var medianCount float64

        if err := rows.Scan(&tenantID, &reqCount, &avgDuration, &medianCount); err != nil {
            return err
        }

        d.logger.Warn("noisy neighbor detected",
            "tenant_id", tenantID,
            "request_count_5min", reqCount,
            "median_count", medianCount,
            "ratio", float64(reqCount)/medianCount,
        )

        d.alerter.Alert(ctx, Alert{
            Severity: "warning",
            Title:    "Noisy Neighbor",
            Detail:   fmt.Sprintf("Tenant %s has %d requests in 5 min (median: %.0f)", tenantID, reqCount, medianCount),
        })
    }

    return rows.Err()
}
```

### Per-Tenant Bulkheads

Detection is not enough - you need containment. The bulkhead pattern gives each tenant a bounded slice of shared resources so one tenant's surge cannot starve the rest. In Go, the simplest bulkhead is a per-tenant weighted semaphore that caps concurrent in-flight work:

```go
// PerTenantBulkhead limits concurrent in-flight requests per tenant.
// A tenant exceeding their concurrency budget receives 429, not 500,
// and their surge cannot exhaust the global worker pool.
type PerTenantBulkhead struct {
    mu         sync.Mutex
    semaphores map[uuid.UUID]*semaphore.Weighted
    limitsFor  func(plan string) int64
}

func (b *PerTenantBulkhead) Acquire(ctx context.Context, t *tenant.TenantContext) (func(), error) {
    b.mu.Lock()
    sem, ok := b.semaphores[t.ID]
    if !ok {
        sem = semaphore.NewWeighted(b.limitsFor(t.Plan))
        b.semaphores[t.ID] = sem
    }
    b.mu.Unlock()

    if err := sem.Acquire(ctx, 1); err != nil {
        return nil, err
    }
    return func() { sem.Release(1) }, nil
}
```

Production bulkheads combine this with:

- **Per-tenant connection pools** for heavy database operations (or reserved slots within the shared pool).
- **Per-plan `statement_timeout`** in PostgreSQL - free tier 5s, pro 30s, enterprise 120s.
- **Separate worker pools** for background jobs by priority tier, so a free-tier backfill cannot starve enterprise webhook delivery.

### Junior → FAANG: Tenant-Aware Observability as a First-Class Requirement

Observability in a multi-tenant system is not the same as observability in a single-tenant system. The most common junior mistake is implementing logging, metrics, and traces as if the tenant dimension does not exist, then discovering during an incident that it is impossible to filter to a specific customer's traffic.

Common gaps to close:

- Adding `tenant_id` as a Prometheus label. This creates unbounded cardinality. The rule is: `tenant_id` in logs and traces, `tenant_plan` or `tenant_tier` in Prometheus metrics. Know this distinction by heart before any FAANG interview that touches observability.
- Not propagating the tenant logger through the context. If each handler creates its own logger instead of using the one stored in context by `TenantLoggingMiddleware`, the tenant fields are absent from any log line produced inside the service layer or database layer.
- Treating per-tenant metrics as a monitoring concern rather than a billing concern. The `TenantMetricsWriter` writing to ClickHouse or TimescaleDB is not just for dashboards. It is the data source for usage-based billing, capacity planning, and customer-facing usage reports.

Worked example for interviews: "A customer reports intermittent slow responses. Walk me through how your observability stack helps you diagnose this."

Answer: search logs filtered by `tenant_id` for the affected tenant in the relevant time window. Look for elevated `duration_ms` values on specific endpoints. Jump to the distributed trace for a slow request using the trace ID from the log line. The trace spans show which service layer introduced the latency. If it is the database layer, check the noisy neighbor detector output for that time window to see if another tenant was running heavy queries concurrently.

First-job habits:

- On your first week in a new codebase, verify that every log line emitted from a request handler includes `tenant_id`. If it does not, add the `TenantLoggingMiddleware` and check which layers are creating their own loggers instead of reading from context.
- Write a test that makes a request and asserts that the log output contains `tenant_id`. This is a zero-cost contract that prevents future regressions.

### Senior @ FAANG: Observability Architecture for High-Cardinality Multi-Tenant Data

At staff level, observability is an architecture decision with cost, privacy, and operational implications. The patterns in this section are a starting point. The senior-level concerns are data retention, query latency, cost management, and privacy compliance.

**Choosing the right store for per-tenant telemetry:**

Different telemetry types have different query patterns and cardinality requirements:

- **Structured logs** (tenant_id, endpoint, duration, status): Loki with tenant_id as a label (if tenant count is in the thousands), or ClickHouse for large deployments. ClickHouse handles ten million unique tenant IDs with sub-second filter queries on indexed columns.
- **Distributed traces**: Jaeger or Tempo with `tenant.id` as a span attribute. Sampling rate must be calibrated per plan tier: enterprise tenants at 100% sampling (for SLA compliance), free tenants at 1% (cost control).
- **Prometheus metrics**: aggregate by plan tier, not by tenant. Use recording rules to pre-compute per-plan percentiles that feed into capacity planning.
- **Per-tenant usage metrics** (for billing): ClickHouse or a data warehouse (BigQuery, Snowflake). These are append-only write-heavy workloads with ad-hoc read queries. Prometheus is the wrong tool.

**Sampling strategy by isolation tier:**

Trace sampling in a multi-tenant system should be tenant-aware. Enterprise tenants with SLA commitments require head-based 100% sampling so every slow request is captured. Free tenants can use tail-based 1% sampling. The sampling decision should be made at the gateway, not within individual services, so the decision is consistent across all spans for a given request.

**Privacy and data residency in telemetry:**

For tenants with data residency requirements (EU GDPR, Swiss nFADP, data localization laws in India or Brazil), telemetry data that includes identifiable personal data (PII in log payloads, user IDs, email addresses) must also comply with residency constraints. The standard solution:

- Never log PII in structured log fields. Use opaque identifiers (user UUID, not email).
- If PII must appear in logs for debugging, implement log masking at the shipping layer, not at the application layer, so the application code is not burdened with masking rules.
- For regulated tenants, route their telemetry to region-local log aggregators (Loki in the EU region for EU tenants) rather than a global aggregator.

**Noisy neighbor detection at platform scale:**

The `NoisyNeighborDetector` in this section queries PostgreSQL directly. At platform scale, this query runs against an already-loaded database. The production alternative: stream per-tenant request counts to ClickHouse in real time via a background writer, and run the noisy-neighbor detection query against ClickHouse instead. ClickHouse handles millions of rows per second and returns the percentile computation in milliseconds, without adding load to the transactional database.

**Per-tenant SLA compliance monitoring:**

Enterprise tenants on paid SLAs require evidence of compliance. The observability stack must support generating monthly SLA reports: uptime percentage, p99 response time, error rate, and any incidents with root cause and duration. This requires tenant-aware alerting (an alert fires when a specific tenant's p99 exceeds the SLA threshold, not just when the global p99 exceeds it) and a structured incident record linked to the affected tenant.

---
