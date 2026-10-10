## 48.4 Metrics and Health

### Health Endpoints for Mesh

Health endpoints differentiate between liveness (the process is running) and readiness (the service can handle requests). Kubernetes uses these probes to restart unhealthy pods and to withhold traffic from pods that are starting up or draining.

```go
package health

import (
    "context"
    "database/sql"
    "encoding/json"
    "net/http"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// HealthChecker provides health status for mesh probes
type HealthChecker struct {
    mu       sync.RWMutex
    checks   map[string]HealthCheck
    status   HealthStatus
}

type HealthCheck func() error

type HealthStatus struct {
    Status    string            `json:"status"`
    Checks    map[string]string `json:"checks"`
    Timestamp string            `json:"timestamp"`
}

func NewHealthChecker() *HealthChecker {
    return &HealthChecker{
        checks: make(map[string]HealthCheck),
    }
}

// AddCheck registers a health check
func (h *HealthChecker) AddCheck(name string, check HealthCheck) {
    h.mu.Lock()
    h.checks[name] = check
    h.mu.Unlock()
}

// LivenessHandler for Kubernetes liveness probe
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness should be simple - is the process running?
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// ReadinessHandler for Kubernetes readiness probe
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    status := HealthStatus{
        Status:    "healthy",
        Checks:    make(map[string]string),
        Timestamp: time.Now().Format(time.RFC3339),
    }

    httpStatus := http.StatusOK

    for name, check := range h.checks {
        if err := check(); err != nil {
            status.Status = "unhealthy"
            status.Checks[name] = err.Error()
            httpStatus = http.StatusServiceUnavailable
        } else {
            status.Checks[name] = "ok"
        }
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(status)
}

// Example checks
func DatabaseCheck(db *sql.DB) HealthCheck {
    return func() error {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        return db.PingContext(ctx)
    }
}

func RedisCheck(client *redis.Client) HealthCheck {
    return func() error {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        return client.Ping(ctx).Err()
    }
}

// Setup health endpoints
func SetupHealthEndpoints(mux *http.ServeMux, checker *HealthChecker) {
    // Liveness - simple check
    mux.HandleFunc("/health", checker.LivenessHandler)
    mux.HandleFunc("/healthz", checker.LivenessHandler)

    // Readiness - full check
    mux.HandleFunc("/ready", checker.ReadinessHandler)
    mux.HandleFunc("/readyz", checker.ReadinessHandler)
}
```

### Prometheus Metrics for Mesh

While the mesh automatically collects network-level RED metrics (request count, error rate, duration) through Envoy or ztunnel, application-level metrics provide business context that the mesh cannot observe - orders placed, payments captured, cache hit ratio, queue depth. The `ServiceMetrics` struct below registers counters and histograms using the `prometheus/client_golang` library and records them through HTTP middleware. Exposing these metrics on `/metrics` via `promhttp.Handler()` lets Prometheus (or a Grafana Mimir / VictoriaMetrics backend in larger deployments) scrape both application and mesh metrics from the same pod. In ambient mode, Prometheus scrapes the ztunnel DaemonSet separately for L4 metrics and the waypoint proxy for L7 metrics, so your dashboards may need an additional source.

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

// ServiceMetrics provides standard metrics
type ServiceMetrics struct {
    requestsTotal    *prometheus.CounterVec
    requestDuration  *prometheus.HistogramVec
    errorsTotal      *prometheus.CounterVec
    activeRequests   prometheus.Gauge
}

func NewServiceMetrics(serviceName string) *ServiceMetrics {
    return &ServiceMetrics{
        requestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Name: "http_requests_total",
                Help: "Total number of HTTP requests",
                ConstLabels: prometheus.Labels{"service": serviceName},
            },
            []string{"method", "path", "status"},
        ),
        requestDuration: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "http_request_duration_seconds",
                Help:    "HTTP request duration in seconds",
                Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
                ConstLabels: prometheus.Labels{"service": serviceName},
            },
            []string{"method", "path"},
        ),
        errorsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Name: "http_errors_total",
                Help: "Total number of HTTP errors",
                ConstLabels: prometheus.Labels{"service": serviceName},
            },
            []string{"method", "path", "error_type"},
        ),
        activeRequests: promauto.NewGauge(
            prometheus.GaugeOpts{
                Name: "http_requests_active",
                Help: "Number of active HTTP requests",
                ConstLabels: prometheus.Labels{"service": serviceName},
            },
        ),
    }
}

// Middleware adds metrics to HTTP handlers
func (m *ServiceMetrics) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        m.activeRequests.Inc()

        // Wrap response writer
        wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()
        m.activeRequests.Dec()

        // Record metrics. Label by the route pattern, never the raw URL path:
        // /users/123 as a label value is unbounded cardinality.
        route := r.Pattern
        if route == "" {
            route = "unmatched"
        }
        m.requestsTotal.WithLabelValues(r.Method, route, strconv.Itoa(wrapped.status)).Inc()
        m.requestDuration.WithLabelValues(r.Method, route).Observe(duration)
    })
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (w *responseWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

// MetricsHandler returns the Prometheus metrics endpoint
func MetricsHandler() http.Handler {
    return promhttp.Handler()
}
```

### Junior → FAANG: Health Endpoints Are Contracts, Not Formalities

Junior engineers frequently implement health endpoints as a formality: return 200 and move on. In a mesh environment, this is a reliability bug. Kubernetes uses the readiness probe to decide whether to route traffic to a pod. If your readiness handler returns 200 even when the database is unreachable, the mesh keeps sending requests to a pod that cannot serve them, and users see errors instead of a clean failover.

The liveness vs readiness distinction is important to understand before a first FAANG interview:

Liveness answers: "Is the process alive and not deadlocked?" A Go goroutine leak that consumes all available goroutines can leave the process running but unable to handle requests. In that case you want the pod restarted. Liveness should be fast and not check external dependencies.

Readiness answers: "Is this pod ready to receive traffic right now?" This checks external dependencies: database ping, cache connectivity, any required downstream service. If readiness fails, Kubernetes removes the pod from the Service's endpoint slice, and Istio's Envoy stops routing new connections to it. Existing connections drain.

A concrete mistake to avoid: putting a slow dependency check in the liveness handler. If a database has a network partition and the liveness probe blocks for 30 seconds waiting for a timeout, Kubernetes may kill a perfectly healthy pod that simply cannot reach a dependency. Liveness should complete in under 100 milliseconds.

For the Prometheus metrics middleware, the most important habit is using route templates rather than actual URLs as labels. `/users/123` and `/users/456` should both be labeled `/users/:id`. Otherwise the label cardinality grows unbounded and kills your Prometheus instance.

### Senior @ FAANG: SLO-Aligned Health, Custom Metrics as Reliability Signals, and Multi-Layer Observability

**Health endpoints as SLO components.** At senior level, the readiness probe is not just a Kubernetes mechanism: it is the fastest automated response to a dependency failure. When a database replica fails and the application's connection pool exhausts, a readiness probe that correctly detects this removes the pod from rotation in ten seconds (probe failure threshold times period). Without a correct readiness probe, the mesh continues sending traffic to the pod and users see 500 errors for as long as the pod remains in service. The readiness probe is a first-responder, not a diagnostic tool.

**Startup probes for slow-starting services.** Go services that perform expensive initialization (schema migrations, cache warming, large config file parsing) may take longer than the standard readiness probe allows. Kubernetes' `startupProbe` solves this: it runs only during the startup window (failureThreshold times periodSeconds) and suspends liveness and readiness probes until it succeeds. After startup completes, liveness and readiness take over with their normal timing. Without a startup probe, a service that takes 90 seconds to initialize must set `initialDelaySeconds: 90` on both liveness and readiness, which means a crashed pod is not restarted for 90 seconds.

**Application metrics as early-warning signals.** The mesh provides RED metrics (Rate, Errors, Duration) for every service automatically. But these metrics describe what happened, not what is about to happen. Application-level metrics provide predictive signals: queue depth approaching consumer capacity, connection pool utilization approaching the limit, cache hit rate declining (indicating a cold cache that will soon generate load spikes on the origin). A senior engineer designs the metric set to answer the question "what will cause a page before it causes a user-visible error rate increase?"

**Ambient mode metric collection architecture.** In sidecar mode, Prometheus scrapes the sidecar container at a well-known port on each pod. In ambient mode, this changes: L4 metrics come from the ztunnel DaemonSet (one per node), and L7 metrics come from the waypoint proxy deployment (one per namespace or service account). Dashboards built for sidecar mode will show empty panels in ambient mode because the label selectors differ. The platform team must update ServiceMonitor objects and Grafana dashboard queries as part of the ambient migration, not as a follow-up task.

**SLO error budget as a metric.** The most senior observability pattern is modeling error budget burn rate as a metric and alerting on burn rate rather than raw error rate. A 5% error rate for one minute is a blip. A 1% error rate sustained for 36 hours burns through a monthly 99.9% SLO entirely. The Sloth or SLOCONF-based tooling generates these burn rate recording rules from a simple SLO specification. For a mesh-integrated Go service, the input data is the `istio_request_duration_milliseconds` histogram and the `istio_requests_total` counter from the sidecar. The platform team's job is to provide the tooling. The service team's job is to define the SLO threshold.

---
