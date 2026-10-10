## 103.5 Log Correlation

### Structured Logging with Trace Context

Structured logging captures program behavior in a machine-parseable format that supports querying, aggregation, and alerting at scale. Configuring log levels and sinks at startup separates the what-to-log decision (in source code) from the where-to-send-it decision (in deployment configuration).

```go
package logging

import (
    "context"
    "log/slog"
    "os"

    "go.opentelemetry.io/otel/trace"
)

// TraceHandler wraps slog.Handler to add trace context
type TraceHandler struct {
    slog.Handler
}

func NewTraceHandler(h slog.Handler) *TraceHandler {
    return &TraceHandler{Handler: h}
}

func (h *TraceHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        // Clone before modifying: Record copies share state per the slog contract
        r = r.Clone()
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
        )
    }
    return h.Handler.Handle(ctx, r)
}

func (h *TraceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &TraceHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *TraceHandler) WithGroup(name string) slog.Handler {
    return &TraceHandler{Handler: h.Handler.WithGroup(name)}
}

// Setup logger with trace correlation
func SetupLogger() *slog.Logger {
    handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    })

    return slog.New(NewTraceHandler(handler))
}

// Usage
func HandleRequest(ctx context.Context) {
    logger := SetupLogger()

    // Logs will automatically include trace_id and span_id
    logger.InfoContext(ctx, "processing request",
        slog.String("user_id", "123"),
        slog.String("action", "create_order"),
    )
}
```

### Junior → FAANG: Log-Trace Correlation Is the Glue Between Pillars

Without log-trace correlation, debugging a production issue requires switching between two separate tools with no connection: you find an error in the log aggregator, then manually reconstruct which trace it came from by guessing the timestamp range. With correlation, every log line carries the `trace_id` and `span_id` of the active span, so a single click in Grafana Loki or Datadog takes you directly to the trace.

The implementation is straightforward: extract the `SpanContext` from the active context using `trace.SpanFromContext(ctx).SpanContext()`, then add `trace_id` and `span_id` as fields on every log call within that context. Using `slog` with a custom handler that automatically injects these fields is the cleanest approach, because it removes the burden from every individual call site.

First-job habit: treat a log line without a trace ID as an incomplete log line. Add a linter or PR checklist item that flags log calls inside request handlers that do not use the context-aware logger.

### Senior @ FAANG: Unified Observability and the Cost of Correlation at Scale

**Correlation IDs as the platform contract.** At senior level, log-trace correlation is not just a developer convenience: it is the foundation of SLO-breach investigation workflows. When an error-budget burn-rate alert fires, the on-call engineer follows a documented playbook that starts with "find the correlated trace for the error log." If correlation is inconsistent (some services inject trace IDs, others do not), the playbook breaks and investigation time increases. Enforcing consistent correlation injection through a shared logging library that wraps `slog` with automatic OTel context injection is an L6-level platform contribution.

**Log sampling to control cost.** At FAANG-scale request volumes, emitting a structured log line for every request is prohibitively expensive. A senior engineer designs a log sampling strategy: log 100% of errors and slow requests, log 1% of successful requests, and always log requests whose trace is sampled. This strategy is implemented in the shared logger by checking `span.SpanContext().IsSampled()` and the request status before emitting. The OTel Collector can also filter logs based on severity level before forwarding, reducing egress cost to the log storage backend.

**Structured log schemas as data contracts.** Ad-hoc log fields create a maintenance burden for the teams that build dashboards and alerts on top of log data. An L6 engineer defines a structured log schema: required fields (timestamp, level, service, trace_id, span_id, request_id), optional domain fields (user_id, order_id, payment_method), and forbidden fields (raw SQL statements, PII, secrets). This schema is enforced by a log validation middleware in the shared library and audited periodically against production samples.

---
