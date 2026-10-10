## 10B.6 Goroutine Leak Profile (Go 1.26)

> **Go 1.27 update:** the `goroutineleak` profile described here is promoted to general availability in Go 1.27, exposed programmatically in `runtime/pprof` and served at `/debug/pprof/goroutineleak`. Everything below applies unchanged, minus the experimental caveats.

### The Problem with Goroutine Leaks

Before Go 1.26, detecting goroutine leaks required third-party packages like `goleak` or manual analysis of `runtime.NumGoroutine()` over time. The `goroutineleak` pprof profile (experimental in Go 1.26 behind `GOEXPERIMENT=goroutineleakprofile`, GA in Go 1.27) provides first-class detection of goroutines that can never run again. It performs a garbage-collector-style reachability analysis and reports goroutines blocked on synchronization primitives that no runnable goroutine can still reach. It catches the most common leak categories:

```go
// Types of goroutine leaks this profile detects:
// 1. Blocked sending or receiving on a channel no live goroutine references
// 2. Blocked in select where no case can ever become ready
// 3. Blocked on sync.WaitGroup.Wait or sync.Cond.Wait that nothing can signal
// 4. Blocked on a mutex or semaphore that nothing reachable can release
// 5. Cycles of goroutines all waiting on each other (partial deadlock)
// Note: goroutines blocked in network I/O are not detectable this way,
// use contexts and timeouts for those.
```

### Using the Goroutine Leak Profile

The goroutine leak profile endpoint lists goroutines the runtime has determined can never be unblocked. The output format matches other pprof profiles and can be analyzed with `go tool pprof`.

```go
// Expose via pprof HTTP endpoint (standard)
// GET /debug/pprof/goroutineleak
// The runtime runs the leak analysis and reports provably stuck goroutines

// Programmatic access:
import "runtime/pprof"

func dumpGoroutineLeaks(w io.Writer) error {
    return pprof.Lookup("goroutineleak").WriteTo(w, 1) // debug=1 for detailed output
}

// In tests: detect leaks in test suite
func TestMain(m *testing.M) {
    code := m.Run()
    // Check for goroutine leaks after all tests
    if err := checkGoroutineLeaks(); err != nil {
        fmt.Fprintf(os.Stderr, "goroutine leaks detected: %v\n", err)
        os.Exit(1)
    }
    os.Exit(code)
}

func checkGoroutineLeaks() error {
    // Wait briefly for goroutines to clean up
    time.Sleep(100 * time.Millisecond)

    p := pprof.Lookup("goroutineleak")
    if n := p.Count(); n > 0 {
        var buf bytes.Buffer
        p.WriteTo(&buf, 1)
        return fmt.Errorf("%d leaked goroutines:\n%s", n, buf.String())
    }
    return nil
}
```

### Common Goroutine Leak Patterns and Fixes

Most goroutine leaks fall into three categories: goroutines waiting on channels that never close, goroutines blocked on calls without timeouts, and goroutines waiting on context that is never canceled.

```go
// Leak pattern 1: Goroutine blocked on channel, context not propagated
// Wrong:
func processItems(items []Item) error {
    results := make(chan Result)
    for _, item := range items {
        go func(item Item) {
            results <- process(item) // Blocks if nobody reads
        }(item)
    }
    for range items {
        r := <-results
        if r.Err != nil {
            return r.Err // Early return: remaining goroutines block forever
        }
    }
    return nil
}

// Correct: use context for cancellation
func processItems(ctx context.Context, items []Item) error {
    results := make(chan Result, len(items)) // Buffered: goroutines never block
    errCh := make(chan error, 1)

    for _, item := range items {
        go func(item Item) {
            select {
            case <-ctx.Done():
                return // Goroutine exits if context canceled
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

// Leak pattern 3: sync.WaitGroup Done skipped on an early return
// Wrong: an early return jumps past wg.Done(), so wg.Wait blocks forever
func processBatch(items []Item) {
    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            if !valid(item) {
                return // wg.Done() below is skipped
            }
            process(item)
            wg.Done() // Not reached when the guard above returns
        }(item)
    }
    wg.Wait() // Blocks forever if any goroutine took the early return
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
        t.Errorf("goroutine count grew from %d to %d:\n%s", before, after, buf.String())
    }
}
```

---
