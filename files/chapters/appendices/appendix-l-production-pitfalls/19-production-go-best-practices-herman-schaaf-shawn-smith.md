## Production Go Best Practices (Herman Schaaf & Shawn Smith)

From *"Production Go: Build modern, production-ready systems in Go"*, key production considerations. This book emphasizes the practical side of shipping Go code: how to detect race conditions before they reach production, how to handle errors consistently across your codebase, and how to write benchmarks that give you accurate results. The patterns below come from real-world Go services running at scale.

### Race Detection
- Always run tests with `-race` flag
- Race detector has ~2-20x overhead
- Use in CI/CD, not production
- Race bugs are often intermittent and hard to reproduce

### Error Handling Patterns

Consistent error handling is one of the most impactful practices for production Go services. Wrapping errors with `fmt.Errorf` and the `%w` verb preserves the original error for programmatic inspection while adding context that helps pinpoint failures in logs. The contrast below illustrates why silently discarding errors with `_` creates bugs that are nearly impossible to diagnose under production load.

```go
// Good: Return errors with context
func processUser(id string) error {
    user, err := db.GetUser(id)
    if err != nil {
        return fmt.Errorf("processUser: failed to get user %s: %w", id, err)
    }
    // ...
}

// Bad: Swallowing errors
func processUser(id string) {
    user, _ := db.GetUser(id) // Error ignored!
    // ...
}
```

### Concurrent Error Handling

When multiple goroutines perform work simultaneously, each must have a way to report both its result and any error back to the caller. Using a dedicated result struct that bundles `*http.Response` and `error` together lets you send everything over a single buffered channel, avoiding the need to synchronize two separate channels. Buffering the channel to the number of launched goroutines ensures no goroutine blocks on send, which would prevent it from terminating.

```go
type Result struct {
    Response *http.Response
    Error    error
}

results := make(chan Result, len(urls))
for _, url := range urls {
    go func(url string) {
        resp, err := http.Get(url)
        results <- Result{resp, err}
    }(url)
}
```

### Testing HTTP Handlers

Go's `net/http/httptest` package lets you test HTTP handlers in-process without starting a real server, making tests fast and deterministic. `httptest.NewRequest` builds a synthetic `*http.Request` and `httptest.NewRecorder` captures the response written by the handler, giving you direct access to the status code, headers, and body for assertions. This approach exercises the full handler logic while remaining isolated from network conditions and port availability.

```go
func TestHandler(t *testing.T) {
    req := httptest.NewRequest("GET", "/", nil)
    w := httptest.NewRecorder()

    handler(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("got %d, want %d", w.Code, http.StatusOK)
    }
}
```

### Benchmark Pitfalls
- Reset timer after setup: `b.ResetTimer()`
- Prevent compiler optimization: `var result int`
- Use `b.N` correctly
- Be wary of micro-benchmark noise

---
