## Web Service Pitfalls: When HTTP Handlers Go Wrong

This section covers the most dangerous web service mistakes that cause security vulnerabilities, data leaks, and service outages.

### The Missing Timeout Cascade

**The Incident**: A slow downstream service caused all handlers to hang. Connection pool exhausted, entire service unresponsive.

```go
// WRONG: No handler timeout

func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Call slow external service without timeout
    data, err := externalService.FetchData()  // 🚨 Can hang forever
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(data)
}

// All goroutines stuck waiting
// New requests can't be processed
```

```go
// CORRECT: Timeouts at every layer

func main() {
    server := &http.Server{
        Addr:         ":8080",
        ReadTimeout:  5 * time.Second,   // Time to read entire request
        WriteTimeout: 10 * time.Second,  // Time to write response
        IdleTimeout:  120 * time.Second, // Keep-alive timeout

        // Handler timeout (innermost)
        Handler: http.TimeoutHandler(router, 8*time.Second, "Request timeout"),
    }
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Propagate context to downstream calls
    data, err := externalService.FetchData(ctx)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            http.Error(w, "Request timed out", http.StatusGatewayTimeout)
            return
        }
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(data)
}
```

### The Response After Close

**The Problem**: Writing to ResponseWriter after it's been closed or hijacked.

```go
// WRONG: Writing after close

func handleSSE(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", 500)
        return
    }

    for {
        event := <-eventChan
        fmt.Fprintf(w, "data: %s\n\n", event)
        flusher.Flush()

        // 🚨 What if client disconnected?
        // Write fails silently, keeps trying
    }
}
```

```go
// CORRECT: Check context for client disconnect

func handleSSE(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", 500)
        return
    }

    ctx := r.Context()

    for {
        select {
        case <-ctx.Done():
            // Client disconnected
            log.Println("Client disconnected")
            return
        case event := <-eventChan:
            _, err := fmt.Fprintf(w, "data: %s\n\n", event)
            if err != nil {
                log.Println("Write error:", err)
                return
            }
            flusher.Flush()
        }
    }
}
```

### The JSON Injection

**The Problem**: HTML in JSON responses can cause XSS when rendered by browsers.

```go
// WRONG: Unescaped JSON

func handleUser(w http.ResponseWriter, r *http.Request) {
    user := User{
        Name: "<script>alert('xss')</script>",  // From user input
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
    // Browser might render this HTML!
}
```

```go
// CORRECT: HTML-safe JSON encoding

func handleUser(w http.ResponseWriter, r *http.Request) {
    user := User{
        Name: getUserInput(),  // Could contain HTML
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Content-Type-Options", "nosniff")

    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(true)  // Escape HTML characters
    encoder.Encode(user)
}

// Or use secure response helper
func writeJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json; charset=utf-8")
    w.Header().Set("X-Content-Type-Options", "nosniff")
    w.WriteHeader(status)

    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(true)
    encoder.Encode(data)
}
```

### The Middleware Order Trap

**The Problem**: Middleware in wrong order causes security bypass.

```go
// WRONG: Auth after logging sensitive data

func setupRoutes() http.Handler {
    router := mux.NewRouter()

    // 🚨 Logging happens BEFORE auth
    // Unauthorized requests still logged with sensitive headers
    router.Use(loggingMiddleware)
    router.Use(authMiddleware)  // Too late!

    return router
}

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Logs Authorization header for EVERY request
        // Including unauthenticated ones
        log.Printf("Request: %s %s Authorization: %s",
            r.Method, r.URL.Path, r.Header.Get("Authorization"))
        next.ServeHTTP(w, r)
    })
}
```

```go
// CORRECT: Security-conscious middleware order

func setupRoutes() http.Handler {
    router := mux.NewRouter()

    // Order matters!
    // 1. Recovery (catch panics)
    // 2. Request ID (for tracing)
    // 3. Auth (reject early)
    // 4. Logging (log after auth check)
    // 5. Rate limiting (after auth to apply per-user limits)

    router.Use(recoveryMiddleware)
    router.Use(requestIDMiddleware)
    router.Use(authMiddleware)  // Reject unauthorized FIRST
    router.Use(loggingMiddleware)  // Then log
    router.Use(rateLimitMiddleware)

    return router
}

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Auth already passed, safe to log
        userID := r.Context().Value("user_id")
        log.Printf("Request: %s %s user=%v", r.Method, r.URL.Path, userID)
        next.ServeHTTP(w, r)
    })
}
```

### The Body Reader Exhaustion

**The Problem**: Reading request body multiple times fails because it's already consumed.

```go
// WRONG: Body read twice

func handleRequest(w http.ResponseWriter, r *http.Request) {
    // First read in middleware
    body, _ := io.ReadAll(r.Body)  // Body now empty!
    log.Printf("Request body: %s", body)

    // Handler tries to read again
    var req Request
    json.NewDecoder(r.Body).Decode(&req)  // 🚨 Returns EOF!
}
```

```go
// CORRECT: Use GetBody or buffer for re-reading

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Read body
        body, err := io.ReadAll(r.Body)
        if err != nil {
            http.Error(w, "Failed to read body", 400)
            return
        }
        r.Body.Close()

        // Put it back for handlers to use
        r.Body = io.NopCloser(bytes.NewBuffer(body))

        // Also set GetBody for potential re-reads
        r.GetBody = func() (io.ReadCloser, error) {
            return io.NopCloser(bytes.NewBuffer(body)), nil
        }

        log.Printf("Request body: %s", body)
        next.ServeHTTP(w, r)
    })
}
```

### Quick Reference: Web Service Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| No handler timeout | Hung goroutines, outage | Timeouts at every layer |
| Write after close | Panic, errors | Check r.Context().Done() |
| JSON HTML injection | XSS vulnerability | SetEscapeHTML(true) |
| Wrong middleware order | Security bypass | Auth early, log later |
| Body read twice | Empty body on second read | Buffer and restore body |
| No Content-Type check | Type confusion | Validate Content-Type header |

### Junior to FAANG: Pitfalls That Will Page You

The pitfalls in this section represent real incidents from real companies. Internalize them through small experiments.

Timeout cascade experiment. Run a downstream mock that sleeps 60 seconds. Call it 1000 times concurrently from your service. Watch goroutines climb. Add a 5-second context timeout. Watch goroutines stay bounded. This visceral demonstration teaches context propagation better than any doc.

SSE write-after-close experiment. Open an SSE handler, connect with curl, kill the curl process. Watch the handler hang if you forgot the ctx.Done() check. Add the check. Watch it exit cleanly. Now you understand why context matters for streams.

Middleware ordering trap. Reorder your middleware to put logging before auth. Log the Authorization header. Verify that your access log now contains Bearer tokens (which is a compliance nightmare). Fix the order. Strip the Authorization header from logs universally via a scrubber.

Body reuse exercise. Write a middleware that logs request body. Hook it into a POST endpoint. Watch the handler decode fail with EOF. Buffer and restore. Understand why frameworks that give you "Context.RawBody" are doing this behind the scenes.

Interview framing. "A production service just went unresponsive, walk me through the investigation." First check goroutine count (pprof). Pegged means blocking downstream. Check outbound call timeouts. Check context propagation from handler to RPC client. Demo the template fix (timeout at every layer). That is the expected FAANG SRE-flavored debugging answer.

### Senior at FAANG: Pitfall Taxonomy as Fleet Reliability Program

Pitfall telemetry. For each pitfall in the table, define a detection signal, an SLI, and a remediation path.

Missing handler timeout. Signal, p99 latency above service SLO with goroutine count above steady state. SLI, `http_request_duration_seconds` p99 with alert on SLO burn. Remediation, platform middleware defaults 15-second handler timeout plus per-route overrides.

Write after close. Signal, `http_write_error_total` counter emitted by platform response-helper library. SLI, trend week over week. Remediation, platform SSE helper that handles ctx.Done() centrally, ban raw Fprintf loops on streaming handlers.

JSON HTML injection. Signal, SAST scan flags `json.NewEncoder(w)` without `SetEscapeHTML`. SLI, number of services using raw encoder. Remediation, platform `writeJSON` helper that always escapes.

Middleware order trap. Signal, CI lint detects router.Use calls not going through `router.Build` constructor. SLI, services using platform builder. Remediation, migrate services to builder.

Body read twice. Signal, panics observed with EOF in handler after middleware. SLI, `handler_decode_error_total{reason="empty_body"}` trend. Remediation, platform middleware that buffers body with max size enforcement, exposes `GetBody()` for downstream reads.

Content-Type confusion. Signal, handlers decoding JSON without checking `Content-Type: application/json`. SLI, SAST finding. Remediation, platform decoder helper that enforces content type.

Incident playbook per pitfall. Each pitfall has a runbook in the SRE wiki with symptoms, dashboards to check, mitigation commands (drain pod, bump replicas, disable feature flag), and root-cause fix timeline expectations. When a Sev-1 hits, oncall grabs the runbook.

Fleet drift report. Quarterly automated scan across every repo emits a drift score (how many pitfalls present per service). Teams see their ranking. Platform team engages the worst. Progress tracked as a top-level org metric. This single practice, sustained, is how FAANG orgs reach 99.99 percent availability at scale.

Chaos engineering for pitfalls. Monthly game day. Inject timeouts at a random downstream. Verify every service fails gracefully (5xx or queue, not pod crash or long hang). Services that fail the game day are prioritized for remediation. Over 12 months you systematically eliminate the entire pitfall class from the fleet.

Observability SLOs tied to pitfalls. Goroutine count per pod has an alert threshold. Sudden growth implies a leak (missing context propagation). Handler panic rate has an alert threshold. Growth implies a write-after-close or nil-pointer bug. These are leading indicators of pitfalls.

Training program. Quarterly brown-bag walking through the pitfall list with a real incident retro. New hires go through a "pitfall bootcamp" in onboarding week one. Make pitfall awareness part of the engineering culture, not a doc nobody reads.

Staff archetype. The Fleet Reliability Lead owns this program, partners with SRE on detection, platform on remediation, and education on prevention. Measures success by incident rate reduction and mean-time-to-remediation for known pitfalls. One of the most portable staff roles across orgs.

Multi-year roadmap. Year 1, codify the six pitfalls, land detection signals. Year 2, land platform library remediations, run first game day. Year 3, automated remediation (bot PRs) for remaining drift. Year 4, the pitfall list becomes a "solved problem" and the focus shifts to the next class (e.g. distributed transaction correctness).

---
