## 64G.3 Distributed Debugging

### The Multi-Service Timeline Problem

In monoliths, stack traces are self-contained. In distributed systems, a user request touches 5+ services, each with independent logs and metrics. Reconstructing "what happened" requires correlating across all of them.

```go
package debugging

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"
    "strings"
)

type contextKey string

const (
    traceIDKey contextKey = "trace_id"
    spanIDKey  contextKey = "span_id"
)

func generateTraceID() string { return "trace-123" }
func generateSpanID() string  { return "span-123" }

// Correlation ID middleware - inject into every service
// Use W3C Trace Context standard (traceparent header)
func CorrelationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract or generate trace context
        var traceID, spanID string

        if traceparent := r.Header.Get("traceparent"); traceparent != "" {
            // Parse W3C traceparent: "00-{traceID}-{parentSpanID}-{flags}"
            parts := strings.Split(traceparent, "-")
            if len(parts) == 4 {
                traceID = parts[1]
                spanID = generateSpanID() // New span for this service
            }
        } else {
            traceID = generateTraceID()
            spanID = generateSpanID()
        }

        // Inject into context
        ctx := context.WithValue(r.Context(), traceIDKey, traceID)
        ctx = context.WithValue(ctx, spanIDKey, spanID)

        // Set response header so caller can track the trace
        w.Header().Set("X-Trace-ID", traceID)

        // Propagate to downstream calls
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Structured logging with correlation
type Logger struct {
    log *slog.Logger
}

func (l *Logger) Error(ctx context.Context, msg string, args ...any) {
    traceID, _ := ctx.Value(traceIDKey).(string)
    spanID, _ := ctx.Value(spanIDKey).(string)

    l.log.ErrorContext(ctx, msg,
        append([]any{
            "trace_id", traceID,
            "span_id", spanID,
        }, args...)...,
    )
}

// HTTP client that propagates trace context
func newTracingClient() *http.Client {
    return &http.Client{
        Transport: &tracingTransport{
            base: http.DefaultTransport,
        },
    }
}

type tracingTransport struct {
    base http.RoundTripper
}

func (t *tracingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    ctx := req.Context()
    traceID, _ := ctx.Value(traceIDKey).(string)
    spanID, _ := ctx.Value(spanIDKey).(string)

    if traceID != "" {
        // W3C Trace Context
        req = req.Clone(ctx)
        req.Header.Set("traceparent",
            fmt.Sprintf("00-%s-%s-01", traceID, spanID),
        )
    }

    return t.base.RoundTrip(req)
}
```

### Distributed Trace Correlation for Debugging

Correlating traces across service boundaries requires propagating a common trace context (trace ID, span ID, and baggage) through every inter-service call, including async message passing. The following Go implementation shows how to inject and extract OpenTelemetry trace context from HTTP headers and Kafka message headers so that a single distributed request produces a unified trace in Jaeger or Tempo.

```go
package debugging

import (
    "sort"
    "time"
)

// Reconstructing a distributed failure timeline
// Example: "Order placement fails intermittently"

// Step 1: Find failing trace IDs from error logs
// grep '"level":"ERROR"' service.log | jq '.trace_id' | sort -u

// Step 2: Query all logs for that trace ID across services
// Kibana/Loki query: {trace_id="abc123def456"}

// Step 3: Build timeline
type TraceEvent struct {
    Timestamp   time.Time
    Service     string
    SpanID      string
    ParentSpanID string
    Operation   string
    DurationMs  int
    Status      string
    Error       string
    Metadata    map[string]string
}

// Timeline reconstruction tool
func reconstructTimeline(events []TraceEvent) []TraceEvent {
    // Sort by timestamp
    sort.Slice(events, func(i, j int) bool {
        return events[i].Timestamp.Before(events[j].Timestamp)
    })

    // Build parent-child tree
    bySpanID := make(map[string]*TraceEvent)
    for i := range events {
        bySpanID[events[i].SpanID] = &events[i]
    }

    return events
}

// Common debugging patterns:
// 1. Timeout cascade: UserSvc (29s) → OrderSvc (25s) → InventorySvc (20s) timeout
//    → All services waiting for InventorySvc which had a DB lock contention
//    Fix: set timeout shorter than the calling service's timeout (never equal)

// 2. Silent retry amplification:
//    Client retries 3x → LoadBalancer retries 3x → Service retries 3x
//    = 27 actual requests for 1 client request!
//    Fix: use retry budgets, not fixed retry counts

// 3. Out-of-order log timestamps:
//    Event A appears after Event B in logs, but A caused B
//    Reason: clock skew between servers
//    Fix: use vector clocks or HLC for causality, not wall clock
```

### Go Distributed Debugging Patterns

Debugging a distributed system failure requires tools and patterns that go beyond single-process debugging: timeline reconstruction from structured logs, span-based profiling, and controlled fault injection to reproduce intermittent failures. The pattern shown attaches `order_id`, `user_id`, and `step` attributes directly to the active OpenTelemetry span so that a single trace in Jaeger or Tempo contains the full execution context needed to reconstruct what happened without cross-referencing multiple log streams.

```go
package debugging

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
)

type InventoryResult struct {
    Available bool
}

type HLC struct {
    Physical int64
    Logical  int
}

func getRegion() string { return "us-east-1" }
func checkInventory(ctx context.Context, orderID string) (InventoryResult, error) { return InventoryResult{Available: true}, nil }
func chargePayment(ctx context.Context, orderID string) error { return nil }
func classifyPaymentError(err error) string { return "network" }

func processOrder(ctx context.Context, orderID string) error {
    ctx, span := otel.Tracer("order-service").Start(ctx, "processOrder")
    defer span.End()

    // Add attributes for debugging
    span.SetAttributes(
        attribute.String("order.id", orderID),
        attribute.String("order.region", getRegion()),
    )

    inventory, err := checkInventory(ctx, orderID)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }

    span.SetAttributes(attribute.Bool("inventory.available", inventory.Available))

    if err := chargePayment(ctx, orderID); err != nil {
        span.RecordError(err)
        // Key: add enough context to reconstruct the issue without needing to reproduce
        span.SetAttributes(
            attribute.String("payment.provider", "stripe"),
            attribute.String("payment.error_type", classifyPaymentError(err)),
        )
        return err
    }

    return nil
}

// Causality debugging: identify which service call caused the cascade
type CausalEvent struct {
    HLC       HLC    // Hybrid Logical Clock timestamp
    ServiceID string
    EventType string
    CausedBy  *HLC   // Points to the causing event's HLC
}
```

### Junior → FAANG: Debugging as a Systematic Practice, Not a Heroic Act

New engineers often debug distributed system failures through intuition and trial and error. At FAANG scale, intuition does not scale: when a failure affects millions of users across dozens of services, the engineer who reconstructs the timeline from data is more effective than the one who guesses.

Build the habit of treating every on-call incident as a data collection exercise. Before touching anything, collect: the time window, the affected services (from dashboards), one or two representative trace IDs from the error logs, and the shape of the metric anomaly (latency spike vs error rate spike vs traffic drop). These four artifacts are the input to a systematic debugging process.

For interviews, the question "how do you debug a distributed system failure?" expects a structured answer. The four-phase answer in this chapter (identify scope, reconstruct timeline, find root cause, verify hypothesis) is the correct structure. Candidates who jump straight to "I'd check the logs" without first establishing scope are demonstrating single-service debugging intuition applied to a multi-service problem.

The interview entry point: be able to describe a concrete debugging scenario end to end, naming the tools (Jaeger, Loki, Prometheus), the sequence of queries, and the signal that confirmed the root cause.

### Senior @ FAANG: Distributed Debugging as a Platform Capability

At senior level, the most important question about distributed debugging is not "can I debug a failure?" but "can everyone on my team debug a failure at 3am without me?" If the answer is no, the team's on-call reliability depends on individual heroics rather than platform capability.

**Trace coverage as a deployment gate.** At FAANG, teams that take observability seriously gate deployments on trace coverage: a service cannot be deployed if it drops trace context on any code path that crosses a service boundary. This is enforced by static analysis (checking that all outbound HTTP, gRPC, and message-queue calls use the tracing transport) and by integration tests that verify trace IDs appear in downstream service logs. Teams without this gate discover missing trace context during incidents, which is the worst possible time.

**Structured log schema governance.** When each service invents its own log schema, querying across services requires knowing each service's field naming convention. At FAANG scale, this is unsustainable. Staff engineers define a shared structured log schema: required fields (trace_id, span_id, service_name, environment, severity, timestamp as RFC3339), reserved field prefixes (request.*, user.*, error.*), and linting rules that reject logs missing required fields. This schema is a platform artifact, not a per-service concern.

**The "debugging blind spot" audit.** Staff engineers periodically audit their service's debuggability by asking: for the ten most common failure modes documented in our post-mortems, how long would it take a new on-call engineer, working alone, to identify the root cause using only the tools and runbooks we have today? If the answer is "longer than the incident's SLO allows," the gap is a platform investment, not an individual skill gap. The output is a prioritized list of observability improvements (add this span attribute, create this dashboard, write this runbook section) tied to specific failure modes.

**Causal ordering as a debugging accelerator.** The `CausalEvent` struct in this section, with its `CausedBy` field referencing a parent HLC, is the foundation of a causal graph. Teams that propagate causal relationships through their event streams can reconstruct the exact causal chain of a failure: event X caused event Y caused event Z. Without causal ordering, the reconstruction requires correlating timestamps that may have clock skew, introducing ambiguity about which event actually caused which. At FAANG scale, this ambiguity costs hours per incident. The investment in HLC propagation pays for itself after the first major incident where it disambiguates a complex causal chain.

**Post-mortem-driven observability.** The most impactful observability improvements come from post-mortems, not from upfront planning. Each post-mortem should end with the question: "what instrumentation, if it had existed, would have reduced the time to root cause by at least 50%?" The answer to that question becomes the top observability investment for the next sprint. This practice systematically closes debugging blind spots rather than adding instrumentation speculatively.

---
