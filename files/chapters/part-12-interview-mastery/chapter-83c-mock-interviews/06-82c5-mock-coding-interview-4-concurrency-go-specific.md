## 83C.5 Mock Coding Interview 4: Concurrency (Go-specific)

### Interviewer Briefing

**Company style:** Go-focused team interview (Uber, Cloudflare, Docker, or any company with heavy Go usage). This interview specifically evaluates Go concurrency expertise. The problems require goroutines, channels, and synchronization primitives. This is where Go candidates differentiate themselves.

**Level:** Senior Software Engineer / Staff Engineer

**Interview duration:** 45 minutes (two problems)

### Problem 1: Concurrent Rate Limiter (25 minutes)

*Read this to the candidate:*

> Implement a rate limiter that allows at most `n` requests per second. The rate limiter must be safe for concurrent use by multiple goroutines.
>
> Your implementation should support:
> - `NewRateLimiter(requestsPerSecond int) *RateLimiter` - creates a new rate limiter
> - `Allow() bool` - returns true if the request is allowed, false if rate limited
>
> Use the token bucket algorithm: tokens are added at a fixed rate, and each request consumes one token. The bucket has a maximum capacity equal to `requestsPerSecond`.
>
> **Requirements:**
> - Thread-safe (multiple goroutines calling `Allow` concurrently)
> - No busy-waiting
> - Accurate to within 10ms

### Expected Solution: Token Bucket Rate Limiter

Authentication establishes identity while authorization enforces what authenticated principals are permitted to do, conflating the two is a common source of security vulnerabilities. The following example demonstrates secure token issuance and validation with proper signature verification and claims inspection.

```go
package interview

import (
    "sync"
    "time"
)

// RateLimiter implements a token bucket rate limiter.
type RateLimiter struct {
    mu           sync.Mutex
    tokens       float64
    maxTokens    float64
    refillRate   float64 // tokens per nanosecond
    lastRefill   time.Time
}

// NewRateLimiter creates a rate limiter allowing n requests per second.
func NewRateLimiter(requestsPerSecond int) *RateLimiter {
    return &RateLimiter{
        tokens:     float64(requestsPerSecond),
        maxTokens:  float64(requestsPerSecond),
        refillRate: float64(requestsPerSecond) / float64(time.Second),
        lastRefill: time.Now(),
    }
}

// Allow returns true if the request is allowed under the rate limit.
func (rl *RateLimiter) Allow() bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(rl.lastRefill)
    rl.lastRefill = now

    // Refill tokens based on elapsed time
    rl.tokens += float64(elapsed) * rl.refillRate
    if rl.tokens > rl.maxTokens {
        rl.tokens = rl.maxTokens
    }

    if rl.tokens >= 1.0 {
        rl.tokens -= 1.0
        return true
    }

    return false
}
```

### Interviewer Notes for Problem 1

**Strong signals:**
- Chooses token bucket or sliding window - can explain trade-offs between algorithms
- Uses `sync.Mutex` correctly (lock/unlock with defer)
- Calculates token refill based on elapsed time rather than using a ticker goroutine (avoids resource leaks)
- Handles edge cases: first call, burst after idle period, rapid calls
- Can discuss why `float64` for tokens (fractional accumulation)

**Red flags:**
- Uses `time.Sleep` or busy-waiting
- Race condition in token check-and-decrement (not atomic)
- Leaks a goroutine (background ticker without stop mechanism)

### Problem 2: Parallel Web Crawler with Dedup (20 minutes)

*Read this to the candidate:*

> Implement a parallel web crawler that:
> 1. Starts from a seed URL
> 2. Fetches each page and extracts links
> 3. Crawls discovered links in parallel (up to `maxWorkers` concurrent fetches)
> 4. Never visits the same URL twice
> 5. Stops when all reachable URLs have been visited
> 6. Returns all visited URLs
>
> You are given this interface:

```go
type Fetcher interface {
    Fetch(url string) ([]string, error) // returns links found on the page
}
```
>
> Implement: `func Crawl(seed string, maxWorkers int, fetcher Fetcher) []string`
>
> **Constraints:**
> - Must be concurrent (use goroutines)
> - Must limit concurrency to maxWorkers
> - Must handle the termination condition correctly (no deadlocks, no premature exit)

### Expected Solution: Parallel Web Crawler

The reference implementation below is written to the standard an interviewer expects: correct complexity and idiomatic use of the standard library.

```go
package interview

import (
    "sync"
)

// Fetcher is the interface for fetching URLs.
type Fetcher interface {
    Fetch(url string) ([]string, error)
}

// Crawl performs a parallel web crawl starting from seed.
// It uses at most maxWorkers concurrent goroutines for fetching.
func Crawl(seed string, maxWorkers int, fetcher Fetcher) []string {
    var (
        mu      sync.Mutex
        visited = make(map[string]bool)
        wg      sync.WaitGroup
        sem     = make(chan struct{}, maxWorkers)
    )

    var crawl func(url string)
    crawl = func(url string) {
        defer wg.Done()

        // Acquire semaphore slot
        sem <- struct{}{}
        links, err := fetcher.Fetch(url)
        <-sem // Release semaphore slot

        if err != nil {
            return
        }

        mu.Lock()
        for _, link := range links {
            if !visited[link] {
                visited[link] = true
                wg.Add(1)
                go crawl(link)
            }
        }
        mu.Unlock()
    }

    // Start with seed URL
    mu.Lock()
    visited[seed] = true
    mu.Unlock()

    wg.Add(1)
    go crawl(seed)

    wg.Wait()

    // Collect results
    result := make([]string, 0, len(visited))
    for url := range visited {
        result = append(result, url)
    }
    return result
}
```

### Alternative Solution: Channel-based Architecture

Channels are Go's primary mechanism for communicating between goroutines, following the CSP (Communicating Sequential Processes) model. The example below shows correct channel creation, send/receive semantics, and how to avoid common deadlock scenarios.

```go
package interview

import (
    "sync"
)

// Fetcher is the interface for fetching URLs.
type Fetcher interface {
    Fetch(url string) ([]string, error)
}

// CrawlChannelBased uses channels instead of WaitGroup for coordination.
func CrawlChannelBased(seed string, maxWorkers int, fetcher Fetcher) []string {
    type crawlResult struct {
        url   string
        links []string
        err   error
    }

    visited := make(map[string]bool)
    urlChan := make(chan string, 1000)
    resultChan := make(chan crawlResult, 1000)
    done := make(chan struct{})

    // Start worker pool
    var wg sync.WaitGroup
    for i := 0; i < maxWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for url := range urlChan {
                links, err := fetcher.Fetch(url)
                resultChan <- crawlResult{url: url, links: links, err: err}
            }
        }()
    }

    // Close resultChan when all workers are done
    go func() {
        wg.Wait()
        close(resultChan)
    }()

    // Coordinator: manages visited set and dispatches new URLs
    go func() {
        pending := 0
        visited[seed] = true
        urlChan <- seed
        pending++

        for result := range resultChan {
            pending--
            if result.err == nil {
                for _, link := range result.links {
                    if !visited[link] {
                        visited[link] = true
                        urlChan <- link
                        pending++
                    }
                }
            }
            if pending == 0 {
                close(urlChan)
            }
        }
        close(done)
    }()

    <-done

    result := make([]string, 0, len(visited))
    for url := range visited {
        result = append(result, url)
    }
    return result
}
```

### Follow-up Questions

**Follow-up 1: "What happens if a Fetch call hangs forever?"**

*Strong answer:* "I'd add a context with timeout. Each Fetch call gets a `context.WithTimeout` of, say, 10 seconds. The Fetcher interface should accept a context: `Fetch(ctx context.Context, url string) ([]string, error)`. If the context deadline exceeds, the fetch returns an error and we move on. This prevents resource starvation from slow servers."

**Follow-up 2: "How would you add politeness (don't hammer the same host)?"**

*Strong answer:* "I'd create per-host rate limiters. Parse the host from each URL and maintain a `map[string]*RateLimiter` - using the rate limiter we just built. Before each fetch, call `Allow()` on the host's limiter. If denied, re-queue the URL with a small delay using `time.AfterFunc`. This is exactly how production crawlers like Colly work."

**Follow-up 3: "How would you handle graceful shutdown?"**

*Strong answer:* "Pass a `context.Context` to `Crawl`. Select on `ctx.Done()` alongside the work channels. When the context is canceled, drain pending work, wait for in-flight fetches to complete (with a deadline), and return partial results. The key is making sure we don't lose track of in-flight goroutines - the WaitGroup handles that."

### Scoring Rubric (Combined for both problems)

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Both solutions are correct, idiomatic Go, and race-condition-free. Uses appropriate sync primitives (mutex, WaitGroup, channels, semaphore). Handles termination correctly. Discusses trade-offs between mutex and channel approaches. Excellent follow-up answers. |
| **Hire** | Both solutions work. May have minor style issues. One solution may need a small fix when prompted. Good understanding of concurrency primitives. Handles most follow-ups. |
| **Lean Hire** | Rate limiter works but crawler has a subtle race condition or termination bug. Understands concepts but struggles with implementation. Limited follow-up depth. |
| **No Hire** | Code has race conditions, deadlocks, or goroutine leaks. Cannot reason about concurrent execution. Misuses channels or mutexes fundamentally. |


### Junior → FAANG: Go Concurrency Mock Interview Fundamentals

Go concurrency interviews test your ability to coordinate goroutines correctly using channels, sync primitives, and context. Common patterns: pipeline (goroutines connected by channels for staged processing), fan-out/fan-in (multiple goroutines consuming from one channel, results merged into one), worker pool (fixed number of goroutines consuming from a work queue), and timeout/cancellation (context.WithTimeout or context.WithCancel). The most common mistake is writing a solution that works but has goroutine leaks: goroutines blocked forever because no one reads from their channel or because the context is canceled but they do not listen for it.

### Senior @ FAANG: Go Concurrency at the L5/L6 Bar: Correctness, Lifecycle, and Performance

At the L5/L6 level, the concurrency evaluation includes three dimensions: correctness (no races, no deadlocks, no goroutine leaks), lifecycle management (every goroutine has a clear termination condition and resource cleanup), and performance reasoning (does your concurrency actually help, given the overhead of channel synchronization and goroutine scheduling). Bar-raisers probe goroutine lifecycle by asking: 'what happens to this goroutine if the context is canceled during this operation?'. The correct answer describes the cancellation path explicitly, including which select case handles the context done signal and what cleanup happens before the goroutine returns. Performance reasoning includes knowing when not to use goroutines: for CPU-bound work with no I/O, GOMAXPROCS goroutines is the right number, and adding more adds scheduling overhead without adding throughput.

---
