## 20.10 Common Mistakes and How to Avoid Them

### Mistake 1: High-Cardinality Metrics Labels

Prometheus stores one time series per unique combination of label values. A label that takes millions of distinct values (user IDs, request IDs, email addresses) creates millions of time series that exhaust memory and crash the Prometheus server. Labels must be low-cardinality, bounded to a small, predictable set of values, while high-cardinality identifiers belong in logs and trace attributes.

```go
// BAD: User ID as metric label (millions of unique values)
requestsTotal.WithLabelValues(userID, method, path).Inc()
// This creates millions of time series and crashes Prometheus!

// GOOD: Use low-cardinality labels
requestsTotal.WithLabelValues(method, path, statusCode).Inc()
// Put user ID in logs/traces instead

// If you need per-user metrics, use aggregated buckets
userTier := getUserTier(userID) // "free", "pro", "enterprise"
requestsTotal.WithLabelValues(method, path, userTier).Inc()
```

### Mistake 2: Logging Sensitive Data

Structured logging makes it easy to attach arbitrary fields to every record, but that convenience becomes a liability when engineers log passwords, credit card numbers, or personally identifiable information (PII). Compliance frameworks like PCI-DSS and GDPR treat these log entries as data breaches. Instead, log only opaque identifiers and derived fields (such as the email domain rather than the full address), and use a redacting handler to strip sensitive keys before they reach storage.

```go
// BAD: Logging PII and secrets
logger.Info("user login",
    "email", user.Email,
    "password", password,  // NEVER log passwords!
    "credit_card", card,   // NEVER log payment data!
)

// GOOD: Redact sensitive fields
type User struct {
    Email    string `json:"email" log:"mask"`
    Password string `json:"-" log:"omit"` // Never log
}

// Use a custom log handler that respects tags
func redactingHandler(h slog.Handler) slog.Handler {
    return &RedactingHandler{h}
}

logger.Info("user login",
    "user_id", user.ID,
    "email_domain", extractDomain(user.Email),
    "has_2fa", user.Has2FA,
)
```

### Mistake 3: Not Correlating Logs, Metrics, and Traces

Logs, metrics, and traces that cannot be joined by a common identifier require manual correlation during incident investigation, a slow and error-prone process. Attaching the trace ID and span ID to every log record and using them as Prometheus exemplars creates a navigable thread from alert → log → trace that allows engineers to move from a firing alert to the exact trace within seconds.

```go
// BAD: Separate, uncorrelated data
logger.Info("request failed")
errorCounter.Inc()
// No way to connect these!

// GOOD: Include correlation IDs everywhere
ctx, span := tracer.Start(ctx, "handleRequest")
defer span.End()

logger := slog.Default().With(
    "trace_id", span.SpanContext().TraceID().String(),
    "span_id", span.SpanContext().SpanID().String(),
    "request_id", requestID,
)

logger.Info("request failed",
    "error", err.Error(),
    "user_id", userID,
)

errorCounter.WithLabelValues(
    span.SpanContext().TraceID().String(), // For exemplars
).Inc()
```

### Mistake 4: Sampling Everything the Same Way

A flat 1% sampling rate discards 99% of errors and slow requests, exactly the traces most needed for debugging. An adaptive sampler that always records errors and high-latency requests while aggressively sampling healthy traffic captures the interesting signal at low storage cost, providing complete visibility into anomalies without overwhelming the trace backend.

```go
// BAD: Same sampling rate for all traces
sampler := sdktrace.TraceIDRatioBased(0.01) // 1% of everything

// GOOD: Different sampling for different scenarios
type AdaptiveSampler struct{}

func (s *AdaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample errors
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
    }

    // Always sample slow requests
    if p.Name == "handleRequest" {
        // Check if parent span is slow
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    // Sample 10% of API requests
    if strings.HasPrefix(p.Name, "api.") {
        if rand.Float64() < 0.1 {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
    }

    // Sample 1% of everything else
    if rand.Float64() < 0.01 {
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    return sdktrace.SamplingResult{Decision: sdktrace.Drop}
}
```

### Mistake 5: Alerting on Metrics Instead of Symptoms

Alerting on CPU or memory utilization generates noise when the system is healthy despite high resource use. User-facing symptoms, elevated error rates and P99 latency, are directly actionable because they represent customer impact. Symptom-based alerts fire when users are affected and are silent otherwise, making the on-call rotation sustainable.

```go
// BAD: Alerting on low-level metrics
/*
ALERT HighCPU
  IF node_cpu_usage > 80
  FOR 5m
  # This might be fine! Maybe CPU should be high.
*/

// GOOD: Alert on user-facing symptoms
/*
ALERT HighErrorRate
  IF sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.01
  FOR 5m
  LABELS { severity = "critical" }
  ANNOTATIONS {
    summary = "High error rate on {{ $labels.service }}",
    description = "Error rate is {{ $value | humanizePercentage }}",
    runbook = "https://wiki.example.com/runbooks/high-error-rate"
  }

ALERT SlowP99Latency
  IF histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 1
  FOR 5m
  LABELS { severity = "warning" }
*/
```

### Additional Mistakes

1. **Logging secrets.** Passwords, tokens, PII in log fields. Security incident waiting to happen.
2. **Logging every HTTP 4xx as an error.** Client errors are not service errors. Log at info or warn level.
3. **Labels with unbounded cardinality.** User IDs as label values explodes Prometheus.
4. **Alerting on every deviation.** Noise training engineers to ignore alerts.
5. **Dashboards with too many panels.** Signal is lost in visual clutter. Keep dashboards focused.

### Staff Lens: Observability Review Checklist

For every new service, verify:

1. Uses standard logger with standard keys.
2. Exposes `/metrics` with RED metrics and any domain metrics.
3. Instruments with OpenTelemetry for tracing.
4. Has liveness and readiness health checks.
5. Has SLO-based alerts linked to runbooks.
6. Has a RED dashboard in Grafana.

Apply consistently. Services without these are incomplete and will be hard to operate.

---
