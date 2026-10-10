## 20.9 Company Case Studies

### Google: SRE Observability Practices

Google's Site Reliability Engineering team pioneered many observability practices that are now industry standard. Their approach centers on SLI/SLO-based alerting, error budgets, and the Four Golden Signals framework (latency, traffic, errors, saturation). The code below shows how to model these concepts in Go.

```go
// 1. SLI/SLO-Based Alerting
// Google uses Service Level Indicators (SLIs) and Service Level Objectives (SLOs)
// to determine when to alert

type SLO struct {
    Name       string
    Target     float64  // e.g., 0.999 for 99.9%
    Window     time.Duration
    Indicator  SLIFunc
}

type SLIFunc func(ctx context.Context) (float64, error)

// Availability SLI
func availabilitySLI(metrics *Metrics) SLIFunc {
    return func(ctx context.Context) (float64, error) {
        total := metrics.HTTPRequestsTotal.Value()
        errors := metrics.HTTPErrorsTotal.Value()

        if total == 0 {
            return 1.0, nil
        }
        return 1.0 - (errors / total), nil
    }
}

// Latency SLI (% of requests under threshold)
func latencySLI(metrics *Metrics, threshold time.Duration) SLIFunc {
    return func(ctx context.Context) (float64, error) {
        // Count requests under threshold / total requests
        buckets := metrics.HTTPRequestDuration.GetBuckets()
        // Calculate percentile under threshold
        return percentileUnderThreshold(buckets, threshold), nil
    }
}

// 2. Error Budget
type ErrorBudget struct {
    SLO          float64
    Window       time.Duration
    CurrentLevel float64
}

func (eb *ErrorBudget) RemainingBudget() float64 {
    allowed := 1.0 - eb.SLO        // e.g., 0.001 for 99.9% SLO
    consumed := 1.0 - eb.CurrentLevel
    return allowed - consumed
}

func (eb *ErrorBudget) BurnRate() float64 {
    // How fast are we consuming budget?
    return eb.RemainingBudget() / eb.Window.Hours()
}

// 3. Four Golden Signals
/*
Google monitors four key signals for every service:

1. Latency: Time to handle request
   - histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

2. Traffic: Demand on service
   - rate(http_requests_total[5m])

3. Errors: Rate of failed requests
   - rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])

4. Saturation: Resource utilization
   - (1 - (avg_over_time(node_cpu_seconds_total{mode="idle"}[5m])))
*/

type GoldenSignals struct {
    Latency    *prometheus.HistogramVec
    Traffic    *prometheus.CounterVec
    Errors     *prometheus.CounterVec
    Saturation prometheus.Gauge
}
```

**Google's observability principles:**

| Principle | Implementation |
|-----------|----------------|
| Alert on symptoms, not causes | Alert on high error rate, not database connection issues |
| Pages should be actionable | If you can't do anything, don't page |
| Err on the side of pages | Missing a real problem > false alarm |
| Use error budgets | Allow controlled risk-taking |

### Uber: Observability at Scale

Uber processes petabytes of telemetry data daily across thousands of microservices. They open-sourced Jaeger for distributed tracing, built M3DB to handle their metrics volume, and tightly couple log records to trace contexts so engineers can jump from a log line directly into the corresponding trace. The following examples illustrate these patterns.

```go
// 1. Jaeger Distributed Tracing (Uber open-sourced this)
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

func handleRideRequest(ctx context.Context, req *RideRequest) (*Ride, error) {
    tracer := otel.Tracer("ride-service")

    // Parent span for entire request
    ctx, span := tracer.Start(ctx, "handleRideRequest")
    defer span.End()

    span.SetAttributes(
        attribute.String("ride.user_id", req.UserID),
        attribute.Float64("ride.pickup_lat", req.PickupLat),
        attribute.Float64("ride.pickup_lng", req.PickupLng),
    )

    // Child span for driver matching
    ctx, matchSpan := tracer.Start(ctx, "findNearbyDrivers")
    drivers, err := findNearbyDrivers(ctx, req.PickupLat, req.PickupLng)
    matchSpan.SetAttributes(attribute.Int("drivers.count", len(drivers)))
    matchSpan.End()

    if err != nil {
        span.RecordError(err)
        return nil, err
    }

    // Child span for pricing
    ctx, priceSpan := tracer.Start(ctx, "calculatePrice")
    price, err := calculatePrice(ctx, req, drivers[0])
    priceSpan.SetAttributes(attribute.Int64("price.amount_cents", price.AmountCents))
    priceSpan.End()

    return &Ride{
        DriverID: drivers[0].ID,
        Price:    price,
    }, nil
}

// 2. M3DB for High-Volume Metrics
// Uber built M3DB to handle their metrics scale

type M3Metrics struct {
    cluster *m3.Cluster
}

func (m *M3Metrics) Write(metric Metric) error {
    // M3 handles:
    // - Automatic downsampling
    // - Multi-datacenter replication
    // - Cost-based storage tiering
    return m.cluster.Write(metric)
}

// 3. Log Correlation with Traces
type UberLogger struct {
    *zap.Logger
}

func (l *UberLogger) WithTrace(ctx context.Context) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return l.Logger
    }

    return l.Logger.With(
        zap.String("trace_id", span.SpanContext().TraceID().String()),
        zap.String("span_id", span.SpanContext().SpanID().String()),
    )
}

// Usage:
func processPayment(ctx context.Context, payment *Payment) error {
    logger := uberLogger.WithTrace(ctx)

    logger.Info("processing payment",
        zap.String("payment_id", payment.ID),
        zap.Int64("amount", payment.Amount),
    )
    // Now logs can be correlated with traces in Jaeger
    return nil
}
```

### Netflix: Observability for Streaming

Netflix monitors millions of concurrent streams worldwide. Their observability stack is built around Atlas (a dimensional time-series database), playback-quality metrics that track start latency and buffer ratios per device type and region, and chaos engineering experiments that compare steady-state baselines against fault injection. The patterns below show how to model these concerns.

```go
// 1. Atlas Metrics System
// Netflix's Atlas uses dimensional time series

type AtlasRegistry struct {
    client *spectator.Client
}

func (r *AtlasRegistry) Counter(name string, tags map[string]string) *Counter {
    // Atlas supports:
    // - High cardinality queries
    // - Real-time aggregation
    // - Stack language for complex queries
    return r.client.Counter(name, tags)
}

// 2. Playback Monitoring
type PlaybackMetrics struct {
    StartLatency    *prometheus.HistogramVec
    BufferRatio     *prometheus.GaugeVec
    QualityBitrate  *prometheus.GaugeVec
    ErrorRate       *prometheus.CounterVec
}

func NewPlaybackMetrics() *PlaybackMetrics {
    return &PlaybackMetrics{
        StartLatency: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "playback_start_latency_seconds",
                Help:    "Time from play button to first frame",
                Buckets: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10},
            },
            []string{"device_type", "region", "content_type"},
        ),
        BufferRatio: promauto.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "playback_buffer_ratio",
                Help: "Ratio of buffered to played content",
            },
            []string{"device_type", "region"},
        ),
    }
}

// 3. Chaos Engineering Observability
type ChaosExperiment struct {
    Name       string
    StartTime  time.Time
    EndTime    time.Time
    Hypothesis string
    Metrics    map[string]float64
}

func (c *ChaosExperiment) RecordBaseline(ctx context.Context) {
    // Record steady-state metrics before experiment
    c.Metrics["baseline_error_rate"] = getCurrentErrorRate()
    c.Metrics["baseline_latency_p99"] = getCurrentP99Latency()
}

func (c *ChaosExperiment) RecordDuring(ctx context.Context) {
    // Record metrics during chaos injection
    c.Metrics["experiment_error_rate"] = getCurrentErrorRate()
    c.Metrics["experiment_latency_p99"] = getCurrentP99Latency()
}

func (c *ChaosExperiment) Analyze() ExperimentResult {
    // Compare baseline vs experiment
    errorRateDelta := c.Metrics["experiment_error_rate"] - c.Metrics["baseline_error_rate"]
    latencyDelta := c.Metrics["experiment_latency_p99"] - c.Metrics["baseline_latency_p99"]

    return ExperimentResult{
        HypothesisConfirmed: errorRateDelta < 0.01 && latencyDelta < 100,
        ErrorRateImpact:     errorRateDelta,
        LatencyImpact:       latencyDelta,
    }
}
```

### Stripe: Financial Observability

Stripe's observability requirements go beyond operational health into financial compliance and auditability. Every mutation to payment data must be captured in a tamper-evident audit log, traces must record card-network round-trip details for dispute resolution, and reconciliation metrics must surface balance drift before it compounds. The code below demonstrates these patterns.

```go
// 1. Immutable Audit Logs
type AuditLogger struct {
    writer io.Writer
    signer *Signer
}

type AuditEntry struct {
    Timestamp   time.Time         `json:"timestamp"`
    RequestID   string            `json:"request_id"`
    UserID      string            `json:"user_id"`
    Action      string            `json:"action"`
    Resource    string            `json:"resource"`
    ResourceID  string            `json:"resource_id"`
    Changes     map[string]any    `json:"changes,omitempty"`
    IPAddress   string            `json:"ip_address"`
    UserAgent   string            `json:"user_agent"`
    Signature   string            `json:"signature"` // For tamper detection
}

func (l *AuditLogger) Log(ctx context.Context, entry AuditEntry) error {
    entry.Timestamp = time.Now().UTC()
    entry.RequestID = RequestIDFromContext(ctx)

    // Sign the entry for tamper detection
    data, _ := json.Marshal(entry)
    entry.Signature = l.signer.Sign(data)

    // Write to append-only storage
    return l.writeImmutable(entry)
}

// 2. Payment Flow Tracing
func processPayment(ctx context.Context, payment *Payment) error {
    tracer := otel.Tracer("payment-service")
    ctx, span := tracer.Start(ctx, "processPayment")
    defer span.End()

    // Critical attributes for debugging payment issues
    span.SetAttributes(
        attribute.String("payment.id", payment.ID),
        attribute.String("payment.merchant_id", payment.MerchantID),
        attribute.Int64("payment.amount", payment.Amount),
        attribute.String("payment.currency", payment.Currency),
        attribute.String("payment.card_brand", payment.CardBrand),
        attribute.String("payment.card_last4", payment.CardLast4),
    )

    // Step 1: Fraud check
    ctx, fraudSpan := tracer.Start(ctx, "fraudCheck")
    fraudResult, err := checkFraud(ctx, payment)
    fraudSpan.SetAttributes(
        attribute.String("fraud.decision", fraudResult.Decision),
        attribute.Float64("fraud.score", fraudResult.Score),
    )
    fraudSpan.End()

    if err != nil || fraudResult.Decision == "block" {
        span.SetAttributes(attribute.Bool("payment.blocked", true))
        return ErrPaymentBlocked
    }

    // Step 2: Network authorization
    ctx, authSpan := tracer.Start(ctx, "networkAuthorization")
    authResult, err := authorizeWithNetwork(ctx, payment)
    authSpan.SetAttributes(
        attribute.String("auth.network", authResult.Network),
        attribute.String("auth.response_code", authResult.ResponseCode),
        attribute.Int64("auth.latency_ms", authResult.LatencyMs),
    )
    authSpan.End()

    return nil
}

// 3. Financial Reconciliation Metrics
type ReconciliationMetrics struct {
    ProcessedTransactions prometheus.Counter
    ReconciliationErrors  *prometheus.CounterVec
    BalanceDrift         prometheus.Gauge
    ReconciliationAge    prometheus.Gauge
}

func (m *ReconciliationMetrics) RecordReconciliation(result ReconciliationResult) {
    m.ProcessedTransactions.Add(float64(result.TransactionCount))

    if result.HasErrors {
        for _, err := range result.Errors {
            m.ReconciliationErrors.WithLabelValues(err.Type).Inc()
        }
    }

    m.BalanceDrift.Set(result.BalanceDrift)
    m.ReconciliationAge.Set(time.Since(result.LastFullReconciliation).Hours())
}
```

### Staff Lens: Case Studies Show Domain-Specific Observability

Each case study shows observability tailored to the business domain. Payment services instrument reconciliation metrics. Media services instrument pipeline stages. Ride-sharing instruments match latency. Generic observability is the foundation. Domain-specific metrics are the differentiator.

The staff-level question: what metrics does your business care about specifically? Beyond RED metrics, what would a product manager want to see? Those belong on the dashboard too.

---
