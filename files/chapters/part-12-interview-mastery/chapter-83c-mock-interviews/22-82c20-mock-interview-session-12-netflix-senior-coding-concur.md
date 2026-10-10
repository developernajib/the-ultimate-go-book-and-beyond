## 83C.20 Mock Interview Session 12: Netflix Senior Coding - Concurrent Web Crawler in Go

### Interviewer Briefing

**Company style:** Netflix. Senior Software Engineer. Netflix coding interviews for Go-focused roles emphasize concurrency, system design thinking within coding problems, and production-quality error handling. The interviewer expects the candidate to build a working, well-structured concurrent system - not just solve an algorithm. Netflix values "context, not control" - the candidate should demonstrate good judgment about concurrency patterns without needing to be told which pattern to use.

**Level:** Senior Software Engineer (L5 equivalent)

**Interview duration:** 45 minutes

**Key evaluation criteria:** Concurrency design, error handling, rate limiting, context cancellation, code organization, testing strategy.

### Problem Statement

*Read this to the candidate:*

> Build a concurrent web crawler in Go that:
>
> 1. Starts from a seed URL and crawls all pages within the same domain
> 2. Extracts and follows links from each page
> 3. Respects a configurable rate limit (e.g., max 10 requests per second)
> 4. Supports graceful shutdown via context cancellation
> 5. Returns a site map: a map of URL → list of URLs found on that page
> 6. Handles errors gracefully (timeouts, 404s, redirects)
> 7. Limits concurrent requests to a configurable maximum (e.g., 20)
> 8. Avoids revisiting URLs
>
> Design the solution with clean interfaces that could be tested without making real HTTP requests.
>
> **Constraints:**
> - Use only the Go standard library (plus `golang.org/x/net/html` for HTML parsing)
> - The crawler should be able to handle sites with 100,000+ pages
> - Memory usage should be bounded (don't store all page content in memory)

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[3:00] | Read & Design | Candidate reads the problem and sketches the architecture |
| [3:00]-[5:00] | Interface Design | Define the key interfaces and types |
| [5:00]-[10:00] | Core Types & Configuration | Crawler struct, options, URL frontier |
| [10:00]-[20:00] | Concurrency Architecture | Worker pool, rate limiter, visited set |
| [20:00]-[30:00] | Implementation | Core crawl loop with error handling |
| [30:00]-[38:00] | Link Extraction & Testing | HTML parsing, test strategy |
| [38:00]-[45:00] | Follow-ups & Refinements | Edge cases, improvements |

### Interviewer Script & Candidate Response

**[0:00] Interviewer:** *"Take a few minutes to read the problem. When you're ready, walk me through your design before coding."*

**[2:00] Candidate:** "This is a producer-consumer problem with bounded concurrency. Here's my design:

**Architecture:**
- A URL frontier (queue) holds URLs to be crawled
- A worker pool (bounded by max concurrency) pulls URLs from the frontier
- A rate limiter gates HTTP requests (token bucket or time.Ticker)
- A visited set (concurrent-safe) tracks already-crawled URLs
- Context cancellation propagates through all goroutines for graceful shutdown

**Key interfaces:**
- `Fetcher` - abstracts HTTP fetching (injectable for testing)
- `LinkExtractor` - abstracts HTML parsing (injectable for testing)
- These interfaces enable testing without real HTTP requests.

**Concurrency model:**
- One main goroutine manages the frontier and dispatches work
- N worker goroutines (configurable) process URLs
- Workers send discovered URLs back to the main goroutine via a channel
- Rate limiting uses `golang.org/x/time/rate.Limiter` - wait, you said standard library only. I'll use `time.Ticker` for rate limiting.

Actually, let me reconsider. A simpler model: use a semaphore (buffered channel) for concurrency limiting and a time.Ticker for rate limiting. Let me code this up."

**[3:00] Candidate starts with interface design:**

```go
package crawler

import (
    "context"
    "io"
    "net/url"
    "time"
)

// Fetcher abstracts HTTP fetching for testability.
type Fetcher interface {
    // Fetch retrieves the body of a URL. Caller must close the returned ReadCloser.
    Fetch(ctx context.Context, rawURL string) (io.ReadCloser, error)
}

// LinkExtractor abstracts link extraction from HTML for testability.
type LinkExtractor interface {
    // ExtractLinks parses HTML from the reader and returns all href links.
    ExtractLinks(body io.Reader, baseURL *url.URL) ([]string, error)
}

// Result represents the crawl result for a single page.
type Result struct {
    URL       string
    Links     []string
    Error     error
    Duration  time.Duration
    Timestamp time.Time
}

// SiteMap is the final output: URL → list of discovered links.
type SiteMap map[string][]string

// Config holds crawler configuration.
type Config struct {
    SeedURL        string
    MaxConcurrency int           // Max simultaneous requests
    RateLimit      int           // Max requests per second
    RequestTimeout time.Duration // Timeout per individual request
    MaxDepth       int           // Maximum crawl depth from seed (0 = unlimited)
    MaxPages       int           // Maximum total pages to crawl (0 = unlimited)
    UserAgent      string
}

// DefaultConfig returns a sensible default configuration.
func DefaultConfig(seedURL string) Config {
    return Config{
        SeedURL:        seedURL,
        MaxConcurrency: 20,
        RateLimit:      10,
        RequestTimeout: 10 * time.Second,
        MaxDepth:       0,
        MaxPages:       0,
        UserAgent:      "GoCrawler/1.0",
    }
}
```

**[7:00] Candidate continues with the core crawler:**

```go
// Crawler orchestrates concurrent web crawling.
type Crawler struct {
    config    Config
    fetcher   Fetcher
    extractor LinkExtractor

    visited   map[string]bool
    frontier  []crawlItem
    mu        sync.Mutex

    results   SiteMap
    resultsMu sync.Mutex

    semaphore chan struct{}    // Bounds concurrency
    rateTick  *time.Ticker    // Rate limiting

    metrics   CrawlMetrics
}

// CrawlMetrics tracks operational statistics.
type CrawlMetrics struct {
    PagesVisited  int64
    PagesErrored  int64
    LinksFound    int64
    TotalDuration time.Duration
}

// New creates a new Crawler with the given configuration.
func New(config Config, fetcher Fetcher, extractor LinkExtractor) (*Crawler, error) {
    if config.MaxConcurrency <= 0 {
        return nil, fmt.Errorf("max concurrency must be positive, got %d", config.MaxConcurrency)
    }
    if config.RateLimit <= 0 {
        return nil, fmt.Errorf("rate limit must be positive, got %d", config.RateLimit)
    }

    return &Crawler{
        config:    config,
        fetcher:   fetcher,
        extractor: extractor,
        visited:   make(map[string]bool),
        results:   make(SiteMap),
        semaphore: make(chan struct{}, config.MaxConcurrency),
        rateTick:  time.NewTicker(time.Second / time.Duration(config.RateLimit)),
    }, nil
}

// crawlItem represents a URL to be crawled, with its depth from the seed.
type crawlItem struct {
    url   string
    depth int
}

// CrawlInitial demonstrates the initial attempt at the crawling loop (with outstanding counter).
// It respects context cancellation for graceful shutdown.
func (c *Crawler) CrawlInitial(ctx context.Context) (SiteMap, CrawlMetrics, error) {
    defer c.rateTick.Stop()

    seedURL, err := url.Parse(c.config.SeedURL)
    if err != nil {
        return nil, CrawlMetrics{}, fmt.Errorf("invalid seed URL: %w", err)
    }

    // Normalize the seed URL
    seedNormalized := normalizeURL(seedURL)
    targetDomain := seedURL.Hostname()

    // Channel for URLs discovered by workers
    discovered := make(chan crawlItem, c.config.MaxConcurrency*10)

    // WaitGroup tracks active workers
    var wg sync.WaitGroup

    // Seed the frontier
    discovered <- crawlItem{url: seedNormalized, depth: 0}
    outstanding := 1 // Track items in-flight or in the channel

    // Drain loop: processes discovered URLs and dispatches workers
    for outstanding > 0 {
        select {
        case <-ctx.Done():
            // Graceful shutdown: wait for in-flight workers to complete
            wg.Wait()
            return c.results, c.metrics, ctx.Err()

        case item := <-discovered:
            outstanding--

            // Check if already visited
            c.mu.Lock()
            if c.visited[item.url] {
                c.mu.Unlock()
                continue
            }
            c.visited[item.url] = true
            c.mu.Unlock()

            // Check max pages limit
            if c.config.MaxPages > 0 && int(c.metrics.PagesVisited) >= c.config.MaxPages {
                continue
            }

            // Check max depth limit
            if c.config.MaxDepth > 0 && item.depth > c.config.MaxDepth {
                continue
            }

            // Rate limit: wait for the next tick
            select {
            case <-ctx.Done():
                wg.Wait()
                return c.results, c.metrics, ctx.Err()
            case <-c.rateTick.C:
                // Proceed
            }

            // Acquire semaphore (concurrency limit)
            select {
            case <-ctx.Done():
                wg.Wait()
                return c.results, c.metrics, ctx.Err()
            case c.semaphore <- struct{}{}:
                // Acquired
            }

            wg.Add(1)
            go func(item crawlItem) {
                defer wg.Done()
                defer func() { <-c.semaphore }() // Release semaphore

                links, crawlErr := c.crawlPage(ctx, item.url, targetDomain)

                // Store result
                c.resultsMu.Lock()
                if crawlErr != nil {
                    c.results[item.url] = nil // Mark as visited but errored
                    c.metrics.PagesErrored++
                } else {
                    c.results[item.url] = links
                    c.metrics.PagesVisited++
                    c.metrics.LinksFound += int64(len(links))
                }
                c.resultsMu.Unlock()

                // Enqueue discovered links
                for _, link := range links {
                    c.mu.Lock()
                    alreadyVisited := c.visited[link]
                    c.mu.Unlock()

                    if !alreadyVisited {
                        select {
                        case discovered <- crawlItem{url: link, depth: item.depth + 1}:
                            c.mu.Lock()
                            outstanding++ // This is a race - see note below
                            c.mu.Unlock()
                        case <-ctx.Done():
                            return
                        }
                    }
                }
            }(item)
        }
    }

    // Wait for all workers to finish
    wg.Wait()

    return c.results, c.metrics, nil
}
```

**[15:00] Interviewer:** *"I see a potential issue with the `outstanding` counter - it's accessed from both the main goroutine and the worker goroutines. How would you fix that?"*

**[15:30] Candidate:** "You're right - that's a race condition. Let me redesign the coordination mechanism. Instead of tracking `outstanding`, I'll use a different pattern: workers send results (including discovered URLs) back through a single channel, and the main loop processes everything sequentially:

```go
// crawlResult is sent from workers back to the coordinator.
type crawlResult struct {
    url           string
    links         []string
    err           error
    discoveredURLs []crawlItem
}

// Crawl starts the crawling process with a clean coordination model.
// The main goroutine is the sole coordinator - no shared mutable state.
func (c *Crawler) Crawl(ctx context.Context) (SiteMap, CrawlMetrics, error) {
    defer c.rateTick.Stop()

    seedURL, err := url.Parse(c.config.SeedURL)
    if err != nil {
        return nil, CrawlMetrics{}, fmt.Errorf("invalid seed URL: %w", err)
    }

    targetDomain := seedURL.Hostname()
    seedNormalized := normalizeURL(seedURL)

    // Results channel: workers send results here
    resultsCh := make(chan crawlResult, c.config.MaxConcurrency)

    // Frontier: URLs waiting to be crawled
    frontier := []crawlItem{{url: seedNormalized, depth: 0}}
    visited := make(map[string]bool)
    visited[seedNormalized] = true

    siteMap := make(SiteMap)
    var metrics CrawlMetrics

    inFlight := 0

    for len(frontier) > 0 || inFlight > 0 {
        // Decide whether to dispatch a new task or collect a result
        var dispatchCh chan<- struct{} // nil if nothing to dispatch
        var item crawlItem

        if len(frontier) > 0 {
            item = frontier[0]
        }

        select {
        case <-ctx.Done():
            // Drain in-flight results
            for inFlight > 0 {
                <-resultsCh
                inFlight--
            }
            return siteMap, metrics, ctx.Err()

        case result := <-resultsCh:
            inFlight--

            // Process result
            if result.err != nil {
                siteMap[result.url] = nil
                metrics.PagesErrored++
            } else {
                siteMap[result.url] = result.links
                metrics.PagesVisited++
                metrics.LinksFound += int64(len(result.links))
            }

            // Add newly discovered URLs to frontier
            for _, discovered := range result.discoveredURLs {
                if !visited[discovered.url] {
                    visited[discovered.url] = true
                    frontier = append(frontier, discovered)
                }
            }

        default:
            // Try to dispatch if we have work and capacity
            if len(frontier) == 0 {
                // No work to dispatch, must wait for results
                result := <-resultsCh
                inFlight--
                if result.err != nil {
                    siteMap[result.url] = nil
                    metrics.PagesErrored++
                } else {
                    siteMap[result.url] = result.links
                    metrics.PagesVisited++
                    metrics.LinksFound += int64(len(result.links))
                }
                for _, discovered := range result.discoveredURLs {
                    if !visited[discovered.url] {
                        visited[discovered.url] = true
                        frontier = append(frontier, discovered)
                    }
                }
                continue
            }

            // Check max pages
            if c.config.MaxPages > 0 && int(metrics.PagesVisited+metrics.PagesErrored) >= c.config.MaxPages {
                frontier = frontier[:0]
                continue
            }

            // Check max depth
            if c.config.MaxDepth > 0 && frontier[0].depth > c.config.MaxDepth {
                frontier = frontier[1:]
                continue
            }

            // Rate limit
            select {
            case <-ctx.Done():
                for inFlight > 0 {
                    <-resultsCh
                    inFlight--
                }
                return siteMap, metrics, ctx.Err()
            case <-c.rateTick.C:
                // Proceed
            }

            // Acquire semaphore
            select {
            case <-ctx.Done():
                for inFlight > 0 {
                    <-resultsCh
                    inFlight--
                }
                return siteMap, metrics, ctx.Err()
            case c.semaphore <- struct{}{}:
                // Acquired
            }

            // Pop from frontier and dispatch
            item = frontier[0]
            frontier = frontier[1:]
            inFlight++

            _ = dispatchCh // suppress unused variable

            go func(item crawlItem) {
                defer func() { <-c.semaphore }()

                links, crawlErr := c.crawlPage(ctx, item.url, targetDomain)

                // Build list of URLs to add to frontier
                var newURLs []crawlItem
                for _, link := range links {
                    newURLs = append(newURLs, crawlItem{url: link, depth: item.depth + 1})
                }

                resultsCh <- crawlResult{
                    url:            item.url,
                    links:          links,
                    err:            crawlErr,
                    discoveredURLs: newURLs,
                }
            }(item)
        }
    }

    return siteMap, metrics, nil
}
```

The key improvement: the `visited` map and `frontier` slice are only accessed by the main goroutine. Workers communicate exclusively through the `resultsCh` channel. No shared mutable state means no race conditions."

**[20:00] Interviewer:** *"Good redesign. Now implement the `crawlPage` function and the link extractor."*

**[20:30] Candidate:**

```go
// crawlPage fetches a single page and extracts same-domain links.
func (c *Crawler) crawlPage(ctx context.Context, rawURL string, targetDomain string) ([]string, error) {
    // Create a per-request context with timeout
    reqCtx, cancel := context.WithTimeout(ctx, c.config.RequestTimeout)
    defer cancel()

    body, err := c.fetcher.Fetch(reqCtx, rawURL)
    if err != nil {
        return nil, fmt.Errorf("fetching %s: %w", rawURL, err)
    }
    defer body.Close()

    base, err := url.Parse(rawURL)
    if err != nil {
        return nil, fmt.Errorf("parsing base URL %s: %w", rawURL, err)
    }

    allLinks, err := c.extractor.ExtractLinks(body, base)
    if err != nil {
        return nil, fmt.Errorf("extracting links from %s: %w", rawURL, err)
    }

    // Filter to same-domain links only
    var sameDomainLinks []string
    for _, link := range allLinks {
        parsed, err := url.Parse(link)
        if err != nil {
            continue
        }
        if parsed.Hostname() == targetDomain {
            normalized := normalizeURL(parsed)
            sameDomainLinks = append(sameDomainLinks, normalized)
        }
    }

    return sameDomainLinks, nil
}

// HTTPFetcher implements Fetcher using net/http.
type HTTPFetcher struct {
    client    *http.Client
    userAgent string
}

// NewHTTPFetcher creates a production HTTP fetcher with sensible defaults.
func NewHTTPFetcher(userAgent string, timeout time.Duration) *HTTPFetcher {
    return &HTTPFetcher{
        client: &http.Client{
            Timeout: timeout,
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                if len(via) >= 5 {
                    return fmt.Errorf("too many redirects (max 5)")
                }
                return nil
            },
        },
        userAgent: userAgent,
    }
}

// Fetch retrieves the body of a URL.
func (f *HTTPFetcher) Fetch(ctx context.Context, rawURL string) (io.ReadCloser, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    req.Header.Set("User-Agent", f.userAgent)
    req.Header.Set("Accept", "text/html")

    resp, err := f.client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }

    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        resp.Body.Close()
        return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, rawURL)
    }

    // Check content type - only parse HTML
    contentType := resp.Header.Get("Content-Type")
    if !strings.Contains(contentType, "text/html") {
        resp.Body.Close()
        return nil, fmt.Errorf("non-HTML content type: %s", contentType)
    }

    // Limit response body to 10 MB to prevent memory issues
    limited := io.LimitReader(resp.Body, 10*1024*1024)
    return io.NopCloser(limited), nil
}

// HTMLLinkExtractor implements LinkExtractor using golang.org/x/net/html.
type HTMLLinkExtractor struct{}

// ExtractLinks parses HTML and returns all href links, resolved against the base URL.
func (e *HTMLLinkExtractor) ExtractLinks(body io.Reader, baseURL *url.URL) ([]string, error) {
    tokenizer := html.NewTokenizer(body)
    var links []string
    seen := make(map[string]bool) // Deduplicate within a single page

    for {
        tt := tokenizer.Next()
        switch tt {
        case html.ErrorToken:
            err := tokenizer.Err()
            if err == io.EOF {
                return links, nil
            }
            return links, fmt.Errorf("tokenizer error: %w", err)

        case html.StartTagToken, html.SelfClosingTagToken:
            token := tokenizer.Token()
            if token.Data != "a" {
                continue
            }

            for _, attr := range token.Attr {
                if attr.Key != "href" {
                    continue
                }

                href := strings.TrimSpace(attr.Val)
                if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "mailto:") {
                    continue
                }

                // Resolve relative URLs against the base
                resolved, err := baseURL.Parse(href)
                if err != nil {
                    continue
                }

                normalized := normalizeURL(resolved)
                if !seen[normalized] {
                    seen[normalized] = true
                    links = append(links, normalized)
                }
            }
        }
    }
}

// normalizeURL produces a canonical form of a URL for deduplication.
func normalizeURL(u *url.URL) string {
    // Remove fragment
    u.Fragment = ""
    // Remove trailing slash (except for root path)
    if u.Path != "/" {
        u.Path = strings.TrimRight(u.Path, "/")
    }
    // Lowercase scheme and host
    u.Scheme = strings.ToLower(u.Scheme)
    u.Host = strings.ToLower(u.Host)

    return u.String()
}
```

**[30:00] Interviewer:** *"How would you test this without making real HTTP requests?"*

**[30:30] Candidate:** "The interfaces make this straightforward. I'd create mock implementations:

```go
// MockFetcher implements Fetcher for testing.
type MockFetcher struct {
    pages map[string]string // URL → HTML content
    mu    sync.Mutex
    calls []string // Track which URLs were fetched
}

func NewMockFetcher(pages map[string]string) *MockFetcher {
    return &MockFetcher{pages: pages}
}

func (f *MockFetcher) Fetch(ctx context.Context, rawURL string) (io.ReadCloser, error) {
    // Check context cancellation
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    default:
    }

    f.mu.Lock()
    f.calls = append(f.calls, rawURL)
    content, ok := f.pages[rawURL]
    f.mu.Unlock()

    if !ok {
        return nil, fmt.Errorf("HTTP 404 for %s", rawURL)
    }

    return io.NopCloser(strings.NewReader(content)), nil
}

func (f *MockFetcher) CallCount() int {
    f.mu.Lock()
    defer f.mu.Unlock()
    return len(f.calls)
}

// Test: basic crawling with linked pages
func TestCrawl_BasicSiteMap(t *testing.T) {
    pages := map[string]string{
        "https://example.com": `<html><body>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
        </body></html>`,
        "https://example.com/about": `<html><body>
            <a href="/">Home</a>
            <a href="/team">Team</a>
        </body></html>`,
        "https://example.com/contact": `<html><body>
            <a href="/">Home</a>
        </body></html>`,
        "https://example.com/team": `<html><body>
            <a href="/about">About</a>
        </body></html>`,
    }

    fetcher := NewMockFetcher(pages)
    extractor := &HTMLLinkExtractor{}
    config := DefaultConfig("https://example.com")
    config.MaxConcurrency = 2
    config.RateLimit = 100 // Fast for tests

    c, err := New(config, fetcher, extractor)
    if err != nil {
        t.Fatalf("creating crawler: %v", err)
    }

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    siteMap, metrics, err := c.Crawl(ctx)
    if err != nil {
        t.Fatalf("crawl error: %v", err)
    }

    // Verify all pages were visited
    if len(siteMap) != 4 {
        t.Errorf("expected 4 pages, got %d", len(siteMap))
    }

    // Verify link extraction
    homeLinks := siteMap["https://example.com"]
    if len(homeLinks) != 2 {
        t.Errorf("expected 2 links from home page, got %d", len(homeLinks))
    }

    // Verify no duplicate visits
    if fetcher.CallCount() != 4 {
        t.Errorf("expected 4 fetches (no duplicates), got %d", fetcher.CallCount())
    }

    // Verify metrics
    if metrics.PagesVisited != 4 {
        t.Errorf("expected 4 pages visited, got %d", metrics.PagesVisited)
    }
}

// Test: context cancellation stops crawling
func TestCrawl_ContextCancellation(t *testing.T) {
    // Create a large site that would take a long time to crawl
    pages := make(map[string]string)
    for i := 0; i < 1000; i++ {
        pageURL := fmt.Sprintf("https://example.com/page/%d", i)
        nextPage := fmt.Sprintf("/page/%d", i+1)
        pages[pageURL] = fmt.Sprintf(`<html><body><a href="%s">Next</a></body></html>`, nextPage)
    }

    fetcher := NewMockFetcher(pages)
    extractor := &HTMLLinkExtractor{}
    config := DefaultConfig("https://example.com/page/0")
    config.MaxConcurrency = 5
    config.RateLimit = 100

    c, err := New(config, fetcher, extractor)
    if err != nil {
        t.Fatalf("creating crawler: %v", err)
    }

    // Cancel after a short time
    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    _, metrics, err := c.Crawl(ctx)
    if err != context.DeadlineExceeded {
        t.Errorf("expected DeadlineExceeded, got %v", err)
    }

    // Should have crawled some but not all pages
    if metrics.PagesVisited >= 1000 {
        t.Error("expected partial crawl, but all pages were visited")
    }
    if metrics.PagesVisited == 0 {
        t.Error("expected at least some pages to be visited")
    }
}

// Test: rate limiting is respected
func TestCrawl_RateLimiting(t *testing.T) {
    pages := make(map[string]string)
    for i := 0; i < 20; i++ {
        pageURL := fmt.Sprintf("https://example.com/page/%d", i)
        var links string
        for j := 0; j < 20; j++ {
            links += fmt.Sprintf(`<a href="/page/%d">Page %d</a>`, j, j)
        }
        pages[pageURL] = fmt.Sprintf(`<html><body>%s</body></html>`, links)
    }

    fetcher := NewMockFetcher(pages)
    extractor := &HTMLLinkExtractor{}
    config := DefaultConfig("https://example.com/page/0")
    config.MaxConcurrency = 20
    config.RateLimit = 5 // 5 requests per second

    c, err := New(config, fetcher, extractor)
    if err != nil {
        t.Fatalf("creating crawler: %v", err)
    }

    ctx := context.Background()
    start := time.Now()
    _, metrics, _ := c.Crawl(ctx)
    duration := time.Since(start)

    // 20 pages at 5/sec should take at least 3.5 seconds
    expectedMinDuration := time.Duration(float64(metrics.PagesVisited-1)/5.0*1000) * time.Millisecond
    if duration < expectedMinDuration {
        t.Errorf("rate limit violated: crawled %d pages in %v, expected at least %v",
            metrics.PagesVisited, duration, expectedMinDuration)
    }
}

// Test: external domains are not followed
func TestCrawl_SameDomainOnly(t *testing.T) {
    pages := map[string]string{
        "https://example.com": `<html><body>
            <a href="/about">Internal</a>
            <a href="https://external.com/page">External</a>
            <a href="https://other.com">Other External</a>
        </body></html>`,
        "https://example.com/about": `<html><body>
            <a href="/">Home</a>
        </body></html>`,
    }

    fetcher := NewMockFetcher(pages)
    extractor := &HTMLLinkExtractor{}
    config := DefaultConfig("https://example.com")
    config.RateLimit = 100

    c, err := New(config, fetcher, extractor)
    if err != nil {
        t.Fatalf("creating crawler: %v", err)
    }

    siteMap, _, _ := c.Crawl(context.Background())

    // Should only visit example.com pages
    if len(siteMap) != 2 {
        t.Errorf("expected 2 pages (same domain only), got %d", len(siteMap))
    }

    // External URLs should not be in the site map
    if _, ok := siteMap["https://external.com/page"]; ok {
        t.Error("external domain should not be crawled")
    }
}
```

**[38:00] Interviewer:** *"Good test suite. Two follow-up questions. First, how would you make this crawler resumable - so if it crashes at page 50,000 of 100,000, it can resume without re-crawling?"*

**[38:30] Candidate:** "I'd add a persistence layer. Two options:

**Option 1: Checkpoint-based (simpler):** Periodically write the entire `visited` set and `frontier` to disk (JSON or gob encoding). On startup, check for a checkpoint file and resume from there.

**Option 2: WAL-based (more durable):** Write every state change (URL visited, URL discovered) to an append-only log file. On startup, replay the log to reconstruct state. This is more durable - a crash during a checkpoint in Option 1 could lose the checkpoint, but the WAL captures every operation.

```go
// Checkpoint writes the current crawl state to disk for resumability.
type Checkpoint struct {
    Visited  map[string]bool  `json:"visited"`
    Frontier []crawlItem      `json:"frontier"`
    SiteMap  SiteMap          `json:"site_map"`
    Metrics  CrawlMetrics     `json:"metrics"`
}

func (c *Crawler) saveCheckpoint(path string) error {
    cp := Checkpoint{
        Visited:  c.visited,
        Frontier: c.frontier,
        SiteMap:  c.results,
        Metrics:  c.metrics,
    }

    // Write to temp file, then rename (atomic on most filesystems)
    tmpPath := path + ".tmp"
    f, err := os.Create(tmpPath)
    if err != nil {
        return fmt.Errorf("creating checkpoint file: %w", err)
    }

    if err := json.NewEncoder(f).Encode(cp); err != nil {
        f.Close()
        return fmt.Errorf("encoding checkpoint: %w", err)
    }

    if err := f.Close(); err != nil {
        return fmt.Errorf("closing checkpoint: %w", err)
    }

    return os.Rename(tmpPath, path)
}
```

I'd save a checkpoint every 1000 pages or every 60 seconds, whichever comes first."

**[40:00] Interviewer:** *"Second follow-up: how would you handle politeness - robots.txt and crawl-delay?"*

**[40:30] Candidate:** "I'd add a robots.txt parser as a middleware layer:

1. Before crawling any page on a domain, fetch and parse `/robots.txt`
2. Cache the parsed rules with a TTL (e.g., 1 hour)
3. Before each request, check if the URL is allowed by the robots.txt rules
4. Respect `Crawl-delay` directive by adjusting the per-domain rate limiter

```go
// RobotsChecker verifies URLs against robots.txt rules.
type RobotsChecker interface {
    IsAllowed(ctx context.Context, rawURL string) (bool, error)
    CrawlDelay(ctx context.Context, domain string) time.Duration
}

// The crawler's rate limiter would become per-domain:
type PerDomainRateLimiter struct {
    limiters map[string]*time.Ticker
    mu       sync.Mutex
    defaultRate int
}

func (rl *PerDomainRateLimiter) Wait(ctx context.Context, domain string) error {
    rl.mu.Lock()
    ticker, ok := rl.limiters[domain]
    if !ok {
        ticker = time.NewTicker(time.Second / time.Duration(rl.defaultRate))
        rl.limiters[domain] = ticker
    }
    rl.mu.Unlock()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-ticker.C:
        return nil
    }
}
```

This is critical for production crawlers - violating robots.txt can get your IP blocked and is considered unethical."

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **Concurrency Design** | Uses goroutines without coordination, race conditions | Correct worker pool with channel-based coordination | Clean producer-consumer pattern, no shared mutable state, proper shutdown |
| **Rate Limiting** | No rate limiting or incorrect implementation | Working rate limiter with configurable limit | Per-domain rate limiting, respects robots.txt crawl-delay |
| **Context Cancellation** | Ignores context, no graceful shutdown | Checks context in main loop | Propagates context to all goroutines, drains in-flight work, returns partial results |
| **Error Handling** | Panics on errors, no recovery | Returns errors, handles HTTP error codes | Graceful degradation, retries, distinguishes error types (404 vs timeout vs network) |
| **Interface Design** | No interfaces, tightly coupled to HTTP | Fetcher interface for testability | Clean interfaces for both fetching and parsing, full mock implementations |
| **Testing** | No tests or trivial tests | Tests basic crawling and edge cases | Tests concurrency, rate limiting, cancellation, same-domain filtering |
| **Code Quality** | Messy, hard to follow, poor naming | Readable, reasonable structure | Self-documenting, idiomatic Go, focused functions, clear comments |
| **Follow-ups** | Cannot answer extension questions | Provides reasonable answers | Detailed answers with code (resumability, robots.txt, per-domain rate limiting) |

**Scoring thresholds:**
- **Strong Hire:** Average ≥ 4.0, demonstrates production-quality Go concurrency
- **Hire:** Average ≥ 3.0, working concurrent crawler with tests
- **Lean No Hire:** Average ≥ 2.5, basic solution with concurrency issues
- **No Hire:** Average < 2.5, cannot build a working concurrent solution


### Junior → FAANG: Netflix Senior Concurrency Coding Mock Basics

Netflix senior coding interviews on concurrency test your ability to design correct, efficient concurrent programs for real-world scenarios: concurrent caching, parallel download management, or rate-limited request batching. The key skill is identifying the correct synchronization primitive for the access pattern: sync.Mutex for exclusive access, sync.RWMutex for read-heavy data, sync.Map for concurrent map access, atomic operations for counters, and channels for coordination between goroutines with different lifecycle dependencies.

### Senior @ FAANG: Netflix Senior Concurrency: Culture Fit and Production Reliability

At the Netflix senior level, concurrency coding interviews are also a culture fit screen. Netflix's engineering culture prizes individuals who operate autonomously, take full ownership of their code's behavior in production, and hold themselves to a high standard without external enforcement. A candidate who writes a concurrent solution and does not proactively add race detection tests, goroutine leak detection, and explicit lifecycle management comments is signaling a gap with the Netflix standard. The bar for a Netflix senior engineer is: would you be comfortable putting this code on-call on day one? If not, you have not finished the implementation. This means edge cases must be handled, all goroutines must have clear termination conditions, and the solution must have been mentally tested against the common failure scenarios (context cancellation, channel close, partial failure of downstream calls).
