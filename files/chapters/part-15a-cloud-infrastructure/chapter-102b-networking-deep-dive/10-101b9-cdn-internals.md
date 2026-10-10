## 102B.9 CDN Internals

### How CDNs Work: Anycast Routing and PoPs

A CDN (Content Delivery Network) operates Points of Presence (PoPs) in dozens to hundreds of locations worldwide. CDNs use **anycast routing**: the same IP address is announced from multiple PoPs via BGP. The internet's routing protocols naturally send traffic to the nearest (lowest cost) PoP.

```
User (Tokyo) ──→ Anycast IP: 104.16.0.1
                              │
                BGP routes to nearest PoP:
                Tokyo PoP (5ms) ← selected
                Singapore PoP (80ms)
                Los Angeles PoP (150ms)
```

When a request hits a CDN edge node:
1. **Cache HIT**: the response is in the edge cache → served directly, sub-10ms latency
2. **Cache MISS**: the edge node fetches from origin, caches the response, serves the client

### Cache-Control Headers for CDN Optimization

`Cache-Control` is the primary mechanism through which your Go service instructs both browsers and CDN edge nodes on what to cache and for how long. The `s-maxage` directive overrides `max-age` specifically for shared caches (CDNs), letting you set a long CDN TTL while keeping the browser TTL short for user-specific freshness. The `stale-while-revalidate` extension is particularly valuable: it allows the CDN to serve a slightly stale cached response immediately while asynchronously fetching a fresh copy from origin, eliminating cache-miss latency spikes entirely.

```go
package cacheutil

import (
    "fmt"
    "net/http"
    "time"
)

// CacheStrategy defines caching behavior at different layers.
type CacheStrategy struct {
    // BrowserMaxAge: how long browsers cache the response.
    BrowserMaxAge time.Duration
    // CDNMaxAge: how long CDN edge nodes cache the response (overrides BrowserMaxAge for CDN).
    CDNMaxAge time.Duration
    // StaleWhileRevalidate: serve stale content while fetching fresh in background.
    StaleWhileRevalidate time.Duration
    // Immutable: the resource will never change at this URL (use with content-addressed URLs).
    Immutable bool
    // Private: do not cache in CDN or shared caches (user-specific content).
    Private bool
}

// SetCacheHeaders writes appropriate Cache-Control headers for CDN and browser caching.
func SetCacheHeaders(w http.ResponseWriter, strategy CacheStrategy) {
    if strategy.Private {
        // User-specific data: cache in browser only, never in CDN.
        w.Header().Set("Cache-Control", fmt.Sprintf(
            "private, max-age=%d",
            int(strategy.BrowserMaxAge.Seconds()),
        ))
        return
    }

    if strategy.Immutable {
        // Content-addressed assets (hashed filenames): never expire.
        // e.g., /static/app.a1b2c3d4.js
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        return
    }

    // Public content with separate browser and CDN TTLs.
    directive := fmt.Sprintf(
        "public, max-age=%d, s-maxage=%d",
        int(strategy.BrowserMaxAge.Seconds()),
        int(strategy.CDNMaxAge.Seconds()),
    )

    if strategy.StaleWhileRevalidate > 0 {
        directive += fmt.Sprintf(
            ", stale-while-revalidate=%d",
            int(strategy.StaleWhileRevalidate.Seconds()),
        )
    }

    w.Header().Set("Cache-Control", directive)
    w.Header().Set("Vary", "Accept-Encoding") // separate cache entries per encoding
}

// CachingMiddleware applies caching strategies to HTTP handlers.
func CachingMiddleware(strategy CacheStrategy) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            SetCacheHeaders(w, strategy)
            next.ServeHTTP(w, r)
        })
    }
}

// Common strategies for Go API servers:
var (
    // NoCache: dynamic API responses - never cache.
    NoCache = CacheStrategy{
        Private:       true,
        BrowserMaxAge: 0,
    }

    // ShortPublicCache: public API data that changes frequently.
    ShortPublicCache = CacheStrategy{
        BrowserMaxAge:        30 * time.Second,
        CDNMaxAge:            60 * time.Second,
        StaleWhileRevalidate: 30 * time.Second,
    }

    // StaticAssets: hashed filenames, cache forever.
    StaticAssets = CacheStrategy{
        Immutable: true,
    }

    // Versioned API responses: public, cached for 5 minutes at CDN.
    APIResponse = CacheStrategy{
        BrowserMaxAge:        60 * time.Second,
        CDNMaxAge:            5 * time.Minute,
        StaleWhileRevalidate: 60 * time.Second,
    }
)
```

### CDN Providers: Key Differences

| Feature | Cloudflare | Fastly | CloudFront |
|---------|-----------|--------|------------|
| Network | 300+ PoPs, anycast | 70+ PoPs | 400+ PoPs |
| Purge time | <150ms global | <150ms global | Up to 15 minutes |
| Edge compute | Workers (V8 isolates) | Compute@Edge (Wasm) | Lambda@Edge, CloudFront Functions |
| QUIC/HTTP3 | Yes | Yes | Limited |
| Price model | Flat (plans) | Pay per request | Pay per GB+request |
| Custom VCL | No | Yes (VCL) | No |

---

### Junior → FAANG: CDN Cache Headers as a First-Class Concern

The most commonly misunderstood CDN concept for junior engineers: CDN caching behavior is controlled by HTTP response headers, not CDN configuration. If your Go service does not set `Cache-Control` headers correctly, the CDN will either cache nothing (missing monetization of the CDN investment) or cache everything (returning stale data to users after updates).

The `Cache-Control` header vocabulary to internalize: `no-cache` means revalidate with the origin before using cached content (not "do not cache"), `no-store` means genuinely do not cache, `max-age=3600` means the client and CDN can cache for 3600 seconds without revalidation, and `s-maxage=3600` overrides `max-age` specifically for shared caches (CDNs). Setting `Cache-Control: no-store` on API responses that contain user-specific data is a security requirement, not just a performance consideration.

First-job habit: add cache header testing to your API test suite. Use a test that verifies the `Cache-Control` header for each endpoint matches the expected policy. This prevents accidental caching of private data or accidental cache-busting of public data.

### Senior @ FAANG: CDN Architecture and Cache Invalidation at Scale

At staff level, CDN configuration is a product decision with direct user experience and cost implications. The cache hit ratio determines what percentage of requests are served from CDN edge nodes (cheap, fast) versus forwarded to the origin (more expensive, higher latency). A cache hit ratio below 70% usually indicates a caching configuration problem.

Cache invalidation is the hard problem in CDN management. The correct strategy for different content types: immutable assets (JavaScript bundles with content-hashed filenames) should be cached for years with `Cache-Control: immutable, max-age=31536000`. Versioned API responses should use `s-maxage` with a short TTL and `stale-while-revalidate` to allow the CDN to serve stale content while fetching updates in the background. User-specific content should never be cached by the CDN (use `Cache-Control: private`).

Purge APIs (Cloudflare cache purge, Fastly instant purge) enable programmatic cache invalidation when content is updated. Designing the cache invalidation strategy for content updates (by URL, by tag, by surrogate key) is an architectural decision that affects the latency of content updates reaching users. Surrogate keys (a Fastly-specific feature, analogous to CDN cache tags in other providers) allow purging all cached variants of a resource with a single API call, which is the correct approach for content with multiple URL variations (different query parameters, different accept-encoding).
