export default `## 10B.6 Goroutine Leak Profile (Go 1.26)

### The Problem with Goroutine Leaks

Before Go 1.26, detecting goroutine leaks required third-party packages like \`goleak\` or manual analysis of \`runtime.NumGoroutine()\` over time. The new \`goroutineleak\` pprof profile provides first-class detection of goroutines blocked beyond a configurable threshold. It catches the most common leak categories:

\`\`\`go
// Types of goroutine leaks this profile detects:
// 1. Blocked waiting on unbuffered channel with no sender
// 2. Blocked on sync.Mutex that's never unlocked
// 3. Blocked on sync.Cond.Wait with condition never triggered
// 4. Blocked in select with no case ever ready
// 5. HTTP requests that never get response (context not cancelled)
\`\`\`

### Using the Goroutine Leak Profile

The goroutine leak profile endpoint lists goroutines blocked longer than the configured threshold. The output format matches other pprof profiles and can be analyzed with \`go tool pprof\`.

\`\`\`go
// Expose via pprof HTTP endpoint (standard)
// GET /debug/pprof/goroutineleak?seconds=30
// This profile captures goroutines blocked for >30 seconds

// Programmatic access:
import "runtime/pprof"

func dumpGoroutineLeaks(w io.Writer) error {
    return pprof.Lookup("goroutineleak").WriteTo(w, 1) // debug=1 for detailed output
}

// In tests - detect leaks in test suite
func TestMain(m *testing.M) {
    code := m.Run()
    // Check for goroutine leaks after all tests
    if err := checkGoroutineLeaks(); err != nil {
        fmt.Fprintf(os.Stderr, "goroutine leaks detected: %v\\n", err)
        os.Exit(1)
    }
    os.Exit(code)
}

func checkGoroutineLeaks() error {
    // Wait briefly for goroutines to clean up
    time.Sleep(100 * time.Millisecond)

    var buf bytes.Buffer
    pprof.Lookup("goroutineleak").WriteTo(&buf, 1)
    if buf.Len() > 0 {
        return fmt.Errorf("goroutine leaks:\\n%s", buf.String())
    }
    return nil
}
\`\`\`

### Common Goroutine Leak Patterns and Fixes

Most goroutine leaks fall into three categories: goroutines waiting on channels that never close, goroutines blocked on calls without timeouts, and goroutines waiting on context that is never cancelled.

\`\`\`go
// Leak pattern 1: Goroutine blocked on channel, context not propagated
// Wrong:
func processItems(items []Item) {
    results := make(chan Result)
    for _, item := range items {
        go func(item Item) {
            results <- process(item) // Blocks if nobody reads
        }(item)
    }
    // If we return early, goroutines block forever on results <- ...
    for range items {
        <-results
    }
}

// Correct: use context for cancellation
func processItems(ctx context.Context, items []Item) error {
    results := make(chan Result, len(items)) // Buffered - goroutines never block
    errCh := make(chan error, 1)

    for _, item := range items {
        go func(item Item) {
            select {
            case <-ctx.Done():
                return // Goroutine exits if context cancelled
            case results <- process(item):
            }
        }(item)
    }

    for range items {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case r := <-results:
            // handle r
            _ = r
        }
    }
    return nil
}

// Leak pattern 2: HTTP client goroutine blocked on response
// Wrong: no timeout on HTTP requests
func fetchURL(url string) ([]byte, error) {
    resp, err := http.Get(url) // Can block indefinitely!
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}

// Correct: always use context with timeout
func fetchURL(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

// Leak pattern 3: sync.WaitGroup never Done
// Wrong: panic before wg.Done()
func processBatch(items []Item) {
    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            process(item) // If this panics, wg.Done() never called
            wg.Done()     // Never called on panic!
        }(item)
    }
    wg.Wait() // Blocks forever if any goroutine panicked
}

// Correct: defer wg.Done()
func processBatch(items []Item) {
    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done() // Always called, even on panic
            process(item)
        }(item)
    }
    wg.Wait()
}

// Testing for leaks using the new profile
func TestNoGoroutineLeaks(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run code under test
    svc := NewService()
    ctx, cancel := context.WithCancel(context.Background())
    go svc.Run(ctx)

    time.Sleep(100 * time.Millisecond)
    cancel()
    time.Sleep(100 * time.Millisecond) // Allow goroutines to exit

    after := runtime.NumGoroutine()
    if after > before+1 { // +1 tolerance for Go runtime goroutines
        var buf bytes.Buffer
        pprof.Lookup("goroutineleak").WriteTo(&buf, 1)
        t.Errorf("goroutine count grew from %d to %d:\\n%s", before, after, buf.String())
    }
}
\`\`\`

---
`;
