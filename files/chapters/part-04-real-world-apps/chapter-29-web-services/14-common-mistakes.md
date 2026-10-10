## Common Mistakes

### Mistake 1: Not Setting Server Timeouts

Using `http.ListenAndServe` directly provides no timeout protection. A slow client can hold a connection open indefinitely, and enough of them exhaust the server's goroutine pool (slowloris attack).

**Wrong:**
```go
// Vulnerable to slowloris attacks and resource exhaustion
func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil) // No timeouts!
}
```

**Correct:**
```go
func main() {
    server := &http.Server{
        Addr:           ":8080",
        Handler:        handler,
        ReadTimeout:    15 * time.Second,  // Time to read request
        WriteTimeout:   15 * time.Second,  // Time to write response
        IdleTimeout:    60 * time.Second,  // Keep-alive timeout
        ReadHeaderTimeout: 5 * time.Second, // Time to read headers only
        MaxHeaderBytes: 1 << 20,           // 1MB max header size
    }
    log.Fatal(server.ListenAndServe())
}
```

### Mistake 2: Ignoring Context Cancellation

When a client disconnects mid-request, the request context is canceled. Handlers that ignore context cancellation continue doing expensive work for a response nobody will receive, wasting CPU and database connections.

**Wrong:**
```go
func (h *Handler) SlowOperation(w http.ResponseWriter, r *http.Request) {
    // Ignores context - continues even if client disconnects
    result, err := h.service.ExpensiveQuery()
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(result)
}
```

**Correct:**
```go
func (h *Handler) SlowOperation(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Check context before starting expensive work
    select {
    case <-ctx.Done():
        return // Client disconnected
    default:
    }

    result, err := h.service.ExpensiveQueryWithContext(ctx)
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // Client disconnected, don't write response
            return
        }
        if errors.Is(err, context.DeadlineExceeded) {
            http.Error(w, "Request timeout", http.StatusGatewayTimeout)
            return
        }
        http.Error(w, err.Error(), 500)
        return
    }

    // Check again before writing response
    select {
    case <-ctx.Done():
        return
    default:
        json.NewEncoder(w).Encode(result)
    }
}
```

### Mistake 3: Inconsistent Error Responses

When different handlers return errors in different formats, plain text, string-interpolated JSON, varying key names, API clients cannot parse errors reliably. A single error response helper fixes this.

**Wrong:**
```go
// Different error formats throughout the application
func handler1(w http.ResponseWriter, r *http.Request) {
    http.Error(w, "Not found", 404) // Plain text
}

func handler2(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(400)
    fmt.Fprintf(w, `{"error": "%s"}`, "Bad request") // String interpolation
}

func handler3(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{
        "message": "Unauthorized", // Different key
    })
}
```

**Correct:**
```go
// Consistent error response format
type APIError struct {
    Code    string `json:"code"`
    Message string `json:"message"`
    Details any    `json:"details,omitempty"`
}

func respondError(w http.ResponseWriter, status int, code, message string, details any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(APIError{
        Code:    code,
        Message: message,
        Details: details,
    })
}

// Usage
func handler(w http.ResponseWriter, r *http.Request) {
    user, err := getUser(r.Context(), id)
    if errors.Is(err, ErrNotFound) {
        respondError(w, 404, "USER_NOT_FOUND", "User does not exist", nil)
        return
    }
    // ...
}
```

### Mistake 4: Not Limiting Request Body Size

Without a body size limit, a malicious client can send a multi-gigabyte payload and force the server to allocate that much memory. `http.MaxBytesReader` wraps the body and returns an error if the limit is exceeded.

**Wrong:**
```go
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
    // Can consume unlimited memory
    body, _ := io.ReadAll(r.Body)
    // Process body...
}
```

**Correct:**
```go
const maxBodySize = 10 << 20 // 10MB

func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
    // Limit body size
    r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

    body, err := io.ReadAll(r.Body)
    if err != nil {
        var maxErr *http.MaxBytesError
        if errors.As(err, &maxErr) {
            respondError(w, 413, "PAYLOAD_TOO_LARGE",
                fmt.Sprintf("Request body must be less than %d bytes", maxBodySize), nil)
            return
        }
        respondError(w, 400, "BAD_REQUEST", "Failed to read request body", nil)
        return
    }
    // Process body...
}

// Or use middleware for all routes
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
            next.ServeHTTP(w, r)
        })
    }
}
```

### Mistake 5: Race Condition in Response Writer

`http.ResponseWriter` is not safe for concurrent use. Multiple goroutines writing to it simultaneously causes interleaved output and data races. Collect results through a channel and write from a single goroutine.

**Wrong:**
```go
func (h *Handler) ConcurrentWrite(w http.ResponseWriter, r *http.Request) {
    var wg sync.WaitGroup

    // Multiple goroutines writing to same ResponseWriter - DATA RACE!
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            fmt.Fprintf(w, "Result %d\n", i) // Race condition!
        }(i)
    }

    wg.Wait()
}
```

**Correct:**
```go
func (h *Handler) ConcurrentWrite(w http.ResponseWriter, r *http.Request) {
    results := make(chan string, 10)
    var wg sync.WaitGroup

    // Collect results in goroutines
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            results <- fmt.Sprintf("Result %d", i)
        }(i)
    }

    // Close channel when all goroutines complete
    go func() {
        wg.Wait()
        close(results)
    }()

    // Single goroutine writes all results
    var output []string
    for result := range results {
        output = append(output, result)
    }

    slices.Sort(output) // Deterministic order
    for _, line := range output {
        fmt.Fprintln(w, line)
    }
}
```

### Junior to FAANG: Making the Mistakes Once, Not Twice

Every mistake above has caused a real incident at a real company. Learn to recognize each one in code review.

Mistake 1 review signal. A PR introducing `http.ListenAndServe` or an `http.Server{}` literal with only `Addr` and `Handler`. Block, ask for timeouts.

Mistake 2 review signal. An expensive operation inside a handler that does not take `r.Context()` or ignores cancellation. Block, add context propagation.

Mistake 3 review signal. A handler calling `http.Error` with one format and another handler returning JSON. Block, require the shared helper.

Mistake 4 review signal. Any `io.ReadAll(r.Body)` without a `MaxBytesReader` wrapper. Block, add the wrapper.

Mistake 5 review signal. Any goroutine inside a handler writing directly to `w`. Block, channelize.

These five blocks, applied consistently, prevent roughly 60 percent of HTTP-related incidents in a typical codebase.

Additional junior-level mistakes to internalize. Calling `r.Body.Close()` on the server side (the server does it for you, doing it yourself can race). Using `http.DefaultClient` without a timeout (the client timeout is infinite by default, classic outbound hang). Reading `r.FormValue` after `r.ParseMultipartForm` without re-reading (they share state). Setting headers after `WriteHeader` (silently ignored).

Worked example, a handler template that avoids all five mistakes.

```go
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    var req CreateReq
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.errors.Write(w, NewBadRequestError("invalid body"))
        return
    }
    result, err := h.svc.Create(ctx, req)
    if err != nil {
        if errors.Is(err, context.Canceled) { return }
        h.errors.Write(w, err)
        return
    }
    writeJSON(w, http.StatusCreated, result)
}
```

### Senior at FAANG: Mistake Prevention as Platform Discipline

Catalog of incident-causing mistakes. Maintain a living document, for each mistake, provide the symptom, the root cause, the fix, and the preventive control (CI lint, platform library, runtime check). Publish as the "anti-patterns" section of the platform handbook. Review after every Sev-1 to add entries.

CI linting for each mistake. Mistake 1, custom linter that rejects `http.Server{}` without the five timeouts. Mistake 2, vet-like check that flags handlers not taking `r.Context()`. Mistake 3, linter forbidding raw `http.Error` and bare `fmt.Fprintf(w, ...)` in handlers, require the helper. Mistake 4, require `MaxBytesReader` before body reads via AST scan. Mistake 5, require `-race` in CI and alert on race detector hits.

Tools to enforce. `semgrep` with custom rules. `golangci-lint` custom analyzers. `staticcheck` for built-ins. `exhaustruct` to force all `http.Server` fields set. Commit these as part of the platform repo so every service inherits them.

Postmortem culture as prevention. Every incident generates a blameless postmortem with root cause, contributing factors, detection, response, fix, and "how do we prevent the class." Aggregate across postmortems, find the top classes, fix systemically. This is the staff-level engineering work that makes the fleet more reliable year over year.

Shift-left runbooks. When a mistake recurs, do not write a runbook for SREs to detect it in prod. Write a linter, a platform fix, or a CI gate to prevent it from shipping. Runbooks are the last line of defense, not the first.

Tradeoffs and false positives. Strict lints catch 95 percent of bugs and reject 5 percent of legitimate code. Allow opt-out with a `// nolint:reason` comment plus a CODEOWNER review. Measure opt-out frequency per lint rule. If a rule is opted out more than it fires, retire or relax it.

Observability of anti-patterns. Emit metrics for each anti-pattern caught in CI (`lint_violations_total{rule}`). Trend over time. Celebrate reductions. Make visible improvement part of team goals.

Mistake education program. Quarterly brown-bag walking through the top 3 mistakes found in postmortems. Pair with live code review of real PRs. More effective than any onboarding doc.

Staff archetype. The Fleet Reliability Lead owns the anti-pattern catalog, the lint program, the postmortem aggregation, and the education. Partners with SRE on incident review. The position pays for itself in reduced Sev-1 rate within two quarters.

Multi-year roadmap. Year 1, codify the top 10 mistakes, land linters for five. Year 2, cover all 10, add runtime checks in platform libraries. Year 3, automated remediation (bot opens PRs to fix anti-patterns in existing code). Year 4, measure reduction in incident rate per anti-pattern, publish annual reliability report.

---
