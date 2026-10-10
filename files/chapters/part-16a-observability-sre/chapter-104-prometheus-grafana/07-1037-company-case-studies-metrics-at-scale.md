## 104.7 Company Case Studies: Metrics at Scale

### Google: Borgmon-Inspired Monitoring

Google's internal monitoring system Borgmon inspired Prometheus, and its ex-Google authors carried patterns like these into the ecosystem:

```go
// Google-style metrics with strict naming conventions
package metrics

import (
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Naming convention: {component}_{metric}_{unit}_total
    rpcServerRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "grpc_server_handled_total",
            Help: "Total number of RPCs completed on the server",
        },
        []string{"grpc_service", "grpc_method", "grpc_code"},
    )

    rpcServerLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "grpc_server_handling_seconds",
            Help:    "Histogram of RPC handling time",
            // Typical latency buckets for RPC workloads
            Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
        },
        []string{"grpc_service", "grpc_method"},
    )

    // SLI metrics following Google SRE book patterns.
    // Note: colons in metric names are reserved for recording rules,
    // instrumented metrics use underscores only.
    sliRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "sli_requests_total",
            Help: "SLI: Total requests for availability calculation",
        },
        []string{"service", "slo"},
    )

    sliBadRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "sli_bad_requests_total",
            Help: "SLI: Bad requests (errors) for availability calculation",
        },
        []string{"service", "slo"},
    )

    // Golden-signal instruments used by the middleware below
    inFlightGauge = promauto.NewGaugeVec(
        prometheus.GaugeOpts{Name: "http_in_flight_requests", Help: "In-flight HTTP requests"},
        []string{"path"},
    )
    latencyHistogram = promauto.NewHistogramVec(
        prometheus.HistogramOpts{Name: "http_request_duration_seconds", Help: "Request latency", Buckets: prometheus.DefBuckets},
        []string{"path"},
    )
    requestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{Name: "http_requests_total", Help: "Total HTTP requests"},
        []string{"method", "path"},
    )
    errorsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{Name: "http_errors_total", Help: "Total HTTP 5xx responses"},
        []string{"path"},
    )
)

type responseRecorder struct {
    http.ResponseWriter
    status int
}

func (r *responseRecorder) WriteHeader(code int) {
    r.status = code
    r.ResponseWriter.WriteHeader(code)
}

// Google's four golden signals middleware
func GoldenSignalsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Saturation: track in-flight requests
        inFlightGauge.WithLabelValues(r.URL.Path).Inc()
        defer inFlightGauge.WithLabelValues(r.URL.Path).Dec()

        rw := &responseRecorder{ResponseWriter: w, status: 200}
        next.ServeHTTP(rw, r)

        duration := time.Since(start)

        // Latency
        latencyHistogram.WithLabelValues(r.URL.Path).Observe(duration.Seconds())

        // Traffic
        requestsTotal.WithLabelValues(r.Method, r.URL.Path).Inc()

        // Errors
        if rw.status >= 500 {
            errorsTotal.WithLabelValues(r.URL.Path).Inc()
        }
    })
}
```

### Uber: High-Cardinality Metrics

Uber handles metrics for millions of trips with careful cardinality management:

```go
// Uber-style metrics with cardinality controls
package metrics

import (
    "strings"
    "sync"

    "github.com/prometheus/client_golang/prometheus"
)

// CardinalityLimitedCounter limits unique label combinations
type CardinalityLimitedCounter struct {
    counter   *prometheus.CounterVec
    maxLabels int
    seen      map[string]struct{}
    mu        sync.RWMutex
}

func NewCardinalityLimitedCounter(opts prometheus.CounterOpts, labelNames []string, maxLabels int) *CardinalityLimitedCounter {
    return &CardinalityLimitedCounter{
        counter:   prometheus.NewCounterVec(opts, labelNames),
        maxLabels: maxLabels,
        seen:      make(map[string]struct{}),
    }
}

func (c *CardinalityLimitedCounter) WithLabelValues(lvs ...string) prometheus.Counter {
    key := strings.Join(lvs, "|")

    c.mu.RLock()
    _, exists := c.seen[key]
    c.mu.RUnlock()

    if exists {
        return c.counter.WithLabelValues(lvs...)
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    if len(c.seen) >= c.maxLabels {
        // Return "other" bucket to prevent explosion
        return c.counter.WithLabelValues(append(lvs[:len(lvs)-1], "other")...)
    }

    c.seen[key] = struct{}{}
    return c.counter.WithLabelValues(lvs...)
}

// Uber's city-aware metrics
var (
    tripMetrics = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "uber_trip_duration_seconds",
            Help:    "Trip duration by city and type",
            Buckets: []float64{60, 120, 300, 600, 1200, 1800, 3600},
        },
        []string{"city", "product_type"}, // Controlled cardinality
    )

    // Aggregate by region, not individual driver
    driverActivity = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "uber_active_drivers",
            Help: "Number of active drivers by region",
        },
        []string{"region", "product_type"},
    )
)
```

### Netflix: Spectator Metrics

Netflix instruments services with its Spectator library, which reports to Atlas, Netflix's in-house time-series backend. The sketch below adapts Spectator's dimensional model to Prometheus types:

```go
// Netflix Spectator-style dimensional metrics
package metrics

import (
    "os"

    "github.com/prometheus/client_golang/prometheus"
)

// Counter, Timer, and Gauge wrapper types
type Counter struct{}
type Timer struct{}
type Gauge struct{}

type Registry struct {
    counters   map[string]*Counter
    timers     map[string]*Timer
    gauges     map[string]*Gauge
    commonTags map[string]string
}

func NewRegistry() *Registry {
    return &Registry{
        counters:   make(map[string]*Counter),
        timers:     make(map[string]*Timer),
        gauges:     make(map[string]*Gauge),
        commonTags: map[string]string{
            "nf.app":     os.Getenv("NETFLIX_APP"),
            "nf.cluster": os.Getenv("NETFLIX_CLUSTER"),
            "nf.asg":     os.Getenv("NETFLIX_ASG"),
            "nf.stack":   os.Getenv("NETFLIX_STACK"),
            "nf.region":  os.Getenv("AWS_REGION"),
        },
    }
}

// Netflix-style percentile timer
type PercentileTimer struct {
    histogram *prometheus.HistogramVec
    name      string
}

func (r *Registry) mergeTags(tags map[string]string) map[string]string {
    merged := make(map[string]string, len(r.commonTags)+len(tags))
    for k, v := range r.commonTags {
        merged[k] = v
    }
    for k, v := range tags {
        merged[k] = v
    }
    return merged
}

func (r *Registry) PercentileTimer(name string, tags map[string]string) *PercentileTimer {
    allTags := r.mergeTags(tags)
    labelNames := make([]string, 0, len(allTags))
    for k := range allTags {
        labelNames = append(labelNames, k)
    }

    histogram := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    name,
            Help:    name + " latency distribution",
            // Millisecond-granularity buckets (Spectator convention,
            // Prometheus convention would use seconds)
            Buckets: []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000},
        },
        labelNames,
    )

    return &PercentileTimer{histogram: histogram, name: name}
}

// Chaos Monkey integration
var chaosMonkeyEvents = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "netflix_chaos_monkey_events_total",
        Help: "Chaos Monkey termination events",
    },
    []string{"app", "asg", "reason"},
)
```

### Stripe: Financial Metrics Precision

Stripe's metrics for payment processing require high precision:

```go
// Stripe-style financial metrics
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Payment metrics with high precision
    paymentAmountTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "stripe_payment_amount_cents_total",
            Help: "Total payment amount in cents (use cents to avoid floating point issues)",
        },
        []string{"currency", "status", "payment_method"},
    )

    paymentLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "stripe_payment_processing_seconds",
            Help: "Payment processing time",
            // Fine-grained buckets for payment latency SLOs
            Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5},
        },
        []string{"payment_method", "region"},
    )

    // Idempotency metrics for debugging
    idempotencyHits = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "stripe_idempotency_hits_total",
            Help: "Idempotent request replay hits",
        },
        []string{"endpoint"},
    )

    // Fraud detection metrics
    fraudScore = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "stripe_fraud_score",
            Help:    "ML fraud detection score distribution",
            Buckets: []float64{0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99},
        },
        []string{"outcome"},
    )
)

// PCI-compliant: never include card numbers in metrics
func RecordPayment(currency string, amountCents int64, method, status string) {
    paymentAmountTotal.WithLabelValues(currency, status, method).Add(float64(amountCents))
}
```

### Amazon: CloudWatch with Prometheus

Amazon's approach to Prometheus in AWS:

```go
// AWS CloudWatch + Prometheus hybrid approach
package metrics

import (
    "context"
    "errors"
    "log"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
    "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
    "github.com/prometheus/client_golang/prometheus"
)

// DualExporter sends metrics to both Prometheus and CloudWatch
type DualExporter struct {
    cwClient  *cloudwatch.Client
    namespace string
    registry  *prometheus.Registry
}

func (e *DualExporter) RecordMetric(name string, value float64, dimensions map[string]string) {
    // Prometheus
    labels := prometheus.Labels{}
    cwDims := make([]types.Dimension, 0)

    for k, v := range dimensions {
        labels[k] = v
        cwDims = append(cwDims, types.Dimension{
            Name:  aws.String(k),
            Value: aws.String(v),
        })
    }

    gauge := prometheus.NewGauge(prometheus.GaugeOpts{
        Name:        name,
        ConstLabels: labels,
    })
    // Register once, reuse the existing collector on subsequent calls
    if err := e.registry.Register(gauge); err != nil {
        var are prometheus.AlreadyRegisteredError
        if errors.As(err, &are) {
            gauge = are.ExistingCollector.(prometheus.Gauge)
        } else {
            log.Printf("register %s: %v", name, err)
            return
        }
    }
    gauge.Set(value)

    // CloudWatch (for AWS alarms and dashboards)
    if _, err := e.cwClient.PutMetricData(context.Background(), &cloudwatch.PutMetricDataInput{
        Namespace: aws.String(e.namespace),
        MetricData: []types.MetricDatum{
            {
                MetricName: aws.String(name),
                Value:      aws.Float64(value),
                Dimensions: cwDims,
            },
        },
    }); err != nil {
        log.Printf("cloudwatch put %s: %v", name, err)
    }
}
```

**Metrics Patterns by Company**:

| Company | Metrics System | Key Pattern |
|---------|---------------|-------------|
| Google | Prometheus/Monarch | Four golden signals, SLI metrics |
| Uber | M3/Prometheus | Cardinality limiting, city dimensions |
| Netflix | Spectator/Atlas | Dimensional metrics, common tags |
| Stripe | Prometheus | Cents not dollars, idempotency tracking |
| Amazon | CloudWatch+Prometheus | Dual export, AWS alarm integration |

### Junior → FAANG: What These Case Studies Teach About Metric Strategy

The common thread across all five companies is that metrics strategy evolves from "collect everything" to "collect the right things with discipline." Every company that runs at scale has had a cardinality incident: an innocent-looking new label caused a time series explosion that overloaded Prometheus and degraded monitoring for the entire organization.

Uber's city dimension is the canonical teaching example: adding a city label to a metric with 200 cities multiplies every existing time series by 200. The fix is to think carefully before adding any label and to have a review process for new metric label sets.

Stripe's "cents not dollars" principle generalizes: use the smallest integer unit for financial values to avoid floating-point precision loss. For latency, use seconds (float) because the Prometheus convention is base units: `histogram_quantile()` returns values in whatever unit the buckets use, and mixing seconds and milliseconds across metrics introduces query mistakes.

### Senior @ FAANG: Benchmarking Metric System Choices and Migration Paths

**Prometheus vs. proprietary systems.** Google's Monarch and Netflix's Atlas are purpose-built metric systems that outperform Prometheus at extreme scale (billions of time series). However, they require significant operational investment and are not open-source. For most companies, Prometheus with Thanos or Mimir reaches the required scale without the complexity. An L6 engineer evaluates this trade-off using a concrete capacity model: current time series count, expected growth rate, storage cost at both options, and operational team size. The decision is documented in an ADR.

**Migration from a legacy metric system.** When migrating from StatsD, Graphite, or a proprietary agent to Prometheus, the dual-export phase (emitting to both systems simultaneously) is the most operationally risky period. Metric naming conventions differ (StatsD uses dots, Prometheus uses underscores), aggregation semantics differ (StatsD aggregates client-side, Prometheus server-side), and cardinality models differ fundamentally. An L6 engineer designs the migration with three phases: parallel emission to both systems, validation that Prometheus queries produce the same operational insights as legacy queries, and deprecation of the legacy system. Each phase has explicit completion criteria and a rollback plan.

---
