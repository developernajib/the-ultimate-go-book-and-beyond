## 37J.8 Stale-While-Revalidate Implementation

### Background Refresh Pattern

`StaleWhileRevalidateCache` tracks two deadlines per entry (`freshUntil` and `staleUntil`), so a request that arrives in the stale window receives the old value immediately while a background goroutine calls the injected `refresher` function to fetch a new value. The `revalidating` map prevents duplicate background fetches for the same key, acting as a lightweight singleflight guard without blocking the read path.

```go
package cdn

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// StaleWhileRevalidateCache serves stale content while refreshing in background
type StaleWhileRevalidateCache[T any] struct {
	mu          sync.RWMutex
	items       map[string]*swrItem[T]
	revalidating map[string]bool
	refresher    func(ctx context.Context, key string) (T, error)
	log          *slog.Logger
}

type swrItem[T any] struct {
	value     T
	freshUntil time.Time  // serve fresh until this time
	staleUntil time.Time  // serve stale (while revalidating) until this time
}

// Get returns value, potentially triggering background revalidation
func (c *StaleWhileRevalidateCache[T]) Get(ctx context.Context, key string) (T, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()

	if !ok {
		var zero T
		return zero, false
	}

	now := time.Now()

	if now.Before(item.freshUntil) {
		// Fresh: serve normally
		return item.value, true
	}

	if now.Before(item.staleUntil) {
		// Stale but within revalidation window: serve stale, trigger background refresh
		c.triggerRevalidation(key)
		return item.value, true
	}

	// Beyond stale window: must revalidate synchronously
	var zero T
	return zero, false
}

func (c *StaleWhileRevalidateCache[T]) triggerRevalidation(key string) {
	c.mu.Lock()
	if c.revalidating[key] {
		c.mu.Unlock()
		return // already revalidating
	}
	c.revalidating[key] = true
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.revalidating, key)
			c.mu.Unlock()
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		value, err := c.refresher(ctx, key)
		if err != nil {
			c.log.Error("stale-while-revalidate refresh failed", "key", key, "err", err)
			return
		}

		c.mu.Lock()
		c.items[key] = &swrItem[T]{
			value:      value,
			freshUntil: time.Now().Add(5 * time.Minute),
			staleUntil: time.Now().Add(10 * time.Minute),
		}
		c.mu.Unlock()
	}()
}

// GetOrFetch gets from cache or fetches synchronously
func (c *StaleWhileRevalidateCache[T]) GetOrFetch(ctx context.Context, key string) (T, error) {
	if v, ok := c.Get(ctx, key); ok {
		return v, nil
	}

	// Synchronous fetch
	value, err := c.refresher(ctx, key)
	if err != nil {
		return value, fmt.Errorf("fetch: %w", err)
	}

	c.mu.Lock()
	c.items[key] = &swrItem[T]{
		value:      value,
		freshUntil: time.Now().Add(5 * time.Minute),
		staleUntil: time.Now().Add(10 * time.Minute),
	}
	c.mu.Unlock()

	return value, nil
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Stale-while-revalidate (SWR) is defined in RFC 5861. The header `Cache-Control: max-age=60, stale-while-revalidate=600` tells a cache "this object is fresh for 60 seconds, after that you may serve it stale for up to 600 additional seconds as long as you kick off a background revalidation to fetch a fresh copy." The companion directive is `stale-if-error=86400`, which says "if origin is down, keep serving the stale copy for up to a day." These two directives together turn origin blips into zero-downtime events, which is why they are on nearly every modern API response.

The first prerequisite gap most juniors have is the mental model of "fresh, stale-but-usable, expired." The cache entry has three lifecycle windows not two. Fresh means serve without asking. Stale means serve now, fetch fresh asynchronously, update the cache for the next requester. Expired means block the requester and fetch synchronously before responding. The code in this file implements all three, with `freshUntil` bounding the fresh window and `staleUntil` bounding the SWR window.

Worked example: a product detail endpoint takes 300ms at p99 on origin. You set `max-age=30, stale-while-revalidate=120`. During steady-state traffic the endpoint serves under 5ms from cache. Every 30 seconds, one unlucky requester triggers the background revalidation, which returns in 300ms but the requester got served from the stale cache in under 5ms so they never notice. Without SWR, every 30 seconds one requester waits 300ms for a fresh copy. SWR moves that cost off the critical path. The interview entry-point here is "what is SWR and when is it wrong." It is wrong when staleness has correctness consequences (prices, inventory counts that must be strictly zero, anything auth-related) and right for almost everything else.

First-job context: your application code almost certainly sits behind a CDN that honors SWR, Fastly and Cloudflare and CloudFront all do in 2026. So the question is where to implement SWR, at the CDN layer via headers, or in application code as shown here. The answer is usually both, because the CDN SWR protects origin from traffic and the application SWR protects origin from itself (slow database, slow downstream service).

### Senior @ FAANG: RFC 5861 Details, Layer Placement, and Async Revalidation Worker Patterns

RFC 5861 specifies two directives, `stale-while-revalidate` and `stale-if-error`. The subtlety seniors must understand is that they compose with `max-age` and `s-maxage` but the composition is not intuitive. `max-age=60, stale-while-revalidate=600` means the object is fresh for 60s, then stale-usable for another 600s, totaling 660s of serve-ability. `max-age=60, stale-if-error=600` means fresh for 60s, then after 60s every request must revalidate synchronously unless origin is unreachable, in which case the cache may serve for up to 600 more seconds. The two directives stack: `max-age=60, stale-while-revalidate=300, stale-if-error=86400` is the production default I reach for on idempotent GETs. Fresh 60s, async-revalidate for 5 minutes, and survive a 24-hour origin outage serving stale content.

Layer placement is a staff-level decision. SWR at the CDN layer is implemented by Fastly (`beresp.stale_while_revalidate` in VCL), Cloudflare (honors the header automatically since 2021), and CloudFront (since 2023 via cache policies). SWR at CDN layer costs nothing and scales to any traffic level. SWR at the application layer (like the Go code in this file) protects against in-region origin issues the CDN cannot see, and allows for richer logic such as per-key TTLs, dependency-graph invalidation, and coalesced refreshes. The design pattern I recommend for high-value services: both layers, with CDN SWR on short horizons (seconds to minutes) for edge-to-origin shielding, and application SWR on longer horizons (minutes to hours) for origin-to-database shielding. The two layers are not redundant, they handle different failure modes.

The implementation in this file has three subtle bugs that senior review catches. First, the `revalidating` guard is an in-process singleflight, so in a horizontally scaled deployment every pod independently triggers a revalidation for a hot key, multiplying load on the downstream by pod count. Fix: either add Redis-based distributed singleflight using `SET NX PX` as a lock with a 5-second TTL, or accept the duplication and rely on downstream caching. Second, the background context is `context.Background()` with a 5-second timeout, which is correct in that it decouples from the request context, but it does not carry correlation IDs or tracing spans. Fix: extract the trace span from the request context via `otel.GetTextMapPropagator()` and inject it into a detached span on the background context, so the refresh is visible in distributed traces as a child of the original triggering request. Third, the hard-coded 5-minute and 10-minute TTLs should be per-key or per-namespace, passed through the refresher result or derived from `Cache-Control` headers the downstream returned, because uniform TTLs across heterogeneous keys either waste memory or miss consistency bounds.

The async revalidation worker pattern scales further. Instead of revalidating inline on stale-hit, enqueue revalidation tasks to a bounded work queue with worker goroutines, so a burst of stale-hits does not spawn 10,000 goroutines. A single channel `chan revalidateTask` with 100 workers and a 10,000-slot buffer handles the realistic load of any single service. When the queue is full, drop the task, because another request will re-enqueue it in a moment. The observability hookup: emit metrics for `swr_hit`, `swr_stale_served`, `swr_revalidation_triggered`, `swr_revalidation_failed`, and `swr_revalidation_latency_seconds` as a histogram. The dashboard to build: a panel showing stale-served ratio over time, another showing revalidation failure rate, and an alert when stale-served exceeds 20 percent of traffic for more than 5 minutes, which indicates origin is struggling and you should cut traffic or scale out.

Cache-poisoning interaction: SWR prolongs the lifetime of any poisoned entry, so a cache-poisoning attack (covered in the next section) is worse on an SWR-enabled endpoint. The mitigation is a hard bound on total serve age, typically enforced by the CDN rejecting responses with total `age + max-age + swr` exceeding 24 hours, plus integrity checks on cache keys as described in the cache-poisoning section.

Finally, the `stale-if-error` directive's semantics when origin returns 5xx versus 4xx matters. By RFC, only 500, 502, 503, 504 trigger stale-if-error. A 404 from origin updates the cache with a 404 (unless you strip it), and a 403 typically does not trigger stale-if-error. Several CDNs diverge here: Fastly lets you configure which status codes are "errors" via VCL, CloudFront has a fixed list. Read your CDN's docs and test with synthetic failures before relying on stale-if-error for an SLA commitment.

---
