## 20.1 Structured Logging with slog

Go 1.21 introduced `log/slog` for structured logging.

### Basic Usage

The package-level functions `slog.Info`, `slog.Warn`, and `slog.Error` accept a message string followed by alternating key-value pairs, making it trivial to attach contextual fields without defining a schema upfront. By default, slog writes to stderr using a text handler that formats each record on a single line with the timestamp, level, message, and all key-value attributes. This API replaces the old `log` package's unstructured string formatting with a style that log aggregation tools can parse reliably.

```go
import "log/slog"

func main() {
    slog.Info("starting server", "port", 8080)
    slog.Warn("connection slow", "latency_ms", 150)
    slog.Error("failed to connect", "error", err, "host", "db.example.com")
}
```

Output:
```
2024/01/15 10:30:00 INFO starting server port=8080
2024/01/15 10:30:00 WARN connection slow latency_ms=150
2024/01/15 10:30:00 ERROR failed to connect error="connection refused" host=db.example.com
```

### JSON Handler

`slog.NewJSONHandler` writes each log record as a single JSON object, which is the format expected by most production log pipelines including Datadog, Splunk, and the ELK stack. Calling `slog.SetDefault` installs the new logger globally so all package-level calls (`slog.Info`, etc.) automatically use it without requiring callers to pass a logger instance. The resulting output contains a consistent set of top-level fields, `time`, `level`, `msg`, alongside any application-defined attributes.

```go
logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
slog.SetDefault(logger)

slog.Info("request completed", "method", "GET", "path", "/users", "status", 200)
```

Output:
```json
{"time":"2024-01-15T10:30:00Z","level":"INFO","msg":"request completed","method":"GET","path":"/users","status":200}
```

### Custom Handler Options

`slog.HandlerOptions` controls three important behaviors: the minimum level that gets emitted, whether each record includes its source file and line number, and a `ReplaceAttr` callback that lets you rename or transform built-in fields before they are written. The example below uses `ReplaceAttr` to rename the `time` key to `ts`, a common convention in environments where `time` conflicts with a reserved field name in the ingestion pipeline. Setting `AddSource: true` is valuable during development because it adds a `source` field pointing directly to the code that produced the log entry.

```go
opts := &slog.HandlerOptions{
    Level: slog.LevelDebug,
    AddSource: true,
    ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
        if a.Key == slog.TimeKey {
            return slog.Attr{Key: "ts", Value: a.Value}
        }
        return a
    },
}

logger := slog.New(slog.NewJSONHandler(os.Stdout, opts))
```

### Context-Aware Logging

Storing a logger in the request context allows each handler in a chain to inherit trace identifiers and request-scoped fields without them being threaded through every function signature. The `WithLogger` and `FromContext` helpers below follow the standard context-key idiom using an unexported struct type to prevent collisions with keys from other packages. Calling `.With("request_id", req.ID)` on the extracted logger creates a child logger that automatically includes the request ID on every subsequent log line within that request's scope.

```go
type ctxKey struct{}

func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, ctxKey{}, logger)
}

func FromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

func handleRequest(ctx context.Context, req *Request) {
    logger := FromContext(ctx).With("request_id", req.ID)
    logger.Info("processing request")
}
```

### Logger Groups

Logger groups namespace all subsequent attributes under a common prefix, which is especially useful for separating concerns like HTTP request data from application-level metadata in the same log record. `WithGroup("http")` creates a child logger where every key-value pair is nested under an `http` object in JSON output, and `slog.Group` within a log call creates an inline nested object for a subset of fields. This produces well-structured JSON that downstream tools can query with precise field paths rather than flat, ambiguous key names.

```go
logger := slog.Default().WithGroup("http")
logger.Info("request",
    "method", "GET",
    "path", "/api/users",
    slog.Group("response",
        "status", 200,
        "bytes", 1024,
    ),
)
```

### Logging Key Conventions

Adopt consistent keys across services: `request_id`, `user_id`, `trace_id`, `duration_ms`, `error`. A new engineer should be able to search logs across services using the same keys. Without conventions, each service invents its own and log correlation becomes impossible.

### Staff Lens: Logging as a Shared Interface

Every service in the org should log with the same keys, the same levels, the same correlation IDs. Publish the conventions as a one-page doc. Enforce via shared middleware. Without this, log analytics require per-service customization. With it, dashboards and queries work across the service catalog.

### Never Log Secrets

Passwords, tokens, PII. Logs are often retained longer and accessed more widely than the data they contain. A leaked secret in logs is a security incident. Enforce via linter (custom rule that greps for sensitive field names in log calls) or via a shared logger that scrubs known-sensitive fields automatically.

---
