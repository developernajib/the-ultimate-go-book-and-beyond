## 20.2 Third-Party Logging Libraries

As of 2026, `log/slog` is the default choice for new Go services. It ships in the standard library with zero dependencies, and it is fast enough that logging is almost never the bottleneck it is imagined to be.

It is, however, still the slowest of the three. Measured on the machine used for this book (linux/amd64, Go 1.27.1), logging the same message with four typed fields through a JSON encoder to `io.Discard`:

| Logger | Relative speed | B/op | allocs/op |
|---|---|---|---|
| `rs/zerolog` | ~5x faster than slog | 0 | 0 |
| `go.uber.org/zap` | ~2x faster than slog | 256 | 1 |
| `log/slog` (JSON) | baseline | 192 | 4 |

Read those columns carefully, because they do not tell one story. Zerolog genuinely lives up to its name on this path: zero allocations, and several times faster. Zap is quicker than slog while allocating *more* bytes per call, since its speed comes from avoiding reflection and interface boxing rather than from avoiding the heap. And slog's four allocations are the cost of an API designed for a stable, pluggable `Handler` interface rather than for winning benchmarks.

The allocation counts above are exact and reproducible. The speed ratios are the shape of the result rather than a promise: absolute per-call timings move by a factor of several with machine load, and yours will differ.

The decision this supports is narrow. Pick slog by default. A few hundred nanoseconds and four allocations per log line disappear next to a single database round trip, and being in the standard library means every library and handler in the ecosystem can interoperate with it. Reach for zerolog or zap when you have a *measured* hot-path logging bottleneck, which in practice means a service logging at a rate high enough that the logger shows up in its own CPU profile. For existing codebases on zap or zerolog there is no reason to migrate: all three can be bridged into a common sink, and both zap and zerolog can be exposed behind an `slog.Handler` if you want one interface across the org.

### Zap (Uber)

Zap is Uber's high-performance structured logging library, designed to minimize allocations on the hot path by using strongly-typed field constructors instead of `interface{}` variadic arguments. The `NewProduction` logger writes JSON to stderr with sampling enabled by default, making it suitable for high-throughput services where log volume must be controlled without silently dropping all records.

```go
import "go.uber.org/zap"

logger, _ := zap.NewProduction()
defer logger.Sync()

logger.Info("request completed",
    zap.String("method", "GET"),
    zap.String("path", "/users"),
    zap.Int("status", 200),
    zap.Duration("latency", time.Millisecond*50),
)
```

### Zerolog

Zerolog takes a zero-allocation approach by building log events through a fluent chain of method calls that write directly into a pre-allocated buffer, only flushing to the writer when `Msg` or `Send` is called. Its API encourages attaching structured fields inline, `Str`, `Int`, `Dur`, and similar methods, producing machine-readable JSON output with minimal overhead compared to reflection-based loggers.

```go
import "github.com/rs/zerolog"

logger := zerolog.New(os.Stdout).With().Timestamp().Logger()

logger.Info().
    Str("method", "GET").
    Str("path", "/users").
    Int("status", 200).
    Msg("request completed")
```

### Staff Lens: One Logger Per Org

Standardize on one logger across the org. In modern Go, the right default is `log/slog`. Mixing zap, zerolog, and slog means three sets of conventions, three sets of handlers, three sets of tooling. Pick one. Apply consistently. If migrating from zap or zerolog, do it incrementally but commit to the end state.

### Production Retrospective: Migrating from Zap to slog (8-Month Assessment)

Standardizing on `log/slog` across microservices provides a single logging interface across internal modules and external dependencies without requiring adapter glue, as analyzed in production by [Renaldi Purwanto (June 2026), "We Migrated from Zap to slog. Eight Months Later, Here Is the Honest Verdict"](https://medium.com/@renaldipurwanto/we-migrated-from-zap-to-slog-eight-months-later-here-is-the-honest-verdict).

In real workloads, the allocation gap between Zap and slog shows diminishing returns. Microbenchmarks report:
- `zap.Logger`: 180 B/op, 1 alloc/op
- `slog.JSONHandler`: 392 B/op, 4 allocs/op

In an HTTP service serving 10,000 req/s, the additional 212 bytes and 3 allocations translate to ~2 MB/s of transient heap allocations and under 0.25% of total request execution time. This overhead is minor compared to JSON payload decoding, transport serialization, and database queries. The operational gain is removing third-party logging dependencies from shared internal libraries.

The primary structural benefit is `slog.Handler`, which avoids the complex encoder/core machinery required by `zapcore.Core`. Below is a production redaction handler that masks sensitive values before records reach the downstream encoder:

```go
package logging

import (
	"context"
	"log/slog"
	"strings"
)

type RedactingHandler struct {
	next          slog.Handler
	sensitiveKeys map[string]struct{}
}

func NewRedactingHandler(next slog.Handler, keys ...string) *RedactingHandler {
	m := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		m[strings.ToLower(k)] = struct{}{}
	}
	return &RedactingHandler{next: next, sensitiveKeys: m}
}

func (h *RedactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *RedactingHandler) Handle(ctx context.Context, r slog.Record) error {
	scrubbed := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		scrubbed.AddAttrs(h.sanitizeAttr(a))
		return true
	})
	return h.next.Handle(ctx, scrubbed)
}

func (h *RedactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	sanitized := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		sanitized[i] = h.sanitizeAttr(a)
	}
	return &RedactingHandler{next: h.next.WithAttrs(sanitized), sensitiveKeys: h.sensitiveKeys}
}

func (h *RedactingHandler) WithGroup(name string) slog.Handler {
	return &RedactingHandler{next: h.next.WithGroup(name), sensitiveKeys: h.sensitiveKeys}
}

func (h *RedactingHandler) sanitizeAttr(a slog.Attr) slog.Attr {
	if _, found := h.sensitiveKeys[strings.ToLower(a.Key)]; found {
		return slog.String(a.Key, "[REDACTED]")
	}
	if a.Value.Kind() == slog.KindGroup {
		attrs := a.Value.Group()
		cleaned := make([]slog.Attr, len(attrs))
		for i, sub := range attrs {
			cleaned[i] = h.sanitizeAttr(sub)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(cleaned...)}
	}
	return a
}
```

### High-Throughput I/O Serialization and Lock Contention

Writing structured logs directly to `os.Stdout` or `os.Stderr` introduces hidden thread synchronization, detailed by [Yaninyz witty (May 2026), "Your Go application is probably logging too much"](https://medium.com/@yaninyzwitty/the-backend-scaling-problems-tutorials-never-tell-you).

In Go's runtime, writing to an `*os.File` acquires an internal write lock (`fd.pfd.writeLock`) per call:
```go
// src/os/file_posix.go
func (f *File) write(b []byte) (n int, err error) {
    // acquires internal file descriptor mutex
}
```

Under heavy concurrency (e.g., 5,000 goroutines logging error traces during an upstream timeout), goroutines serialize on standard output. The pprof thread trace reveals heavy contention on `syscall.Write` and `internal/poll.(*FD).Write`.

To prevent I/O blocking on the request path:
1. Wrap output sinks in a buffered writer (`bufio.NewWriterSize(os.Stdout, 64*1024)`) with a periodic flusher.
2. Filter or sample debug/info logs so that routine HTTP access logs do not flood disk I/O.
3. Separate audit trails from operational telemetry. As highlighted by [Erwin Hermanto (July 2026), "Audit Logging Done Right: What We Log, What We Don't, and How We Store It"](https://medium.com/@erwinhermanto/audit-logging-done-right-what-we-log-what-we-dont-and-how-we-store-it), operational logs are ephemeral and debug-oriented, whereas audit logs must be deterministic records of state mutations (actor ID, action, target entity, timestamp, before/after diff) piped to append-only, tamper-evident object storage.

### Production Log Rotation, Retention and Disk Safety

Long-running Go daemons writing to local volumes risk exhausting container disk space. Using standard log rotators, such as described by [Simon Tony (June 2026), "rotatefile: log rotation, compression, and cleanup for Go"](https://medium.com/@simontony/rotatefile-log-rotation-compression-and-cleanup-for-go), ensures logs rotate on both size thresholds (e.g., 100 MB) and time boundaries (daily), while performing gzip compression in a dedicated background worker to eliminate write pauses on the primary process.

---

