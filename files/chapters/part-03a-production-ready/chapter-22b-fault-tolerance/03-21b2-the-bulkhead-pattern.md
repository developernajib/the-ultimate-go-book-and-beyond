## 22B.2 The Bulkhead Pattern

### The Ship Compartment Analogy

In naval architecture, a bulkhead is a vertical wall that divides a ship's hull into separate watertight compartments. If a torpedo strikes the ship and floods one compartment, the bulkhead prevents water from flowing into adjacent compartments. The ship may list to one side, but it stays afloat. Without bulkheads, any hull breach sinks the ship.

Michael Nygard introduced this pattern into software architecture in "Release It!" and the analogy maps precisely to distributed systems. Consider a service that depends on three external systems: a database, a Redis cache, and a third-party payment API. In a system without bulkheads, a single shared connection pool services all three. If the payment API becomes slow, returning 10-second response times instead of 100ms, requests pile up waiting for payment API connections. Those blocked goroutines consume memory. Soon the shared pool is exhausted. Database calls fail. Cache calls fail. The entire service becomes unresponsive, even for requests that never needed the payment API.

With bulkheads, each upstream dependency has its own dedicated resource pool with an independent limit. When the payment API slows down, its bulkhead fills up and new payment requests are rejected immediately with a 503. The database pool and cache pool are completely unaffected. Checkout still fails, but search works. Navigation works. Most of the site remains functional.

```
WITHOUT BULKHEAD:
                           ┌─────────────────────────────────┐
  All Requests ───────────►│     Shared Goroutine Pool       │ 
                           │   [DB][DB][Pay][Pay][Pay][Pay]  │ ◄── Pool fills with slow
                           │   [Pay][Pay][Pay][Pay][Pay]...  │     payment calls
                           └──────────┬──────────────────────┘
                                      │ Pool exhausted
                            ┌─────────▼──────────┐
                            │  DB calls fail too  │ ◄── Cascade
                            └────────────────────┘

WITH BULKHEAD:
                           ┌───────────────────┐
  DB Requests    ─────────►│  DB Bulkhead (20) │──► DB works fine
                           └───────────────────┘

                           ┌───────────────────┐
  Cache Requests ─────────►│Cache Bulkhead (50)│──► Cache works fine
                           └───────────────────┘

                           ┌───────────────────┐
  Pay Requests   ─────────►│ Pay Bulkhead (10) │──► Pay rejects fast (503)
                           └───────────────────┘    Pool full, isolated
```

### Two Isolation Strategies

**Semaphore-based bulkhead** uses a counting semaphore to limit the number of concurrent in-flight calls to a dependency. When the limit is reached, new requests are immediately rejected (or optionally queued). The goroutines are not dedicated, they come from the general request-handling pool. This is lightweight and the right choice for most use cases.

**Goroutine pool-based bulkhead** maintains a dedicated pool of goroutines per dependency. Work is submitted to the pool via a channel. This provides stronger isolation: even if the general goroutine pool is under pressure, the dedicated pool has reserved capacity. This is heavier, appropriate for critical dependencies with strict isolation requirements.

For most Go services, the semaphore approach is correct. Go goroutines are cheap (2KB starting stack, grown on demand), so the goroutine pool approach does not provide the same benefit it would in a thread-per-request language like Java.

### Production Go Implementation

The following implementation combines a buffered channel used as a counting semaphore with an optional queue channel and full Prometheus instrumentation. Acquiring a slot means receiving from the semaphore channel. Releasing it means sending back, so the channel's buffer length always reflects available capacity. A separate queue channel allows a configurable number of requests to wait for a slot rather than being rejected immediately, bounded by a timeout to prevent indefinite blocking. Rejection tracking via atomic counters feeds the `RejectionRate` method, which reports the fraction of calls shed for lack of capacity. Read its doc comment before you wire it to anything: it counts capacity rejections only, and it is a lifetime rate rather than a windowed one, which makes the Prometheus `rate()` the better signal for alerting.

```go
package bulkhead

import (
    "context"
    "errors"
    "fmt"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// ErrBulkheadFull is returned when the bulkhead capacity is exhausted.
var ErrBulkheadFull = errors.New("bulkhead: capacity exhausted, request rejected")

// BulkheadConfig holds the configuration for a named bulkhead.
type BulkheadConfig struct {
    // Name identifies this bulkhead in metrics and logs.
    Name string

    // MaxConcurrent is the maximum number of concurrent in-flight calls.
    // Formula: MaxConcurrent = TargetRPS × P99LatencySeconds × SafetyFactor
    MaxConcurrent int

    // MaxQueueDepth is how many requests may wait when at MaxConcurrent.
    // Set to 0 for no queuing (immediate rejection when full).
    MaxQueueDepth int

    // QueueTimeout is the max time a request will wait in the queue.
    QueueTimeout time.Duration
}

// Metrics holds all Prometheus instruments for a bulkhead.
type Metrics struct {
    requestsTotal    *prometheus.CounterVec
    rejectionsTotal  prometheus.Counter
    inFlight         prometheus.Gauge
    queueDepth       prometheus.Gauge
    maxConcurrent    prometheus.Gauge
    latencyHistogram *prometheus.HistogramVec
}

func newMetrics(name string, reg prometheus.Registerer) *Metrics {
    if reg == nil {
        reg = prometheus.DefaultRegisterer
    }
    factory := promauto.With(reg)
    return &Metrics{
        requestsTotal: factory.NewCounterVec(prometheus.CounterOpts{
            Name:        "bulkhead_requests_total",
            Help:        "Total requests handled by the bulkhead.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }, []string{"result"}), // result: success, error, rejected, canceled

        rejectionsTotal: factory.NewCounter(prometheus.CounterOpts{
            Name:        "bulkhead_rejections_total",
            Help:        "Total requests rejected due to capacity exhaustion.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),

        inFlight: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "bulkhead_in_flight",
            Help:        "Current number of in-flight calls.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),

        queueDepth: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "bulkhead_queue_depth",
            Help:        "Current number of requests waiting in the queue.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),

        // Exported so alerts can express in_flight as a fraction of capacity.
        // A gauge cannot be inferred from the semaphore channel, so the
        // configured limit has to be published explicitly.
        maxConcurrent: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "bulkhead_max_concurrent",
            Help:        "Configured concurrency limit for this bulkhead.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),

        latencyHistogram: factory.NewHistogramVec(prometheus.HistogramOpts{
            Name:        "bulkhead_call_duration_seconds",
            Help:        "Latency of calls passing through the bulkhead.",
            ConstLabels: prometheus.Labels{"bulkhead": name},
            Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
        }, []string{"result"}),
    }
}

// BulkheadWithMetrics is a production-grade semaphore bulkhead with
// full Prometheus instrumentation.
type BulkheadWithMetrics struct {
    config    BulkheadConfig
    semaphore chan struct{}
    queue     chan struct{}
    metrics   *Metrics

    // rejectionCount is used for admission control (circuit break on high rejection rate).
    totalCalls      atomic.Int64
    totalRejections atomic.Int64
}

// NewBulkhead creates a new instrumented bulkhead.
func NewBulkhead(cfg BulkheadConfig, reg prometheus.Registerer) (*BulkheadWithMetrics, error) {
    if cfg.MaxConcurrent <= 0 {
        return nil, fmt.Errorf("bulkhead: MaxConcurrent must be > 0, got %d", cfg.MaxConcurrent)
    }
    if cfg.Name == "" {
        return nil, fmt.Errorf("bulkhead: Name must not be empty")
    }

    b := &BulkheadWithMetrics{
        config:    cfg,
        semaphore: make(chan struct{}, cfg.MaxConcurrent),
        metrics:   newMetrics(cfg.Name, reg),
    }

    b.metrics.maxConcurrent.Set(float64(cfg.MaxConcurrent))

    if cfg.MaxQueueDepth > 0 {
        b.queue = make(chan struct{}, cfg.MaxQueueDepth)
    }

    // Pre-fill the semaphore. A receive acquires a slot, a send releases it.
    for i := 0; i < cfg.MaxConcurrent; i++ {
        b.semaphore <- struct{}{}
    }

    return b, nil
}

// Execute runs fn within the bulkhead. It returns ErrBulkheadFull if
// capacity is exhausted and no queue slot is available.
func (b *BulkheadWithMetrics) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
    b.totalCalls.Add(1)

    // Fast path: try to acquire immediately.
    select {
    case <-b.semaphore:
        // Slot acquired.
    default:
        // No slot available. Try queuing.
        if b.queue == nil {
            b.reject()
            return ErrBulkheadFull
        }
        return b.executeQueued(ctx, fn)
    }

    return b.executeWithSlot(ctx, fn)
}

func (b *BulkheadWithMetrics) executeQueued(ctx context.Context, fn func(ctx context.Context) error) error {
    // Try to take a queue slot.
    select {
    case b.queue <- struct{}{}:
        b.metrics.queueDepth.Inc()
    default:
        // Queue also full.
        b.reject()
        return ErrBulkheadFull
    }

    // Wait for a semaphore slot or timeout.
    queueTimeout := b.config.QueueTimeout
    if queueTimeout == 0 {
        queueTimeout = 5 * time.Second
    }

    timer := time.NewTimer(queueTimeout)
    defer timer.Stop()

    select {
    case <-b.semaphore:
        // Dequeue.
        <-b.queue
        b.metrics.queueDepth.Dec()
    case <-timer.C:
        <-b.queue
        b.metrics.queueDepth.Dec()
        b.reject()
        return fmt.Errorf("bulkhead: queue timeout after %s: %w", queueTimeout, ErrBulkheadFull)
    case <-ctx.Done():
        // The caller went away. This is NOT a bulkhead rejection: the
        // upstream may be perfectly healthy. Counting it as one would
        // inflate RejectionRate and trip the circuit breaker that reads
        // it, so only the queue slot is returned here.
        <-b.queue
        b.metrics.queueDepth.Dec()
        b.metrics.requestsTotal.WithLabelValues("canceled").Inc()
        return ctx.Err()
    }

    return b.executeWithSlot(ctx, fn)
}

func (b *BulkheadWithMetrics) executeWithSlot(ctx context.Context, fn func(ctx context.Context) error) error {
    b.metrics.inFlight.Inc()
    start := time.Now()

    defer func() {
        b.metrics.inFlight.Dec()
        b.semaphore <- struct{}{} // Release slot.
    }()

    err := fn(ctx)
    elapsed := time.Since(start).Seconds()

    result := "success"
    if err != nil {
        result = "error"
    }

    b.metrics.requestsTotal.WithLabelValues(result).Inc()
    b.metrics.latencyHistogram.WithLabelValues(result).Observe(elapsed)

    return err
}

func (b *BulkheadWithMetrics) reject() {
    b.totalRejections.Add(1)
    b.metrics.rejectionsTotal.Inc()
    b.metrics.requestsTotal.WithLabelValues("rejected").Inc()
}

// RejectionRate returns the fraction of total calls rejected for lack of
// capacity. Client cancellations are deliberately excluded: they say nothing
// about the upstream's health, and counting them here would open the circuit
// breaker that reads this value every time a burst of clients hangs up.
//
// Note this is a lifetime rate, not a windowed one. An instance that has been
// up for a week will dilute a rejection spike into invisibility, so alert on
// the Prometheus rate() of bulkhead_rejections_total instead and use this
// only for in-process admission decisions on short-lived counters.
func (b *BulkheadWithMetrics) RejectionRate() float64 {
    total := b.totalCalls.Load()
    if total == 0 {
        return 0
    }
    return float64(b.totalRejections.Load()) / float64(total)
}

// Available returns the number of currently available semaphore slots.
func (b *BulkheadWithMetrics) Available() int {
    return len(b.semaphore)
}
```

### Bulkhead Sizing Formula

Sizing a bulkhead is not guesswork. There is a deterministic formula derived from Little's Law:

```
Concurrency = Throughput × Latency

MaxConcurrent = TargetRPS × P99LatencySeconds × SafetyFactor
```

P99 here is the conservative variant: it sizes for the worst 1% rather than the average, so treat the safety factor as already partly spent (see 22.4 for the mean-latency formulation and why stacking P99 with a second fudge factor oversizes the bulkhead several times over).

**Worked Example:**

Your payment service receives 500 requests per second at peak. The P99 latency to the payment provider is 800ms (0.8 seconds). You apply a safety factor of 1.5 to handle burst traffic above P99.

```
MaxConcurrent = 500 × 0.8 × 1.5 = 600
```

But wait: if the payment provider degrades to 5-second latency under load, you do not want 600 goroutines blocked for 5 seconds. You want to cap total capacity consumed. Recalculate with degraded latency as your ceiling:

```
MaxConcurrent_degraded = 500 × 5.0 × 1.0 = 2500  // WAY too high
```

Instead, accept that under degradation the bulkhead will fill up and reject. Set `MaxConcurrent` based on normal P99, and let the bulkhead rejection rate trigger your circuit breaker. The circuit breaker then opens and redirects to a fallback, preventing 2500 goroutines from piling up.

```
// Worked sizing for three services:

// Database: 2000 RPS, P99 = 20ms, safety = 2.0
// MaxConcurrent = 2000 × 0.020 × 2.0 = 80

dbBulkhead, _ := NewBulkhead(BulkheadConfig{
    Name:          "postgresql",
    MaxConcurrent: 80,
    MaxQueueDepth: 20,
    QueueTimeout:  50 * time.Millisecond,
}, nil)

// Redis cache: 5000 RPS, P99 = 2ms, safety = 3.0
// MaxConcurrent = 5000 × 0.002 × 3.0 = 30

cacheBulkhead, _ := NewBulkhead(BulkheadConfig{
    Name:          "redis",
    MaxConcurrent: 30,
    MaxQueueDepth: 50,
    QueueTimeout:  10 * time.Millisecond,
}, nil)

// Payment API: 200 RPS, P99 = 800ms, safety = 1.5
// MaxConcurrent = 200 × 0.800 × 1.5 = 240

paymentBulkhead, _ := NewBulkhead(BulkheadConfig{
    Name:          "payment_api",
    MaxConcurrent: 240,
    MaxQueueDepth: 0, // No queue. Payment calls are synchronous and latency-sensitive.
    QueueTimeout:  0,
}, nil)
```

### Service-Level Bulkheads

Bulkheads should be defined per logical dependency, not per instance. You have one `payment_api` bulkhead regardless of whether you have 3 or 30 payment API servers behind a load balancer. The bulkhead protects you from the logical dependency being slow, and the number of instances behind it is irrelevant to that protection.

```go
// ServiceBulkheads groups all bulkheads for a service.
// Inject this into service constructors.
type ServiceBulkheads struct {
    DB          *BulkheadWithMetrics
    Cache       *BulkheadWithMetrics
    PaymentAPI  *BulkheadWithMetrics
    SearchAPI   *BulkheadWithMetrics
    ReviewsAPI  *BulkheadWithMetrics
}

func NewServiceBulkheads(reg prometheus.Registerer) (*ServiceBulkheads, error) {
    var err error
    sb := &ServiceBulkheads{}

    if sb.DB, err = NewBulkhead(BulkheadConfig{
        Name: "postgresql", MaxConcurrent: 80, MaxQueueDepth: 20,
        QueueTimeout: 50 * time.Millisecond,
    }, reg); err != nil {
        return nil, fmt.Errorf("db bulkhead: %w", err)
    }

    if sb.Cache, err = NewBulkhead(BulkheadConfig{
        Name: "redis", MaxConcurrent: 30, MaxQueueDepth: 50,
        QueueTimeout: 10 * time.Millisecond,
    }, reg); err != nil {
        return nil, fmt.Errorf("cache bulkhead: %w", err)
    }

    if sb.PaymentAPI, err = NewBulkhead(BulkheadConfig{
        Name: "payment_api", MaxConcurrent: 240,
    }, reg); err != nil {
        return nil, fmt.Errorf("payment bulkhead: %w", err)
    }

    if sb.SearchAPI, err = NewBulkhead(BulkheadConfig{
        Name: "search_api", MaxConcurrent: 60, MaxQueueDepth: 10,
        QueueTimeout: 100 * time.Millisecond,
    }, reg); err != nil {
        return nil, fmt.Errorf("search bulkhead: %w", err)
    }

    if sb.ReviewsAPI, err = NewBulkhead(BulkheadConfig{
        Name: "reviews_api", MaxConcurrent: 40,
    }, reg); err != nil {
        return nil, fmt.Errorf("reviews bulkhead: %w", err)
    }

    return sb, nil
}
```

### Bulkhead Rejection Handling

When a bulkhead rejects a request, you must handle the rejection gracefully at the call site. The standard HTTP response is **503 Service Unavailable** with a `Retry-After` header indicating when capacity might free up.

```go
package middleware

import (
    "context"
    "errors"
    "net/http"
    "strconv"
    "time"

    "your/module/bulkhead"
)

// BulkheadMiddleware wraps an HTTP handler with bulkhead protection.
func BulkheadMiddleware(bh *bulkhead.BulkheadWithMetrics, retryAfter time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            err := bh.Execute(r.Context(), func(ctx context.Context) error {
                next.ServeHTTP(w, r.WithContext(ctx))
                return nil
            })

            if err == nil {
                return
            }

            if errors.Is(err, bulkhead.ErrBulkheadFull) {
                w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
                w.Header().Set("X-Rejection-Reason", "bulkhead-capacity-exhausted")
                http.Error(w, "Service temporarily at capacity. Please retry.", http.StatusServiceUnavailable)
                return
            }

            // Context canceled, meaning the client disconnected.
            if errors.Is(err, context.Canceled) {
                return
            }

            http.Error(w, "Internal server error", http.StatusInternalServerError)
        })
    }
}
```

### Prometheus Alert: High Bulkhead Rejection Rate

Prometheus alerting rules let you define thresholds that fire pages or notifications when a bulkhead's behavior indicates a dependency is degrading. The first rule fires when the fraction of rejected requests exceeds 2% over a two-minute window, which typically means the upstream is responding more slowly than the bulkhead's sizing assumed. The second rule warns when the in-flight gauge approaches the configured maximum, giving operators advance notice before the bulkhead starts shedding load so they can act before users are affected.

```yaml
# prometheus/alerts/bulkhead.yaml
groups:
  - name: bulkhead_alerts
    rules:
      - alert: BulkheadHighRejectionRate
        expr: |
          rate(bulkhead_rejections_total[2m])
          /
          # sum without (result) is load-bearing. bulkhead_requests_total
          # carries a "result" label and bulkhead_rejections_total does not,
          # so dividing the two raw vectors matches no series at all and the
          # alert silently never fires. Collapsing "result" makes both sides
          # {bulkhead="..."} so the one-to-one match succeeds.
          sum without (result) (rate(bulkhead_requests_total[2m]))
          > 0.02
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Bulkhead {{ $labels.bulkhead }} rejection rate {{ $value | humanizePercentage }}"
          description: |
            Bulkhead {{ $labels.bulkhead }} is rejecting more than 2% of requests.
            This indicates the upstream dependency is slower than expected or traffic
            has exceeded the bulkhead's configured capacity.

            Action: Check upstream latency. If latency has increased permanently,
            recalculate bulkhead size using: MaxConcurrent = RPS × P99 × SafetyFactor.

      - alert: BulkheadNearCapacity
        expr: |
          bulkhead_in_flight
          /
          # bulkhead_max_concurrent is published by NewBulkhead above. Both
          # sides are {bulkhead="..."} gauges, so they match one-to-one.
          bulkhead_max_concurrent
          > 0.85
        for: 30s
        labels:
          severity: info
        annotations:
          summary: "Bulkhead {{ $labels.bulkhead }} at {{ $value | humanizePercentage }} capacity"
```

### Full Working Example: HTTP Server with Per-Upstream Bulkheads

This end-to-end example wires three separate bulkheads, inventory, pricing, and reviews, each sized according to the Little's Law formula and each registered with a shared Prometheus registry. Required dependencies (inventory and pricing) fail hard with a 503 when their bulkhead is full, because a product page cannot be rendered without them. The reviews dependency is optional: when its bulkhead rejects, the handler logs a warning, omits review data from the response, and adds a `degraded_features` field so clients know the information is temporarily unavailable rather than erroneously absent.

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"
    "os"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "your/module/bulkhead"
)

// ProductResponse is the API response for a product detail page.
// Money is integer minor units (cents), never float64: this chapter's
// payments-adjacent examples follow the same rule as Chapter 18.
type ProductResponse struct {
    ProductID   string   `json:"product_id"`
    Name        string   `json:"name"`
    PriceCents  int64    `json:"price_cents"`
    InStock     bool     `json:"in_stock"`
    Reviews     []Review `json:"reviews,omitempty"`
    Degraded    []string `json:"degraded_features,omitempty"`
}

type Review struct {
    Author  string  `json:"author"`
    Rating  float64 `json:"rating"`
    Comment string  `json:"comment"`
}

type Server struct {
    bulkheads *ServiceBulkheads
    logger    *slog.Logger

    // Simulated upstream clients.
    inventoryClient *http.Client
    pricingClient   *http.Client
    reviewsClient   *http.Client
}

type ServiceBulkheads struct {
    inventory *bulkhead.BulkheadWithMetrics
    pricing   *bulkhead.BulkheadWithMetrics
    reviews   *bulkhead.BulkheadWithMetrics
}

func NewServer(reg prometheus.Registerer) (*Server, error) {
    inventoryBH, err := bulkhead.NewBulkhead(bulkhead.BulkheadConfig{
        Name:          "inventory",
        MaxConcurrent: 100, // 2000 RPS × 0.05s P99 × 1.0
    }, reg)
    if err != nil {
        return nil, err
    }

    pricingBH, err := bulkhead.NewBulkhead(bulkhead.BulkheadConfig{
        Name:          "pricing",
        MaxConcurrent: 60, // 1000 RPS × 0.04s P99 × 1.5
        MaxQueueDepth: 20,
        QueueTimeout:  30 * time.Millisecond,
    }, reg)
    if err != nil {
        return nil, err
    }

    reviewsBH, err := bulkhead.NewBulkhead(bulkhead.BulkheadConfig{
        Name:          "reviews",
        MaxConcurrent: 30, // 300 RPS × 0.1s P99 × 1.0
        MaxQueueDepth: 5,
        QueueTimeout:  50 * time.Millisecond,
    }, reg)
    if err != nil {
        return nil, err
    }

    return &Server{
        bulkheads: &ServiceBulkheads{
            inventory: inventoryBH,
            pricing:   pricingBH,
            reviews:   reviewsBH,
        },
        logger:          slog.New(slog.NewJSONHandler(os.Stdout, nil)),
        inventoryClient: &http.Client{Timeout: 200 * time.Millisecond},
        pricingClient:   &http.Client{Timeout: 150 * time.Millisecond},
        reviewsClient:   &http.Client{Timeout: 300 * time.Millisecond},
    }, nil
}

func (s *Server) handleProductDetail(w http.ResponseWriter, r *http.Request) {
    productID := r.PathValue("id")
    resp := &ProductResponse{ProductID: productID}

    // Inventory is required, so fail hard if the bulkhead rejects.
    var inStock bool
    err := s.bulkheads.inventory.Execute(r.Context(), func(ctx context.Context) error {
        // Simulate inventory lookup.
        inStock = true
        return nil
    })
    if err != nil {
        if errors.Is(err, bulkhead.ErrBulkheadFull) {
            http.Error(w, "Service at capacity", http.StatusServiceUnavailable)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    resp.InStock = inStock
    resp.Name = "Example Product"

    // Pricing is required, so fail hard if the bulkhead rejects.
    var priceCents int64
    err = s.bulkheads.pricing.Execute(r.Context(), func(ctx context.Context) error {
        priceCents = 4999
        return nil
    })
    if err != nil {
        if errors.Is(err, bulkhead.ErrBulkheadFull) {
            http.Error(w, "Service at capacity", http.StatusServiceUnavailable)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    resp.PriceCents = priceCents

    // Reviews are optional, so degrade gracefully if the bulkhead rejects.
    var reviews []Review
    err = s.bulkheads.reviews.Execute(r.Context(), func(ctx context.Context) error {
        reviews = []Review{
            {Author: "Alice", Rating: 4.5, Comment: "Great product!"},
        }
        return nil
    })
    if err != nil {
        s.logger.WarnContext(r.Context(), "reviews bulkhead rejected, degrading",
            "product_id", productID,
            "error", err,
        )
        resp.Degraded = append(resp.Degraded, "reviews")
        // resp.Reviews stays nil, and degraded_features tells the client why.
    } else {
        resp.Reviews = reviews
    }

    if len(resp.Degraded) > 0 {
        w.Header().Set("X-Degraded-Features", "reviews")
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func main() {
    reg := prometheus.NewRegistry()
    srv, err := NewServer(reg)
    if err != nil {
        slog.Error("failed to create server", "error", err)
        os.Exit(1)
    }

    mux := http.NewServeMux()
    mux.HandleFunc("GET /products/{id}", srv.handleProductDetail)
    mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))

    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    slog.Info("server starting", "addr", ":8080")
    if err := server.ListenAndServe(); err != nil {
        slog.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

### Staff Lens: Bulkhead Sizing Is Per-Workload

Formula gives a starting point. Tune with observation: rejection during healthy operation means increase, never-rejects during overload means decrease. Size to match workload's actual latency distribution, not a guess.

---
