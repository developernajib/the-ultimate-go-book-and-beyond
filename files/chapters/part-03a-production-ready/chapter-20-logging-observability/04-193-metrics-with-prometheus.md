## 20.3 Metrics with Prometheus

### Defining Metrics

Prometheus provides four metric types, three of which cover almost everything you will write: counters that only increase, gauges that can rise and fall freely, and histograms that track value distributions across configurable buckets. The fourth, the summary, computes quantiles inside each process, which means its results cannot be aggregated across instances. That single limitation is why histograms are the default choice for latency: you almost always want the P99 across the fleet, not the P99 of one replica averaged into nonsense.

Each metric is created with a name, a help string, and optional label dimensions that allow you to slice data by attributes such as HTTP method or response status. Registering all metrics in an `init` function ensures they are available before any requests arrive, and using `MustRegister` causes the program to panic at startup if two metrics share the same name, surfacing conflicts immediately rather than at runtime.

```go
import "github.com/prometheus/client_golang/prometheus"

var (
    requestsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    requestDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )

    activeConnections = prometheus.NewGauge(
        prometheus.GaugeOpts{
            Name: "active_connections",
            Help: "Number of active connections",
        },
    )
)

func init() {
    prometheus.MustRegister(requestsTotal, requestDuration, activeConnections)
}
```

### Using Metrics

HTTP middleware is the natural place to record per-request metrics because it wraps every handler without requiring changes to business logic. The middleware starts a timer before passing control downstream, then after the handler returns it reads the elapsed duration and the response status code from a thin wrapper around `http.ResponseWriter`.

The critical detail is which value becomes the `path` label. It must be the **route template**, never the live URL. Since Go 1.22, `r.Pattern` gives you exactly that for any request routed by `http.ServeMux`:

```go
func metricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        wrapped := &responseWriter{ResponseWriter: w, status: 200}
        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()

        // r.Pattern is the matched route template ("GET /users/{id}"), which
        // is bounded by the size of your routing table. r.URL.Path is not.
        route := r.Pattern
        if route == "" {
            route = "unmatched" // no pattern matched: never fall back to r.URL.Path
        }

        requestsTotal.WithLabelValues(r.Method, route, strconv.Itoa(wrapped.status)).Inc()
        requestDuration.WithLabelValues(r.Method, route).Observe(duration)
    })
}
```

The difference is not cosmetic, and it is the single most common way teams take down their own monitoring. With `r.URL.Path`, this middleware creates a brand new time series for every distinct URL it ever sees:

```
URL.Path="/users/12345"      Pattern="GET /users/{id}"
URL.Path="/users/67890"      Pattern="GET /users/{id}"
URL.Path="/users/abcde"      Pattern="GET /users/{id}"
```

Three users, three series with `r.URL.Path`, one series with `r.Pattern`. Extrapolate to a million users and Prometheus is holding a million series for one metric, which is how a monitoring system runs out of memory during the incident you deployed it to diagnose.

Note the fallback for unmatched requests. Returning `"unmatched"` is deliberate: falling back to `r.URL.Path` would hand an unbounded label straight to anyone who can send requests to nonexistent URLs, which is to say the entire internet. That turns your metrics endpoint into a denial-of-service target. If you are not using `http.ServeMux`, get the template from your router (`chi.RouteContext(r.Context()).RoutePattern()`, `mux.CurrentRoute(r).GetPathTemplate()`, and equivalents) rather than reaching for the raw path.

**Read `r.Pattern` after the handler, never before.** Routing has not happened yet when your middleware is entered, so the field is empty on the way in and only populated on the way out:

```
[middleware BEFORE] Pattern=""
[handler          ] Pattern="GET /users/{id}"
[middleware AFTER ] Pattern="GET /users/{id}"
```

There is one trap in this. The above works because the middleware passes `r` straight through, and `ServeMux` records the pattern on that same `*http.Request`. The moment you pass a *derived* request downstream, which is exactly what you do when you attach anything to the context, the mux writes the pattern onto the copy and your original never learns about it:

```go
req := r.WithContext(ctx)
next.ServeHTTP(wrapped, req)

route := r.Pattern    // "" forever: the mux never touched this value
route = req.Pattern   // "GET /users/{id}"
```

Silently labelling every metric `unmatched` is not the worst outcome available, but it is a monitoring outage that no test will catch. Keep a reference to the request you actually passed down, and read the pattern from that.

### Exposing Metrics

Prometheus scrapes metrics by polling an HTTP endpoint, conventionally mounted at `/metrics`, on a configurable interval. The `promhttp.Handler()` function serializes every registered metric into the Prometheus text exposition format, including current values, type hints, and help strings. Mounting this handler on its own path keeps it separate from application traffic and makes it straightforward to restrict access to internal networks or require authentication at the reverse-proxy layer.

```go
import "github.com/prometheus/client_golang/prometheus/promhttp"

http.Handle("/metrics", promhttp.Handler())
```

### Label Cardinality Is a Trap

Every unique combination of label values creates a new time series. Labels with unbounded cardinality (user ID, URL path with IDs, error messages) blow up Prometheus memory and query performance.

Avoid: user_id, email, full URL with IDs, raw error messages.
Prefer: user_tier, path template (`/users/:id`), error category.

Review cardinality before adding a label. A metric with 100 routes × 10 status codes × 5 methods = 5000 series. A metric with user_id × anything = millions of series.

### RED Method for Every Service

Every service should expose:
- **Rate** (requests per second).
- **Errors** (error rate).
- **Duration** (latency histogram).

These three metrics, properly labeled, tell you 80% of what you need to know about a service's health. Build a standard RED dashboard template. Apply to every service. Operators can then diagnose any service from a consistent view.

### Staff Lens: Metric Naming Conventions

`service_component_operation_unit`. Follow the Prometheus naming guide. Consistent naming across services means queries work across the catalog. Ad-hoc naming means every service requires custom query construction.

---
