## 37J.10 Complete CDN-Aware Handler

### Production HTTP Handler with Full Caching

`ProductHandler` wires together the full caching stack in a single HTTP handler: it checks Redis first, falls through to `productSvc` on a miss, writes the response to Redis with a TTL, and sets both `Cache-Control` and `Surrogate-Key` headers so the CDN can cache the response and later purge it by entity tag. The handler uses `r.PathValue` (routing enhancements introduced in Go 1.22, still the current API in Go 1.27) for path parameter extraction and defers CDN invalidation to `cdnSvc.PurgeByTags` on mutation paths, keeping invalidation logic out of the service layer.

```go
package cdn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// ProductHandler demonstrates complete CDN-aware API handler
type ProductHandler struct {
	productSvc  ProductService
	cache       *RedisCache
	cdnSvc      *CDNInvalidationService
	log         *slog.Logger
}

// GetProduct handles GET /products/:id with full caching stack
func (h *ProductHandler) GetProduct(w http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id") // Go 1.22+ native path params
	if productID == "" {
		http.Error(w, "missing product id", http.StatusBadRequest)
		return
	}

	// Validate input to prevent cache poisoning
	if !isValidID(productID) {
		http.Error(w, "invalid product id", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Try cache
	var product Product
	cacheKey := fmt.Sprintf("product:%s", productID)
	if err := h.cache.Get(ctx, cacheKey, &product); err == nil {
		// Cache hit: serve with CDN-friendly headers
		h.serveProductResponse(w, r, product, false)
		return
	}

	// Cache miss: fetch from service
	product, err := h.productSvc.GetByID(ctx, productID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// Cache 404 for short time to prevent DB hammering
			w.Header().Set("Cache-Control", "public, max-age=60")
			http.NotFound(w, r)
			return
		}
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	// Populate cache
	h.cache.Set(ctx, cacheKey, product, 10*time.Minute)

	h.serveProductResponse(w, r, product, true)
}

func (h *ProductHandler) serveProductResponse(w http.ResponseWriter, r *http.Request, product Product, fromDB bool) {
	// Content type
	w.Header().Set("Content-Type", "application/json")

	// ETag based on product version
	etag := fmt.Sprintf(`"%s-%d"`, product.ID, product.UpdatedAt.UnixMilli())
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)

	// Cache policy: public content, 5 min CDN TTL
	policy := CachePolicy{
		Public:               true,
		MaxAge:               5 * time.Minute,   // browser cache
		SMaxAge:              10 * time.Minute,  // CDN cache
		StaleWhileRevalidate: 5 * time.Minute,   // serve stale during refresh
		StaleIfError:         24 * time.Hour,    // serve stale on origin error
		SurrogateKeys: []string{
			fmt.Sprintf("product:%s", product.ID),
			fmt.Sprintf("category:%s", product.Category),
			"products",
		},
		VaryHeaders: []string{"Accept-Encoding"},
	}
	policy.Apply(w, r)

	// Debug header for cache origin
	if fromDB {
		w.Header().Set("X-Cache-Status", "MISS")
	} else {
		w.Header().Set("X-Cache-Status", "HIT")
	}

	// Response body
	json.NewEncoder(w).Encode(product)
}

// UpdateProduct handles PUT /products/:id with cache invalidation
func (h *ProductHandler) UpdateProduct(w http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	if !isValidID(productID) {
		http.Error(w, "invalid product id", http.StatusBadRequest)
		return
	}

	var req UpdateProductRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Update in database
	product, err := h.productSvc.Update(ctx, productID, req)
	if err != nil {
		http.Error(w, "update failed", http.StatusInternalServerError)
		return
	}

	// Invalidate all caches asynchronously
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := h.cdnSvc.InvalidateProduct(ctx, productID); err != nil {
			h.log.Error("cache invalidation failed", "product_id", productID, "err", err)
		}
	}()

	// Response: no-cache since we just updated
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(product)
}

func isValidID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

type Product struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Category    string    `json:"category"`
	PriceCents  int64     `json:"price_cents"`
	Description string    `json:"description"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type ProductService interface {
	GetByID(ctx context.Context, id string) (Product, error)
	Update(ctx context.Context, id string, req UpdateProductRequest) (Product, error)
}

var ErrNotFound = errors.New("product not found")

type UpdateProductRequest struct {
	Name        string `json:"name"`
	PriceCents  int64  `json:"price_cents"`
	Description string `json:"description"`
}
```

### Junior to FAANG: prerequisite gaps, worked examples, first-job context

If you are reading this handler for the first time, walk it top to bottom and name each header before moving on. The prerequisite gaps most new engineers carry into a CDN interview are the difference between `max-age` (browser) and `s-maxage` (shared cache), the role of `ETag` versus `Last-Modified`, and why `Vary: Accept-Encoding` is safe while `Vary: User-Agent` is a cardinality bomb. Worked example: a product page is requested 1,000 times per second across 200 edge POPs. Without `s-maxage`, every edge refetches on every request. With `s-maxage=600`, each POP refetches once per ten minutes, so origin load drops from 1,000 rps to roughly 0.33 rps. That single header rewrite is the reason your bill goes from five figures to three.

In your first job, the "why did this fail" reflex matters more than the code. When a cache bug lands in your queue, check five things in order before you touch a line of Go. First, read the response headers from a cold edge using `curl -I` against the CDN hostname and confirm `Cache-Control`, `Vary`, `Surrogate-Key`, and `ETag` are present and correct. Second, diff the `Vary` values between a working route and the broken one. Third, inspect the cache key the CDN actually composed (most vendors expose this in debug headers such as `X-Cache-Key` or `CF-Cache-Status`). Fourth, confirm the origin `Surrogate-Key` list matches what your purge worker emits. Fifth, check whether the purge actually reached the edge by tailing the CDN audit log. Most bugs resolve in step one or two, which means most of the time you are not debugging Go, you are debugging the contract between Go and the CDN.

Interview entry point for L3 and L4: be able to read this handler aloud and explain why `X-Cache-Status` is a debug header and not a cache key input, why `no-cache, no-store` is set on the mutation response, and why the purge is a goroutine with a fresh context rather than inheriting `r.Context()`. The last one is the trap. The request context is canceled as soon as the client disconnects, and if you inherit it, the purge gets canceled half the time on mobile networks. Fresh context with a bounded timeout is the idiomatic pattern. If you can articulate that in thirty seconds without prompting, you have cleared the cache-invalidation question for mid-level.

### Senior at FAANG: staff and principal material, ADRs, maturity models, governance

At staff and principal level the CDN-aware handler is a governance artifact, not a code file. Treat it as the reference implementation that every service team copies, and write the ADR that explains the invariants. The ADR I ship for this pattern lists six invariants. One, every cacheable response must emit `Surrogate-Key` with at least one entity key and one collection key, so purge can target either granularity without code changes. Two, `Vary` is an allowlist maintained in a single package, and adding a new `Vary` value requires a review from the edge team because it multiplies cache cardinality. Three, `ETag` is derived from a monotonic version field on the entity, never from a hash of the serialized body, because body hashing destroys compression stability and collides under field reordering. Four, mutation handlers never purge synchronously in the request path, they enqueue to a durable purge topic and return. Five, all cache policy is expressed through a typed `CachePolicy` struct, never through raw header writes, so policy drift is caught in review. Six, the handler emits `X-Cache-Origin` with the service name so edge logs can be joined against service SLOs.

Maturity model for CDN-aware handlers across an organization. L1 is ad-hoc: teams write `w.Header().Set("Cache-Control", "...")` inline and invalidation is a Slack message to the edge team. L2 is centralized helpers: a shared `cache` package exists but each team overrides it. L3 is policy-as-code: every handler declares a typed `CachePolicy` and violations fail CI via a static analyzer that parses AST and rejects raw header writes on `Cache-Control`, `Vary`, and `Surrogate-Key`. L4 is telemetry-driven: hit-rate-per-route is a first-class SLO with alerts, and a handler that drops below its target hit rate opens an incident. L5 is autonomous: the policy package tunes `s-maxage` and `stale-while-revalidate` per route based on observed traffic skew and origin latency, and a policy change is a PR that a CDN bot opens after seeing seven days of data.

Governance topics that separate staff from senior. Cache-key hygiene: enumerate every header and query parameter that contributes to the key, reject unbounded contributors (user-agent, cookie, arbitrary query strings) at the edge via WAF rules, and document the allowlist in the ADR. Surrogate-key taxonomy: establish the namespace convention (`entity:id`, `collection:name`, `tenant:id`) and enforce it with a linter, because a single typo in a purge worker can leave stale content for days. ETag emission policy: standardize on `W/"<version>-<updated_at_ms>"` for weak validators on JSON APIs and strong validators only for immutable assets, and reject handlers that emit `ETag` without a matching `If-None-Match` short-circuit. Cache-Control composition: forbid `no-cache` and `no-store` together (they are redundant and signal confusion), require `public` or `private` to be explicit, and require `stale-if-error` on every public response so origin outages do not cascade to users. These are the rules a principal engineer writes once and the organization lives by for a decade.

---
