export default `## 11.15 Exercises with Solutions

### Exercise 1: Build a Pipeline

**Problem:** Create a pipeline that:
1. Generates numbers 1-100
2. Filters to keep only multiples of 3
3. Squares each number
4. Sums all values

**Solution:**

Each pipeline stage is a function that launches a goroutine, returns an output channel, and respects context cancellation. The \`reduce\` stage consumes the final channel synchronously. Composing these stages in \`main\` reads left-to-right as a data flow: generate, filter, transform, reduce.

\`\`\`go
package main

import (
    "context"
    "fmt"
)

func generate(ctx context.Context, start, end int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for i := start; i <= end; i++ {
            select {
            case <-ctx.Done():
                return
            case out <- i:
            }
        }
    }()
    return out
}

func filter(ctx context.Context, in <-chan int, predicate func(int) bool) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for v := range in {
            if predicate(v) {
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }
    }()
    return out
}

func transform(ctx context.Context, in <-chan int, fn func(int) int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for v := range in {
            select {
            case <-ctx.Done():
                return
            case out <- fn(v):
            }
        }
    }()
    return out
}

func reduce(ctx context.Context, in <-chan int, initial int, fn func(acc, val int) int) int {
    result := initial
    for v := range in {
        select {
        case <-ctx.Done():
            return result
        default:
            result = fn(result, v)
        }
    }
    return result
}

func main() {
    ctx := context.Background()

    // Build pipeline
    nums := generate(ctx, 1, 100)
    multOf3 := filter(ctx, nums, func(n int) bool { return n%3 == 0 })
    squared := transform(ctx, multOf3, func(n int) int { return n * n })
    sum := reduce(ctx, squared, 0, func(acc, val int) int { return acc + val })

    fmt.Printf("Sum of squares of multiples of 3 from 1-100: %d\\n", sum)
    // Output: 58155
}
\`\`\`

### Exercise 2: Concurrent URL Fetcher

**Problem:** Implement a URL fetcher that:
- Fetches multiple URLs concurrently
- Limits concurrent requests to N
- Returns the fastest response
- Handles timeouts

**Solution:**

The \`fetchFirst\` function launches one goroutine per URL, gates concurrency with a semaphore channel, and returns the first successful response. A \`context.WithTimeout\` wrapping the caller's context enforces the overall deadline. Buffered result channels prevent goroutine leaks when a result arrives after the caller has already returned.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "time"
)

type Response struct {
    URL      string
    Body     []byte
    Duration time.Duration
    Error    error
}

func fetchFirst(ctx context.Context, urls []string, maxConcurrent int, timeout time.Duration) (*Response, error) {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    sem := make(chan struct{}, maxConcurrent)
    results := make(chan *Response, len(urls))

    for _, url := range urls {
        go func(u string) {
            // Acquire semaphore
            select {
            case <-ctx.Done():
                return
            case sem <- struct{}{}:
                defer func() { <-sem }()
            }

            start := time.Now()
            resp, err := fetchWithContext(ctx, u)
            results <- &Response{
                URL:      u,
                Body:     resp,
                Duration: time.Since(start),
                Error:    err,
            }
        }(url)
    }

    // Return first successful response
    var lastErr error
    for i := 0; i < len(urls); i++ {
        select {
        case <-ctx.Done():
            return nil, fmt.Errorf("timeout: %w", ctx.Err())
        case r := <-results:
            if r.Error == nil {
                return r, nil
            }
            lastErr = r.Error
        }
    }

    return nil, fmt.Errorf("all requests failed: %w", lastErr)
}

func fetchWithContext(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}

func main() {
    urls := []string{
        "https://httpbin.org/delay/1",
        "https://httpbin.org/delay/2",
        "https://httpbin.org/get",
    }

    ctx := context.Background()
    resp, err := fetchFirst(ctx, urls, 3, 5*time.Second)
    if err != nil {
        fmt.Printf("Error: %v\\n", err)
        return
    }

    fmt.Printf("Fastest response from %s in %v\\n", resp.URL, resp.Duration)
}
\`\`\`

### Exercise 3: Goroutine Leak Detector

**Problem:** Write a function that:
- Takes a function as input
- Runs it and detects if it leaks goroutines
- Returns the number of leaked goroutines

**Solution:**

\`DetectLeaks\` snapshots \`runtime.NumGoroutine()\` before and after running the target function, with a configurable stabilization delay and GC cycle in between. If the count is higher afterward, it captures all goroutine stack traces to help identify exactly which goroutine leaked and where it is blocked.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "time"
)

// LeakResult contains leak detection results
type LeakResult struct {
    Leaked          bool
    LeakedCount     int
    BeforeCount     int
    AfterCount      int
    StackTraces     string
}

// DetectLeaks runs a function and checks for goroutine leaks
func DetectLeaks(fn func(), stabilizationTime time.Duration) LeakResult {
    // Force GC and get baseline
    runtime.GC()
    time.Sleep(10 * time.Millisecond)
    before := runtime.NumGoroutine()

    // Run the function
    fn()

    // Wait for goroutines to exit
    time.Sleep(stabilizationTime)
    runtime.GC()
    time.Sleep(10 * time.Millisecond)

    after := runtime.NumGoroutine()

    result := LeakResult{
        BeforeCount: before,
        AfterCount:  after,
    }

    if after > before {
        result.Leaked = true
        result.LeakedCount = after - before

        // Capture stack traces
        buf := make([]byte, 1<<20)
        n := runtime.Stack(buf, true)
        result.StackTraces = string(buf[:n])
    }

    return result
}

// Example functions to test
func leakyFunction() {
    ch := make(chan int)
    go func() {
        ch <- 1  // Blocks forever, no receiver
    }()
}

func cleanFunction() {
    ch := make(chan int, 1)
    go func() {
        ch <- 1  // Buffered, doesn't block
    }()
    <-ch
}

func main() {
    fmt.Println("Testing leaky function:")
    result := DetectLeaks(leakyFunction, 100*time.Millisecond)
    fmt.Printf("  Leaked: %v, Count: %d\\n", result.Leaked, result.LeakedCount)

    fmt.Println("\\nTesting clean function:")
    result = DetectLeaks(cleanFunction, 100*time.Millisecond)
    fmt.Printf("  Leaked: %v, Count: %d\\n", result.Leaked, result.LeakedCount)
}
\`\`\`

### Senior at FAANG Track

4. **Race detector discipline.** Audit your team's test suite. Determine how many packages run with \`-race\` in CI. If not all, add it. Document the runtime cost and the catches over one month. Present the findings.

5. **goleak rollout.** Integrate \`go.uber.org/goleak\` into TestMain for every package in one service. Document the leaks it catches during rollout. Fix each one. Write a retrospective.

6. **Concurrency code-review checklist.** Based on this chapter, write a one-page checklist reviewers apply to any PR touching concurrent code. Pilot it for one month. Measure PR-approval time before and after. Refine.

7. **Goroutine metric dashboard.** For one production service, wire up Prometheus metrics for goroutine count, goroutine lifetime, and panic rate. Build a Grafana dashboard. Set alerts. Document the baseline values. Write an on-call runbook for the alerts.

### Staff / Principal Track

8. **Org-wide context propagation audit.** Audit five microservices. Identify every function that does I/O without a context parameter. Propose a migration plan that does not require a flag-day rewrite. Drive the migration over two quarters.

9. **Shared concurrent helpers package.** Design and ship a shared internal Go package for your org containing: \`safeGo\` (recover boundary), \`BoundedPool\`, \`RetryWithBackoff\`, \`Memoize\` (with \`singleflight\`), and a handful of other common primitives. Get at least three teams to adopt it. Measure code-review time for concurrent PRs before and after.

10. **Concurrency design doc template.** Author a template the team uses for every service's concurrency design. Include the eight-item checklist from the interview questions. Make it mandatory for any design review that involves concurrent code.

11. **Incident postmortem: the concurrent bug.** Pick a past concurrency incident at your org. Write a deep postmortem that traces the bug from its introduction through detection to resolution. Identify the three systemic fixes (tooling, process, culture) that would have prevented it. Socialise the postmortem. Drive the fixes.

12. **Scale-threshold decision document.** For one service in your org, document the scale thresholds at which the current concurrency architecture breaks down: request rate, memory, connection count, downstream capacity. Propose the next architecture. Estimate the headroom. This is the artifact that prevents the team from blindly scaling the current design past its breaking point.

13. **Go 1.26 experiment evaluation.** Enable \`GOEXPERIMENT=goroutineleakprofile\` in one canary production instance. Document the leaks it catches versus a baseline instance running without it. Recommend adoption or rejection with evidence. This is the kind of research principal engineers do to keep the org ahead of the language.

---
`;
