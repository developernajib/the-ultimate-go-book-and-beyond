## Observability Pitfalls

Telemetry (metrics, structured logs, and traces) is the nervous system of cloud-native systems. However, naive instrumentation can paradoxically degrade system performance and consume more cluster memory than the core business application itself.

---

### 1. Prometheus High-Cardinality Metric Explosion

#### Root Cause Mechanics
Prometheus stores time series indexed by unique label permutations. Adding dynamic, unbounded parameters (e.g. `user_id`, `order_id`, `email`, raw URL with path parameters) as a Prometheus metric label creates millions of distinct time series in memory. This crashes Prometheus servers with OOM and spikes the client application's GC pause times.

#### Vulnerable Code
```go
// DANGEROUS: order_id has unbounded cardinality (millions of unique values!)
httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, orderID).Inc()
```

#### Production-Grade Solution
```go
// FIX: Strictly bound labels to known low-cardinality enums (e.g. status code, route template)
routeTemplate := chi.RouteContext(r.Context()).RoutePattern() // e.g., "/orders/{id}"
httpRequestsTotal.WithLabelValues(r.Method, routeTemplate, http.StatusText(statusCode)).Inc()
```

---

### 2. Synchronous Logging in the Hot Path

#### Root Cause Mechanics
Calling `log.Printf()` or writing JSON logs synchronously to standard output in high-frequency trading loops or high-throughput API handlers causes goroutines to block on OS write system calls (`write(2)`) and console mutex locks.

#### Production-Grade Solution
Use buffered, structured logging with Go 1.21's `log/slog` backed by an asynchronous ring buffer:
```go
import "log/slog"

// Use structured slog with pre-allocated attributes
slog.InfoContext(ctx, "order processed",
    slog.String("order_id", id),
    slog.Int("amount_cents", 5000),
    slog.Duration("latency", elapsed),
)
```
