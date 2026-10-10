## 20.5 Correlation IDs

### Generating and Propagating

Correlation IDs tie together all log entries produced during a single request, making it possible to trace the full lifecycle of a call across multiple handlers and services. The middleware below checks for an incoming `X-Request-ID` header, honoring IDs set by upstream callers, and generates a fresh UUID when none is present, storing the value in the request context and echoing it back in the response headers.

The header is attacker-controlled input, so it gets validated before it is trusted:

```go
type requestIDKey struct{}

const maxRequestIDLen = 64

// Conservative allowlist: enough for UUIDs, ULIDs, and hex trace IDs.
var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")

        // Reject anything we did not expect and mint our own instead.
        // Never propagate unvalidated caller input into logs or responses.
        if !validRequestID.MatchString(requestID) {
            requestID = uuid.New().String()
        }

        ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)

        w.Header().Set("X-Request-ID", requestID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func RequestIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey{}).(string); ok {
        return id
    }
    return ""
}
```

### Why the Validation Is Not Optional

The version of this middleware without the allowlist appears in a great many production codebases. It takes a header from an anonymous caller and writes it into your logs, your response headers, and often your metrics labels. Two of the obvious attacks are already handled for you, and it is worth knowing exactly which, so you know what is left.

**CRLF injection is blocked by Go.** Sending `abc\r\nX-Admin: true` does not split the response: `net/http` rejects the header value outright with `invalid header field value`. You do not have to defend against response splitting here.

**JSON log forging is blocked by slog.** A value like `x","level":"ERROR","msg":"FAKE BREACH` cannot inject fields, because the JSON handler escapes it:

```json
{"level":"INFO","msg":"processing request","request_id":"x\",\"level\":\"ERROR\",\"msg\":\"FAKE BREACH"}
```

Note that this protection comes from the *handler*, not from the logger. Write that same value into a plain text log line or a CSV export and you have forged a log entry.

**Length and charset are not handled by anything.** A 200-byte request ID sails straight through, gets logged in full, and gets echoed back. Nothing in the standard library objects, because nothing else knows what a request ID is supposed to look like. That leaves three real problems, all of which the allowlist closes:

- **Log and storage bloat.** Header limits are generous. An attacker who sends kilobyte request IDs on every request is writing to your log storage at your expense.
- **Poisoned correlation.** A caller who sends a *constant* request ID on every request collapses your correlation: thousands of unrelated requests now share one ID, and the one tool you reach for during an incident quietly stops working.
- **Cardinality explosion, if the ID ever reaches a metric label.** It should not, and the previous section explains why. If it does, a unique attacker-supplied ID per request is an unbounded label, which is a direct path to an out-of-memory Prometheus.

The rule generalizes past request IDs: any header you propagate into logs, metrics, or downstream calls is untrusted input, and "we just pass it through" is the decision that makes it dangerous. Validate the shape, bound the length, and mint your own value when the input does not match.

### Logging with Request ID

Once a request ID is stored in the context, every logger created within that request should carry it as a structured field so that all log lines share a common identifier. Calling `slog.Default().With("request_id", requestID)` produces a child logger that automatically appends the field to every message, keeping the correlation ID out of the message text itself and in a queryable, machine-readable key.

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    requestID := RequestIDFromContext(ctx)

    logger := slog.Default().With("request_id", requestID)
    logger.Info("processing request")
}
```

### Three Correlation IDs You Need

1. **Request ID:** generated at the edge, propagates through one service.
2. **Trace ID:** from OpenTelemetry, propagates across services.
3. **User/session ID:** identifies the actor.

All three belong in every log line. All three propagate through context. All three appear in every downstream call. Without this, log correlation across services is impossible.

### Staff Lens: Correlation as Infrastructure

Every service in the org should propagate and log the same set of correlation IDs. Ship shared middleware that handles this. Enforce via review: any new HTTP handler without correlation middleware is a gap.

---
