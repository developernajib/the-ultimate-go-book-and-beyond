## 20.12 Exercises with Solutions

### Exercise 1: Implement Request Duration Histogram

**Problem:** Create a histogram that tracks request duration with appropriate buckets.

**Solution:**

This middleware wraps every handler, starts a timer before the request and records the elapsed duration into a Prometheus histogram after the handler returns. The bucket boundaries are tuned for typical web-application latencies, ranging from 5 ms to 10 s.

```go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var requestDuration = promauto.NewHistogramVec(
    prometheus.HistogramOpts{
        Name: "http_request_duration_seconds",
        Help: "HTTP request duration in seconds",
        // Buckets optimized for web applications
        // 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
        Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
    },
    []string{"method", "path", "status"},
)

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (w *responseWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

func DurationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        wrapped := &responseWriter{ResponseWriter: w, status: 200}

        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()
        // Route template, never r.URL.Path: a metric label is a time
        // series, and one series per URL is a cardinality explosion (20.3).
        route := r.Pattern
        if route == "" {
            route = "unmatched"
        }
        requestDuration.WithLabelValues(
            r.Method,
            route,
            strconv.Itoa(wrapped.status),
        ).Observe(duration)
    })
}

// Queries for this histogram:
// The "sum by (le)" is required: histogram_quantile needs the le dimension
// and nothing else, or it returns one quantile per label combination.
// P50: histogram_quantile(0.5,  sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
// P95: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
// P99: histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```

### Exercise 2: Implement Log Correlation with Traces

**Problem:** Automatically add trace IDs to all log messages.

**Solution:**

The `TracingHandler` wraps any `slog.Handler` and intercepts every `Handle` call to extract the active span from the context. If a valid span exists, it appends `trace_id` and `span_id` attributes to the record before delegating to the inner handler. Both `WithAttrs` and `WithGroup` must return a new `TracingHandler` to preserve the wrapping through child loggers.

```go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// TracingHandler wraps a slog handler to add trace context
type TracingHandler struct {
    slog.Handler
}

func NewTracingHandler(h slog.Handler) *TracingHandler {
    return &TracingHandler{Handler: h}
}

func (h *TracingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Extract span from context
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        // Clone before mutating: the Handler contract forbids modifying the
        // Record you were given, and a Record copy still shares its attr array.
        r = r.Clone()
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
        )
    }

    return h.Handler.Handle(ctx, r)
}

func (h *TracingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &TracingHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *TracingHandler) WithGroup(name string) slog.Handler {
    return &TracingHandler{Handler: h.Handler.WithGroup(name)}
}

// Usage
func main() {
    baseHandler := slog.NewJSONHandler(os.Stdout, nil)
    tracingHandler := NewTracingHandler(baseHandler)
    logger := slog.New(tracingHandler)
    slog.SetDefault(logger)

    // Now all logs include trace context
    ctx, span := tracer.Start(context.Background(), "operation")
    defer span.End()

    slog.InfoContext(ctx, "processing request", "user_id", "123")
    // Output: {"time":"...","level":"INFO","msg":"processing request","user_id":"123","trace_id":"abc","span_id":"def"}
}
```

### Exercise 3: Build an SLO Monitor

**Problem:** Implement an SLO monitor that tracks error budgets.

**Solution:**

The `SLOMonitor` maintains running counts of total and good events, computes the current SLI (good/total ratio), and derives remaining error budget and burn rate from the target and time window. A background goroutine periodically pushes these derived values into Prometheus gauges so they can be used in alerting rules.

```go
package slo

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// SLODefinition defines a Service Level Objective
type SLODefinition struct {
    Name        string
    Description string
    Target      float64       // e.g., 0.999 for 99.9%
    Window      time.Duration // e.g., 30 days
}

// SLOMonitor tracks SLO compliance
type SLOMonitor struct {
    definition  SLODefinition

    // Metrics
    totalEvents   prometheus.Counter
    goodEvents    prometheus.Counter
    errorBudget   prometheus.Gauge
    burnRate      prometheus.Gauge

    mu            sync.RWMutex
    windowStart   time.Time
    totalCount    int64
    goodCount     int64
}

// NewSLOMonitor creates a new SLO monitor
func NewSLOMonitor(def SLODefinition) *SLOMonitor {
    m := &SLOMonitor{
        definition:  def,
        windowStart: time.Now(),
    }

    m.totalEvents = prometheus.NewCounter(prometheus.CounterOpts{
        Name: fmt.Sprintf("slo_%s_total_events", def.Name),
        Help: "Total events for SLO",
    })

    m.goodEvents = prometheus.NewCounter(prometheus.CounterOpts{
        Name: fmt.Sprintf("slo_%s_good_events", def.Name),
        Help: "Good events for SLO",
    })

    m.errorBudget = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: fmt.Sprintf("slo_%s_error_budget_remaining", def.Name),
        Help: "Remaining error budget (0-1)",
    })

    m.burnRate = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: fmt.Sprintf("slo_%s_burn_rate", def.Name),
        Help: "Error budget burn rate (1 = nominal)",
    })

    prometheus.MustRegister(m.totalEvents, m.goodEvents, m.errorBudget, m.burnRate)

    go m.updateMetrics()

    return m
}

// RecordEvent records an SLO event
func (m *SLOMonitor) RecordEvent(good bool) {
    m.mu.Lock()
    defer m.mu.Unlock()

    m.totalCount++
    m.totalEvents.Inc()

    if good {
        m.goodCount++
        m.goodEvents.Inc()
    }
}

// CurrentSLI returns the current Service Level Indicator
func (m *SLOMonitor) CurrentSLI() float64 {
    m.mu.RLock()
    defer m.mu.RUnlock()

    if m.totalCount == 0 {
        return 1.0
    }
    return float64(m.goodCount) / float64(m.totalCount)
}

// RemainingBudget returns the remaining error budget (0-1)
func (m *SLOMonitor) RemainingBudget() float64 {
    sli := m.CurrentSLI()
    allowedErrors := 1.0 - m.definition.Target
    actualErrors := 1.0 - sli

    return (allowedErrors - actualErrors) / allowedErrors
}

// BurnRate returns how fast we're consuming budget (1 = nominal)
func (m *SLOMonitor) BurnRate() float64 {
    m.mu.RLock()
    elapsed := time.Since(m.windowStart)
    m.mu.RUnlock()

    if elapsed == 0 {
        return 0
    }

    expectedProgress := elapsed.Seconds() / m.definition.Window.Seconds()
    actualConsumption := 1.0 - m.RemainingBudget()

    if expectedProgress == 0 {
        return 0
    }

    return actualConsumption / expectedProgress
}

func (m *SLOMonitor) updateMetrics() {
    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        m.errorBudget.Set(m.RemainingBudget())
        m.burnRate.Set(m.BurnRate())
    }
}

// Usage example
func main() {
    // Define SLO: 99.9% availability over 30 days
    slo := NewSLOMonitor(SLODefinition{
        Name:        "api_availability",
        Description: "API availability SLO",
        Target:      0.999,
        Window:      30 * 24 * time.Hour,
    })

    // Record events
    slo.RecordEvent(true)  // Good request
    slo.RecordEvent(true)
    slo.RecordEvent(false) // Bad request

    fmt.Printf("Current SLI: %.4f\n", slo.CurrentSLI())
    fmt.Printf("Error Budget Remaining: %.2f%%\n", slo.RemainingBudget()*100)
    fmt.Printf("Burn Rate: %.2fx\n", slo.BurnRate())
}
```

### Senior at FAANG Track

4. **Observability rollout audit.** For five services in your team's ownership, assess conformance to the standard (logs, metrics, traces, health checks, alerts, dashboards). Produce a gap report. Close the top three gaps.

5. **SLO definition for one service.** Define SLOs, set burn-rate alerts, link runbooks. Measure for a month. Refine.

6. **Dashboard consolidation.** Audit one team's Grafana dashboards. Identify duplicates, unused panels, missing metrics. Refactor to a clean dashboard set.

### Staff / Principal Track

7. **Org observability standard.** Author the org-wide observability standard. Publish. Socialise. Measure adoption.

8. **Shared observability library.** Ship the shared Go library that handles slog setup, Prometheus registration, OpenTelemetry initialization, health checks, and correlation-ID middleware. Drive adoption.

9. **MTTR measurement.** Define and measure mean-time-to-recovery for incidents. Correlate with observability maturity. Use findings to justify investment.

10. **Observability cost-benefit analysis.** Assess the org's observability spend vs value. Propose right-sizing: retain valuable data, reduce noise.

11. **Incident postmortem observability gap.** For five recent incidents, identify observability gaps (metrics missing, logs insufficient, traces unavailable). Systematically close them.

---
