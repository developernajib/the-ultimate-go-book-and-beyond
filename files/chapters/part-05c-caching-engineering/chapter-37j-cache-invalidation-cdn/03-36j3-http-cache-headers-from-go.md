## 37J.3 HTTP Cache Headers from Go

### Cache-Control Implementation

`CachePolicy` separates the four dimensions of HTTP cacheability (audience, browser TTL, CDN TTL, and grace periods) into typed fields rather than a raw string, so that engineers cannot accidentally omit `s-maxage` or set `public` on authenticated content. The policy is serialized to a single `Cache-Control` header by a builder method that only includes directives that are explicitly set.

```go
package cdn

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// CachePolicy defines how a response should be cached
type CachePolicy struct {
	// Public: can be cached by CDN/shared caches
	// Private: only browser cache (authenticated content)
	Public bool

	// MaxAge: browser cache TTL
	MaxAge time.Duration

	// SMaxAge: CDN/shared cache TTL (overrides MaxAge for CDNs)
	SMaxAge time.Duration

	// StaleWhileRevalidate: serve stale content while refreshing
	StaleWhileRevalidate time.Duration

	// StaleIfError: serve stale on origin error
	StaleIfError time.Duration

	// NoStore: don't cache at all (sensitive data)
	NoStore bool

	// NoCache: must revalidate before serving (always check origin)
	NoCache bool

	// Immutable: content will never change (versioned assets)
	Immutable bool

	// MustRevalidate: must revalidate when stale
	MustRevalidate bool

	// VaryHeaders: headers that affect the response (for CDN variants)
	VaryHeaders []string

	// SurrogateKeys: cache tags for targeted CDN purging
	SurrogateKeys []string

	// ETag: for conditional GET support
	ETag string
}

// Apply sets HTTP cache headers on the response
func (p CachePolicy) Apply(w http.ResponseWriter, r *http.Request) {
	if p.NoStore {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		return
	}

	var directives []string

	if p.Public {
		directives = append(directives, "public")
	} else {
		directives = append(directives, "private")
	}

	if p.NoCache {
		directives = append(directives, "no-cache")
	}

	if p.MaxAge > 0 {
		directives = append(directives, fmt.Sprintf("max-age=%d", int(p.MaxAge.Seconds())))
	}

	if p.SMaxAge > 0 && p.Public {
		directives = append(directives, fmt.Sprintf("s-maxage=%d", int(p.SMaxAge.Seconds())))
	}

	if p.StaleWhileRevalidate > 0 {
		directives = append(directives, fmt.Sprintf("stale-while-revalidate=%d", int(p.StaleWhileRevalidate.Seconds())))
	}

	if p.StaleIfError > 0 {
		directives = append(directives, fmt.Sprintf("stale-if-error=%d", int(p.StaleIfError.Seconds())))
	}

	if p.Immutable {
		directives = append(directives, "immutable")
	}

	if p.MustRevalidate {
		directives = append(directives, "must-revalidate")
	}

	w.Header().Set("Cache-Control", strings.Join(directives, ", "))

	// Vary header tells CDN to cache separate copies per header value
	if len(p.VaryHeaders) > 0 {
		w.Header().Set("Vary", strings.Join(p.VaryHeaders, ", "))
	}

	// Surrogate-Key / Cache-Tag: supported by Fastly, Cloudflare
	if len(p.SurrogateKeys) > 0 {
		tags := strings.Join(p.SurrogateKeys, " ")
		w.Header().Set("Surrogate-Key", tags)    // Fastly
		w.Header().Set("Cache-Tag", tags)         // Cloudflare
		w.Header().Set("X-Cache-Tags", tags)      // generic
	}

	// ETag for conditional requests
	if p.ETag != "" {
		w.Header().Set("ETag", p.ETag)
	}

	// Last-Modified for conditional requests
	w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
}

// Common cache policies
var (
	// StaticAssets: immutable versioned files (JS, CSS with hash)
	StaticAssets = CachePolicy{
		Public:   true,
		MaxAge:   365 * 24 * time.Hour, // 1 year
		SMaxAge:  365 * 24 * time.Hour,
		Immutable: true,
	}

	// ProductPage: public, short CDN TTL for freshness
	ProductPage = CachePolicy{
		Public:               true,
		MaxAge:               5 * time.Minute,
		SMaxAge:              10 * time.Minute,
		StaleWhileRevalidate: 5 * time.Minute,
		StaleIfError:         24 * time.Hour,
		VaryHeaders:          []string{"Accept-Encoding"},
	}

	// UserDashboard: private, not cached by CDN
	UserDashboard = CachePolicy{
		Public:  false,
		MaxAge:  0,
		NoCache: true,
	}

	// API Response: no caching for dynamic data
	DynamicAPI = CachePolicy{
		NoStore: true,
	}

	// Search Results: short CDN TTL, stale-while-revalidate
	SearchResults = CachePolicy{
		Public:               true,
		MaxAge:               60 * time.Second,
		SMaxAge:              5 * time.Minute,
		StaleWhileRevalidate: 2 * time.Minute,
		StaleIfError:         10 * time.Minute,
		VaryHeaders:          []string{"Accept-Encoding", "Accept-Language"},
	}
)

// CachingMiddleware applies cache policies to HTTP handlers
func CachingMiddleware(policy CachePolicy) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip caching for non-GET/HEAD requests
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Cache-Control", "no-store")
				next.ServeHTTP(w, r)
				return
			}

			policy.Apply(w, r)
			next.ServeHTTP(w, r)
		})
	}
}

// ConditionalGetMiddleware: handle If-None-Match / If-Modified-Since
func ConditionalGetMiddleware(getETag func(r *http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			etag := getETag(r)
			if etag != "" {
				w.Header().Set("ETag", etag)

				// Check If-None-Match
				if r.Header.Get("If-None-Match") == etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

### Junior → FAANG: learn Cache-Control by reading it out loud

The fastest way to internalize HTTP caching is to read headers out loud as English sentences. `Cache-Control: public, max-age=300, s-maxage=600, stale-while-revalidate=120` reads as: anyone can cache this, browsers for 5 minutes, CDNs for 10, and when the CDN TTL expires the CDN may keep serving the stale copy for up to 2 more minutes while it refreshes in the background. Now `private, no-cache, must-revalidate` reads as: only the user's own browser may store this, it must revalidate with the origin on every use, and if revalidation fails it must not serve the stale copy. Once you can translate both directions fluently, the middleware in this file stops looking like a configuration salad. The interview worked example is "I have a signed-in user's account page, what headers do I set?" Wrong answer is `public, max-age=60` because a shared CDN will cache it and serve one user's data to another (a cache poisoning incident that has hit multiple real companies). Right answer is `private, no-store` for the HTML response and a separate `public, max-age=31536000, immutable` policy on the versioned JS and CSS assets linked from it. The `Vary` header is the other frequent trap. If your response varies by `Accept-Language` or `Accept-Encoding` and you do not set `Vary`, the CDN serves the first cached variant to everyone. Set `Vary: Accept-Language` and the CDN stores one copy per language. Junior engineers forget `Vary` and get paged when French users see English pages. Senior engineers also know `Vary: Cookie` is almost always a mistake because it shatters cache hit ratio, and the fix is to normalize or strip cookies at the edge before the cache key is computed.

### Senior @ FAANG: RFC 9111, directive precedence, and the subtle failure modes

RFC 9111 (published June 2022, replacing RFC 7234) is the current authoritative specification for HTTP caching semantics and you should have read it at least once. It tightens several rules that older CDN and library implementations got wrong. The precedence rules matter. `no-store` beats everything, the response must not be written to any cache, volatile or persistent. `private` excludes shared caches but permits the browser cache, so a response with `private, max-age=3600` is cached for an hour in Chrome but never at the CDN. `s-maxage` only applies to shared caches and overrides `max-age` for them, so you can set `max-age=60, s-maxage=600` to give browsers a short TTL (fast dev iteration when testing) and CDNs a longer one (to absorb load). `must-revalidate` is stricter than the default and forbids serving stale content even during origin outage, which you almost never want, it fights `stale-if-error` and turns a transient origin blip into a user-visible 504. `immutable` is a performance primitive for versioned assets, it tells browsers not to revalidate on reload (the user hitting Cmd-R), saving a round trip per asset. Use it only when the URL contains a content hash. `stale-while-revalidate` and `stale-if-error` are the two most valuable directives most teams underuse, they convert a cache from a latency optimization into an availability layer, and tuning them is where you move p99 meaningfully. ETag hygiene is the other area where senior engineers catch real bugs. Strong ETags (`"abc123"`) imply byte-for-byte identity, so if your response includes a timestamp or a dynamic ad slot you must use weak ETags (`W/"abc123"`) or conditional GET silently breaks range requests and integrity checks. Generate ETags from a content hash of the canonical representation, not from the request timestamp, or every response is unique and the whole conditional-GET machinery is useless. The `Vary` header is load-bearing for correctness. Include every request header that actually changes the response body and nothing more, because each added Vary value multiplies cache variants and destroys hit ratio. `Vary: Accept-Encoding` is nearly always correct (gzip vs brotli vs identity). `Vary: User-Agent` is nearly always wrong because it explodes variants across thousands of UA strings, use a normalized device-type header set by a Cloudflare Worker or a middleware instead. The `Age` header is how you observe cache age in responses, scrape it from probes to detect when the CDN is not purging. Finally `Surrogate-Key` (Fastly) and `Cache-Tag` (Cloudflare) are non-standard but load-bearing, they are the hook that makes tag-based purge work, and they must be stripped from the response before it reaches the browser (set `Cache-Control: private` on them or use Surrogate-Control to keep them CDN-only, because they can leak internal taxonomy).

---
