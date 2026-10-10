## 104.2 Go Prometheus Client

### Basic Instrumentation

Instrumenting a Go HTTP service starts with the four metric types applied to the request path: a counter for request totals, a histogram for latency, a gauge for in-flight requests, and a summary for response sizes. The `promauto` package registers each metric with the default registry at declaration time, and a single middleware wraps every handler to record observations.

```go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    // Counter
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    // Histogram
    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"method", "path"},
    )

    // Gauge
    httpActiveRequests = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "http_active_requests",
            Help: "Number of active HTTP requests",
        },
        []string{"method"},
    )

    // Summary (with quantiles)
    httpResponseSize = promauto.NewSummaryVec(
        prometheus.SummaryOpts{
            Name:       "http_response_size_bytes",
            Help:       "HTTP response size in bytes",
            Objectives: map[float64]float64{0.5: 0.05, 0.9: 0.01, 0.99: 0.001},
        },
        []string{"method", "path"},
    )
)

// MetricsMiddleware records HTTP metrics
func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Track active requests
        httpActiveRequests.WithLabelValues(r.Method).Inc()
        defer httpActiveRequests.WithLabelValues(r.Method).Dec()

        // Wrap response writer
        rw := &responseWriter{ResponseWriter: w, statusCode: 200}

        next.ServeHTTP(rw, r)

        // Record metrics. In production, label with the route template
        // (e.g. /users/{id}), not the raw path, to bound cardinality.
        duration := time.Since(start).Seconds()
        status := strconv.Itoa(rw.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, status).Inc()
        httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
        httpResponseSize.WithLabelValues(r.Method, r.URL.Path).Observe(float64(rw.bytesWritten))
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += n
    return n, err
}

// Handler returns the Prometheus metrics handler
func Handler() http.Handler {
    return promhttp.Handler()
}
```

### Business Metrics

Beyond infrastructure metrics, Prometheus excels at tracking business-level signals: orders placed, payments processed, users registered, and search queries executed. The example below defines a set of business metrics using counters for totals, histograms for monetary value distributions, and gauges for current state like active users.

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Order metrics
    ordersCreated = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "orders_created_total",
            Help: "Total number of orders created",
        },
        []string{"payment_method", "region"},
    )

    orderValue = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_value_cents",
            Help:    "Order value in cents",
            Buckets: []float64{1000, 2500, 5000, 10000, 25000, 50000, 100000, 500000},
        },
        []string{"payment_method"},
    )

    orderProcessingTime = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_processing_duration_seconds",
            Help:    "Time to process an order",
            Buckets: prometheus.DefBuckets,
        },
        []string{"status"},
    )

    // Inventory metrics
    inventoryLevel = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "inventory_level",
            Help: "Current inventory level by product",
        },
        []string{"product_id", "warehouse"},
    )

    // User metrics
    activeUsers = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "active_users",
            Help: "Number of active users in the last 15 minutes",
        },
    )

    userRegistrations = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "user_registrations_total",
            Help: "Total number of user registrations",
        },
    )
)

// Order carries the fields the metrics need
type Order struct {
    PaymentMethod string
    Region        string
    TotalCents    int64
}

// OrderService with metrics
type OrderService struct{}

func (s *OrderService) CreateOrder(order Order) error {
    timer := prometheus.NewTimer(orderProcessingTime.WithLabelValues("pending"))

    // Process order...

    timer.ObserveDuration()

    ordersCreated.WithLabelValues(order.PaymentMethod, order.Region).Inc()
    orderValue.WithLabelValues(order.PaymentMethod).Observe(float64(order.TotalCents))

    return nil
}

func (s *OrderService) UpdateInventory(productID, warehouse string, level int) {
    inventoryLevel.WithLabelValues(productID, warehouse).Set(float64(level))
}
```

### Junior → FAANG: Go Prometheus Client Patterns and Common Mistakes

The `prometheus/client_golang` library has several patterns that junior engineers get wrong on first use:

**Global registration vs. custom registries.** `prometheus.MustRegister()` registers to the default global registry, which is convenient but makes testing hard (tests that register the same metric twice panic). A better pattern is to create a custom registry per service and pass it through dependency injection. This makes testing possible and enables registering different metrics in different test scenarios.

**Label cardinality discipline.** Every unique combination of label values creates a new time series. A `WithLabelValues(userID)` call where `userID` has 10 million possible values creates up to 10 million time series for that one metric. This is the most common way engineers accidentally kill a Prometheus server. Rule of thumb: only use labels with bounded, low-cardinality value sets (HTTP method, status code range, region, service name).

**Observe vs. Set vs. Add.** `Histogram.Observe(v)` records a single observation. `Gauge.Set(v)` sets the current value. `Counter.Add(n)` increments by n. Using `Gauge.Set` on something that should be a counter (resetting it each request) loses rate information and produces misleading graphs.

### Senior @ FAANG: Client Library Architecture, Custom Registries, and Test Isolation

**Custom registries as a testability requirement.** At scale, metric registration happens in library code used by many services. If library code registers to the global registry at import time, tests that import the library from different packages cause "duplicate metric registration" panics. The standard pattern is to return a `Registerer` interface from the library and let the caller (the service's `main.go`) register to their chosen registry. The platform team enforces this pattern in code review for all shared libraries.

**Metric initialization at startup.** An uninitialized counter (one that has never been incremented) does not appear in the Prometheus scrape output. This means a service that has never processed an error shows no `errors_total` metric, and alerting rules that use `absent()` to detect missing metrics cannot distinguish between "no errors" and "service is down." The fix is to call `With(labels).Add(0)` for all expected label combinations at service startup, ensuring the metric exists even before the first observation.

**`MustRegister` vs. `Register` in production code.** `MustRegister` panics if registration fails (e.g., due to a naming conflict). In `main.go`, this is acceptable: a panic at startup surfaces the bug immediately. In library code called during normal request processing, a panic is a production outage. Use `Register` and handle the error explicitly in library code. The platform team's code review checklist flags any `MustRegister` call outside of initialization code.

---
