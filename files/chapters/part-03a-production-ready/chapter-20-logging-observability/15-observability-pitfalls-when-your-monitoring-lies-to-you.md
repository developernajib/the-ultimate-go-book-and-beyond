## Observability Pitfalls: When Your Monitoring Lies to You

This section covers the most dangerous observability mistakes that lead to missed incidents, alert fatigue, or worse - confidence in systems that are actually failing.

### The High-Cardinality Metrics Explosion

**The Incident**: A team added `user_id` as a label to all metrics. With 10 million users, Prometheus memory usage exploded from 2GB to 200GB, crashing the monitoring system during an actual incident.

```go
// WRONG: High-cardinality labels

var requestDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name: "http_request_duration_seconds",
    },
    []string{"method", "path", "status", "user_id"},  // 🚨 user_id = millions of unique values!
)

func handleRequest(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    userID := getUserID(r)
    // ... handle request ...

    requestDuration.WithLabelValues(
        r.Method,
        r.URL.Path,
        strconv.Itoa(status),
        userID,  // 🚨 Creates new time series for EVERY user
    ).Observe(time.Since(start).Seconds())
}

// Result:
// - 10M users × 10 paths × 5 methods × 5 statuses = 2.5 BILLION time series
// - Prometheus OOM
// - No monitoring during incident
```

The fix is to keep metric labels low-cardinality and move high-cardinality identifiers to exemplars, optional key-value pairs attached to individual observations that link a metric sample back to its trace without inflating the number of time series.

```go
// CORRECT: Low-cardinality labels with exemplars

var requestDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Buckets: prometheus.DefBuckets,
    },
    []string{"method", "path", "status"},  // ✓ Only low-cardinality labels
)

func handleRequest(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    userID := getUserID(r)
    traceID := getTraceID(r)
    // ... handle request ...

    duration := time.Since(start).Seconds()

    // Use exemplars for high-cardinality data (requires Prometheus 2.26+)
    requestDuration.WithLabelValues(
        r.Method,
        r.URL.Path,
        strconv.Itoa(status),
    ).(prometheus.ExemplarObserver).ObserveWithExemplar(
        duration,
        prometheus.Labels{
            "trace_id": traceID,  // ✓ Exemplar links to trace
            "user_id":  userID,   // ✓ Sample data, not every request
        },
    )
}

// For user-specific queries, use logs or traces:
// logs: {"user_id": "123", "duration_ms": 450, "trace_id": "abc"}
// traces: span with user_id attribute
```

### The Log Spam Problem

**The Scenario**: During an incident, engineers can't find relevant logs because they're buried under millions of debug messages.

```go
// WRONG: Logging everything at INFO level

func processOrder(ctx context.Context, order *Order) error {
    log.Info("Starting order processing", "order_id", order.ID)
    log.Info("Validating order", "order_id", order.ID)
    log.Info("Order validated successfully", "order_id", order.ID)
    log.Info("Checking inventory", "order_id", order.ID)
    log.Info("Inventory checked", "order_id", order.ID)
    log.Info("Processing payment", "order_id", order.ID)
    log.Info("Payment processed", "order_id", order.ID)
    log.Info("Order complete", "order_id", order.ID)
    // 8 log lines per order × 1000 orders/sec = 8000 logs/sec
    // During incident: can't find errors in the noise
    return nil
}
```

The fix is to reserve INFO for significant state transitions and outcomes, use DEBUG for step-by-step progress, and always attach enough structured context that a single log line is self-contained.

```go
// CORRECT: Strategic logging

func processOrder(ctx context.Context, order *Order) error {
    logger := slog.With("order_id", order.ID, "trace_id", getTraceID(ctx))

    // DEBUG: Detailed info for development/debugging
    logger.Debug("starting order processing")

    if err := validateOrder(order); err != nil {
        logger.Error("order validation failed", "error", err)
        return err
    }

    // Only log significant events at INFO
    logger.Info("order processing started",
        "customer_id", order.CustomerID,
        "total_cents", order.TotalCents,
    )

    // Log errors with full context
    if err := processPayment(ctx, order); err != nil {
        logger.Error("payment processing failed",
            "error", err,
            "payment_method", order.PaymentMethod,
            "amount_cents", order.TotalCents,
        )
        return err
    }

    logger.Info("order completed")
    return nil
}
```

### The Missing Correlation Problem

**The Nightmare**: An error occurs in production, but you can't trace it across services because there's no correlation ID.

```go
// WRONG: No correlation between logs, metrics, and traces

// Service A
func handleAPI(w http.ResponseWriter, r *http.Request) {
    log.Info("received request")  // Which request? No idea!

    resp, err := serviceB.Call(ctx)
    if err != nil {
        log.Error("service B failed")  // Can't correlate with Service B logs
        return
    }
}

// Service B
func handleCall(ctx context.Context) {
    log.Info("processing call")  // No way to link this to Service A
}
```

The solution is a middleware that injects a trace ID into every request context and creates a child logger carrying that ID. All downstream log lines and outgoing service calls inherit the same identifier, making cross-service queries trivial.

```go
// CORRECT: Full correlation across observability pillars

type contextKey string

const (
    traceIDKey   contextKey = "trace_id"
    requestIDKey contextKey = "request_id"
)

// Middleware to inject/propagate correlation IDs
func correlationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Get or create trace ID
        traceID := r.Header.Get("X-Trace-ID")
        if traceID == "" {
            traceID = generateTraceID()
        }

        // Get or create request ID (unique per request in this service)
        requestID := generateRequestID()

        // Add to context
        ctx := context.WithValue(r.Context(), traceIDKey, traceID)
        ctx = context.WithValue(ctx, requestIDKey, requestID)

        // Add to response headers for debugging
        w.Header().Set("X-Trace-ID", traceID)
        w.Header().Set("X-Request-ID", requestID)

        // Create logger with correlation IDs
        logger := slog.With(
            "trace_id", traceID,
            "request_id", requestID,
        )
        ctx = withLogger(ctx, logger)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// All logs automatically include correlation IDs
func handleAPI(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    logger := loggerFromContext(ctx)

    logger.Info("received request",
        "method", r.Method,
        "path", r.URL.Path,
    )

    // Pass trace ID to downstream services
    resp, err := serviceB.CallWithTraceID(ctx, getTraceID(ctx))
    if err != nil {
        logger.Error("service B failed", "error", err)
        // Now you can search: trace_id=abc123 and see ALL logs across ALL services
        return
    }
}
```

### The Alert Fatigue Trap

**The Problem**: 500 alerts per day, most meaningless. Engineers start ignoring all alerts, including critical ones.

```yaml
# WRONG: Alert on every anomaly

# Alert rule: CPU > 70%
- alert: HighCPU
  expr: cpu_usage > 0.7
  for: 1m
  # Fires 50 times a day during normal load spikes
  # Engineers stop responding

# Alert rule: Any 5xx error
- alert: ServerError
  expr: rate(http_errors_total{status=~"5.."}[1m]) > 0
  for: 0s
  # Single retry = alert
  # 100 alerts per day for normal behavior
```

```yaml
# CORRECT: Alert on symptoms that affect users

# Alert on SLO burn rate
- alert: ErrorBudgetBurning
  expr: |
    (
      # Fast burn: 14.4x budget consumption in last hour
      (1 - (sum(rate(http_requests_total{status!~"5.."}[1h])) / sum(rate(http_requests_total[1h])))) > (14.4 * 0.001)
    ) or (
      # Slow burn: 1x budget consumption in last 6 hours
      (1 - (sum(rate(http_requests_total{status!~"5.."}[6h])) / sum(rate(http_requests_total[6h])))) > (1 * 0.001)
    )
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Error budget burning - user impact likely"
    runbook: "https://wiki/runbooks/error-budget"

# Alert on actual user impact
- alert: HighLatencyP99
  expr: |
    histogram_quantile(0.99,
      sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
    ) > 2.0
  for: 10m  # Must persist for 10 minutes
  labels:
    severity: warning
  annotations:
    summary: "P99 latency exceeds 2 seconds for 10+ minutes"
```

### The Log Level Lie

**The Misconception**: "We log at DEBUG in production for better visibility."

```go
// WRONG: DEBUG logs in production

func init() {
    slog.SetLogLoggerLevel(slog.LevelDebug)  // 🚨 Everything logged!
}

func processItem(item Item) {
    slog.Debug("processing item", "item", item)  // Logs entire item struct
    slog.Debug("step 1 complete")
    slog.Debug("step 2 complete")
    slog.Debug("step 3 complete")
    // 10GB of logs per hour
    // $5000/month in log storage
    // Can't find anything useful
}
```

A better approach is per-component dynamic log levels that default to INFO and can be temporarily raised to DEBUG through an admin API during active investigation, with an automatic timeout that reverts to INFO after a set period.

```go
// CORRECT: Dynamic log levels per component

type LogLevel struct {
    level atomic.Value  // *slog.LevelVar
}

var componentLevels = map[string]*LogLevel{
    "payment":   {level: slog.LevelInfo},
    "inventory": {level: slog.LevelInfo},
    "orders":    {level: slog.LevelInfo},
}

// Enable debug logging for specific component during investigation
func setComponentLogLevel(component string, level slog.Level) {
    if l, ok := componentLevels[component]; ok {
        l.level.Store(level)
    }
}

// Expose via admin API
func handleSetLogLevel(w http.ResponseWriter, r *http.Request) {
    component := r.URL.Query().Get("component")
    level := r.URL.Query().Get("level")

    var lvl slog.Level
    lvl.UnmarshalText([]byte(level))

    setComponentLogLevel(component, lvl)

    // Auto-reset after 30 minutes
    time.AfterFunc(30*time.Minute, func() {
        setComponentLogLevel(component, slog.LevelInfo)
    })
}

// Usage: curl "admin:8080/loglevel?component=payment&level=debug"
// 30 minutes later: automatically reverts to INFO
```

### The Sampling Mistake

**The Problem**: You sample 1% of traces, but the error you're investigating was in the 99% that wasn't sampled.

```go
// WRONG: Random sampling misses important requests

sampler := trace.ParentBased(
    trace.TraceIDRatioBased(0.01),  // 1% of all traces
)

// 100 errors occurred, but only 1 was sampled
// Can't debug the other 99
```

An adaptive head-based sampler always captures errors and slow requests regardless of the base rate. For even better coverage, tail-based sampling in the OpenTelemetry Collector decides *after* the span completes, so it can see the final status code and latency before choosing whether to keep the trace.

```go
// CORRECT: Head-based sampling with error/slow request capture

type adaptiveSampler struct {
    baseSampler trace.Sampler
    errorBucket *rate.Limiter  // Always sample some errors
}

func (s *adaptiveSampler) ShouldSample(p trace.SamplingParameters) trace.SamplingResult {
    // Always sample if parent was sampled
    if p.ParentContext.IsSampled() {
        return trace.SamplingResult{Decision: trace.RecordAndSample}
    }

    // Sample based on attributes
    for _, attr := range p.Attributes {
        // Always sample errors
        if attr.Key == "error" && attr.Value.AsBool() {
            return trace.SamplingResult{Decision: trace.RecordAndSample}
        }

        // Always sample slow requests
        if attr.Key == "is_slow" && attr.Value.AsBool() {
            return trace.SamplingResult{Decision: trace.RecordAndSample}
        }
    }

    // Fall back to base sampler for normal requests
    return s.baseSampler.ShouldSample(p)
}

// BETTER: Tail-based sampling (sample after seeing outcome)

// Using OpenTelemetry Collector with tail sampling processor:
// processors:
//   tail_sampling:
//     decision_wait: 30s
//     policies:
//       - name: errors
//         type: status_code
//         status_code: {status_codes: [ERROR]}
//       - name: slow-requests
//         type: latency
//         latency: {threshold_ms: 1000}
//       - name: probabilistic
//         type: probabilistic
//         probabilistic: {sampling_percentage: 1}
```

### The Sensitive Data Leak

**The Incident**: PII was accidentally logged, resulting in compliance violation and $2M fine.

```go
// WRONG: Logging full request/response bodies

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        body, _ := io.ReadAll(r.Body)
        r.Body = io.NopCloser(bytes.NewBuffer(body))

        slog.Info("request received",
            "body", string(body),  // 🚨 Contains passwords, credit cards, SSN!
        )

        next.ServeHTTP(w, r)
    })
}
```

The defense is a custom `slog.Handler` that inspects each attribute key against a deny-list and replaces matches with `[REDACTED]` before the record reaches storage. This works regardless of what the application code passes in, providing a safety net that does not depend on every developer remembering to sanitise manually.

```go
// CORRECT: Structured logging with redaction

type LogSanitizer struct {
    redactFields map[string]bool
}

func NewLogSanitizer() *LogSanitizer {
    return &LogSanitizer{
        redactFields: map[string]bool{
            "password":         true,
            "credit_card":      true,
            "ssn":             true,
            "secret":          true,
            "token":           true,
            "authorization":   true,
            "x-api-key":       true,
        },
    }
}

func (s *LogSanitizer) Sanitize(data map[string]any) map[string]any {
    result := make(map[string]any)
    for k, v := range data {
        if s.redactFields[strings.ToLower(k)] {
            result[k] = "[REDACTED]"
        } else if nested, ok := v.(map[string]any); ok {
            result[k] = s.Sanitize(nested)
        } else {
            result[k] = v
        }
    }
    return result
}

// Custom slog handler with automatic redaction
type redactingHandler struct {
    slog.Handler
    sanitizer *LogSanitizer
}

func (h *redactingHandler) Handle(ctx context.Context, r slog.Record) error {
    // Build a fresh Record rather than mutating the caller's. This is both
    // safe under the Handler contract and what makes redaction total.
    sanitized := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
    r.Attrs(func(a slog.Attr) bool {
        if h.sanitizer.redactFields[strings.ToLower(a.Key)] {
            sanitized.AddAttrs(slog.String(a.Key, "[REDACTED]"))
        } else {
            sanitized.AddAttrs(a)
        }
        return true
    })
    return h.Handler.Handle(ctx, sanitized)
}

// These two are not boilerplate. Without them, logger.With(...) returns the
// INNER handler and redaction is silently switched off for that logger.
func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    // Redact the pre-bound attrs too: With("password", pw) must not leak.
    out := make([]slog.Attr, len(attrs))
    for i, a := range attrs {
        if h.sanitizer.redactFields[strings.ToLower(a.Key)] {
            out[i] = slog.String(a.Key, "[REDACTED]")
        } else {
            out[i] = a
        }
    }
    return &redactingHandler{Handler: h.Handler.WithAttrs(out), sanitizer: h.sanitizer}
}

func (h *redactingHandler) WithGroup(name string) slog.Handler {
    return &redactingHandler{Handler: h.Handler.WithGroup(name), sanitizer: h.sanitizer}
}
```

**Why `WithAttrs` and `WithGroup` are load-bearing here.** `redactingHandler` embeds `slog.Handler`, so without explicit overrides those two methods are promoted from the embedded value and return the *inner*, non-redacting handler. Any code that calls `logger.With(...)`, which is most code, gets a logger with redaction quietly removed:

```go
log := slog.New(&redactingHandler{Handler: base, sanitizer: s})
log.Info("login", "password", pw)              // [REDACTED]

reqLog := log.With("request_id", id)           // wrapper discarded here
reqLog.Info("login", "password", pw)           // password printed in full
```

A security control that disengages the moment someone adds a request ID is worse than no control, because the team believes it is protected. The same failure mode applies to the trace-injecting handlers elsewhere in this chapter, but there the symptom is a missing field, and here the symptom is a credential in your log pipeline.

Note also that `WithAttrs` redacts the attributes bound to it, not just the ones passed at the call site. `log.With("password", pw)` must be as safe as `log.Info("msg", "password", pw)`, and it only is if you sanitize on the way through.

Redaction by key name is a backstop, not a strategy. It fails on a key you did not think to list, on a token embedded in a URL or an error string, and on structured values whose fields are sensitive even though the top-level key is not. Use it, keep the deny-list in one shared place, and pair it with the `LogValuer` approach below, which puts the decision on the type that actually knows what is secret.

### The Better Default: `slog.LogValuer`

A deny-list of key names asks every call site to get the naming right forever. `slog.LogValuer` inverts that: the *type* decides how it appears in a log, once, and every call site inherits the decision automatically.

```go
type Password string

func (Password) LogValue() slog.Value {
    return slog.StringValue("[REDACTED]")
}

type User struct {
    ID    string
    Email string
    Token string
}

func (u User) LogValue() slog.Value {
    return slog.GroupValue(
        slog.String("id", u.ID),
        slog.String("email", "[REDACTED]"),
        // Token deliberately omitted: not redacted, simply never emitted.
    )
}
```

Any `slog` call that receives one of these types gets the safe rendering, regardless of which key the caller chose:

```json
{"level":"INFO","msg":"login","password":"[REDACTED]","user":{"id":"u_123","email":"[REDACTED]"}}
```

Three properties make this the better default. The safe behavior is attached to the type, so a new call site cannot forget it and a renamed field cannot defeat it. It survives `.With()`, because resolution happens when the value is formatted rather than in a handler that can be unwrapped. And it lets you *omit* a field entirely rather than emitting a redacted placeholder, which is the right answer for a token: `[REDACTED]` still tells an attacker the field exists.

The honest limitations. `LogValuer` protects the type, not the underlying data, so converting away from the type escapes it:

```go
log.Info("oops", "raw", string(pw))  // logs: "raw":"hunter2"
```

It also does nothing for secrets that arrive as plain strings from elsewhere, such as a connection string in an error message. That is precisely why the key-name handler above is still worth having. The two controls fail in different directions, which is the entire argument for running both: define `LogValuer` on every type that carries a secret, and keep the handler as the net that catches what the types miss.

### Quick Reference: Observability Anti-Patterns

| Anti-Pattern | Impact | Fix |
|--------------|--------|-----|
| High-cardinality labels | OOM, no monitoring during incident | Use exemplars, logs for high-cardinality |
| Log everything at INFO | Noise, high costs, can't find issues | Strategic logging, dynamic levels |
| No correlation IDs | Can't trace across services | Inject trace_id in all logs/metrics |
| Alert on every anomaly | Alert fatigue, ignored alerts | SLO-based alerting |
| Random trace sampling | Miss errors and slow requests | Tail-based or adaptive sampling |
| Logging sensitive data | Compliance violations, fines | Automatic redaction |

### Staff Lens: Treat Observability as Testable

Periodically validate that the observability actually works. Simulate incidents. Inject errors. Verify alerts fire. Verify logs and traces contain expected correlation. Observability that has never been tested often fails when needed most.

---
