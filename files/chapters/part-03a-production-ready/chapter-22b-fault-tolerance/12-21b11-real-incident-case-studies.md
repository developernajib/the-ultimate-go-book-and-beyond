## 22B.11 Real Incident Case Studies

### AWS us-east-1 Kinesis Outage (November 2020)

A capacity addition caused Kinesis front-end servers to exceed OS thread limits. Services depending on Kinesis cascaded into failure. The blast radius was enormous because Kinesis underpins CloudWatch, which meant monitoring itself went dark, teams could not even observe the outage through normal channels.

**With fault tolerance:** services with cached Kinesis config continued operating. Services with local event buffers queued events and replayed on recovery.

**Without:** every request hit a failing Kinesis endpoint and returned 500.

The pattern below demonstrates a local buffer fallback for event streaming. When the Kinesis client returns an error, the `PutRecord` method writes the event to a bounded channel instead. A separate goroutine (not shown) drains this channel and replays events once the service recovers. The `default` case on the channel send prevents the buffer from blocking the caller when it is full, at that point, the event is dropped, which is an explicit trade-off between data loss and service availability.
```go
type KinesisWithFallback struct {
    client      KinesisClient
    configCache *ttlcache.Cache[string, Config]
    localBuffer chan []byte
}

func (k *KinesisWithFallback) PutRecord(ctx context.Context, data []byte) error {
    if err := k.client.PutRecord(ctx, data); err != nil {
        // Fallback: buffer locally, replay on recovery
        select {
        case k.localBuffer <- data:
            return nil
        default:
            return fmt.Errorf("kinesis down and buffer full: %w", err)
        }
    }
    return nil
}
```

### Cloudflare WAF Regex Outage (July 2019)

A new WAF rule with catastrophic backtracking regex caused 100% CPU on every edge server globally. The rule was deployed to all edge servers simultaneously, so there was no canary or progressive rollout to catch the problem before it reached full blast radius. Cloudflare's entire CDN became unresponsive for approximately 27 minutes.

The first thing to say about this incident is that a Go service would very likely not have had it. Cloudflare's rule ran under PCRE, a backtracking engine. Go's `regexp` package implements RE2, which matches in time linear in the input and has no backtracking to go catastrophic in the first place. Choosing an engine with a complexity guarantee is not a fault tolerance pattern layered on top of the problem, it removes the problem. That is usually the better trade, and it is worth noticing that the strongest mitigation here is a design choice rather than a mechanism.

The interesting question is what you do when the unbounded computation is not a regex and you cannot pick a better engine. Here the honest answer is narrower than it first appears:

```go
// Bound the CALLER's wait. Read the comment before trusting this.
func safeMatch(re *regexp.Regexp, input string) (bool, error) {
    ch := make(chan bool, 1) // Buffered, so the sender never blocks.
    go func() { ch <- re.MatchString(input) }()

    select {
    case result := <-ch:
        return result, nil
    case <-time.After(10 * time.Millisecond):
        // This returns to the caller. It does NOT stop the match.
        //
        // Go cannot interrupt a running goroutine. MatchString keeps burning
        // a core until it finishes on its own, timeout or no timeout. Under
        // an attack this is worse than useless: every request returns fast,
        // looks handled, and leaves a CPU-bound goroutine behind, so the
        // machine melts while the latency graphs look fine.
        //
        // The pattern buys latency isolation for the caller. It buys no CPU
        // protection whatsoever. Only an engine with a complexity bound
        // (RE2), a hard input size limit, or an out-of-process sandbox you
        // can actually kill gives you that.
        return false, errors.New("regex evaluation exceeded 10ms")
    }
}
```

The pattern that genuinely would have contained the blast radius is the one Cloudflare itself adopted afterwards: progressive rollout. The rule went to every edge server at once, so there was no window in which a canary could report 100% CPU before the change reached global scale. A bulkhead helps too, by capping concurrent WAF evaluations so slow ones cannot starve the goroutines serving non-WAF traffic, though note it caps concurrency rather than total CPU:

```go
// Bulkhead on WAF processing.
var wafBulkhead, _ = NewBulkhead(BulkheadConfig{
    Name:          "waf",
    MaxConcurrent: 50,
}, nil)

func evaluateWAF(ctx context.Context, r *http.Request) error {
    return wafBulkhead.Execute(ctx, func(ctx context.Context) error {
        return runWAFRules(ctx, r)
    })
}
```

### Amazon's Static Stability Principle

Amazon's rule: **systems must keep working even when their dependency control planes are down.** A control plane is any system that manages configuration, routing, or service discovery, things like AWS Systems Manager, Route 53, or an internal feature flag service. These systems are designed for consistency and correctness, not for the extreme availability that hot-path traffic demands. If your request-handling code blocks on a synchronous call to the control plane, a control plane outage becomes a data plane outage.

The fix is straightforward: cache all control plane data locally with a long TTL, and refresh it asynchronously in the background. The hot path reads only from the local cache and never blocks on a network call to the control plane. If the background refresh fails, the service continues operating with stale data, which is almost always preferable to returning errors.

```go
// Never block on the config service. Cache locally with a long TTL.
type StaticConfig struct {
    mu    sync.RWMutex
    cache map[string]any

    // fetchedAt is atomic, not a plain time.Time under the mutex, because
    // Get reads it on every call outside the read lock. A plain field here
    // is a genuine data race: refresh writes it while readers read it, and
    // `go test -race` reports it immediately.
    fetchedAt atomic.Int64 // Unix nanos.

    // refreshing single-flights the background refresh.
    refreshing atomic.Bool

    ttl time.Duration
    svc ConfigService
}

func (c *StaticConfig) Get(key string) any {
    c.mu.RLock()
    val := c.cache[key]
    c.mu.RUnlock()

    if time.Since(time.Unix(0, c.fetchedAt.Load())) > c.ttl {
        c.triggerRefresh()
    }
    return val // Always returns the cached value immediately.
}

// triggerRefresh starts at most one background refresh at a time.
//
// Writing `go c.refresh()` directly in Get looks harmless and is not. Get is
// the hot path, so the moment the TTL expires EVERY concurrent request spawns
// its own refresh goroutine. At 10k req/s that is thousands of simultaneous
// calls into a control plane which, by the entire premise of this pattern, is
// already struggling. The cache built to shield the control plane would be
// the thing that finishes it off, and it would do so at the worst moment.
// One in-flight refresh is all that is ever needed.
func (c *StaticConfig) triggerRefresh() {
    if !c.refreshing.CompareAndSwap(false, true) {
        return // A refresh is already running.
    }
    go func() {
        defer c.refreshing.Store(false)
        c.refresh()
    }()
}

func (c *StaticConfig) refresh() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    fresh, err := c.svc.FetchAll(ctx)
    if err != nil {
        // Keep the stale values. A down control plane is precisely the case
        // this cache exists for, so serving stale config is the correct
        // outcome rather than an error worth propagating. fetchedAt is left
        // alone so the next Get retries.
        return
    }

    c.mu.Lock()
    c.cache = fresh
    c.mu.Unlock()
    c.fetchedAt.Store(time.Now().UnixNano())
}
```

### Staff Lens: Every Incident Is Teaching Material

Postmortem every incident. Extract systemic lessons. Build the library of "what went wrong and how we prevent it next time". Over years, the library becomes the org's institutional memory.

---
