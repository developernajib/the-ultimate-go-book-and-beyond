## 37J.5 CDN Integration: Fastly

### Fastly Surrogate Keys (Instant Purge)

Fastly's VCL-based CDN exposes purge-by-surrogate-key, instant purge, and soft purge APIs that Go services can call to invalidate cached objects with sub-second propagation. The client below wraps Fastly's purge API with retry logic and batches surrogate key purges to minimize API call volume.

```go
package cdn

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// FastlyClient handles Fastly CDN operations
type FastlyClient struct {
	apiKey    string
	serviceID string
	http      *http.Client
	log       *slog.Logger
}

func NewFastlyClient(apiKey, serviceID string, log *slog.Logger) *FastlyClient {
	return &FastlyClient{
		apiKey:    apiKey,
		serviceID: serviceID,
		http:      &http.Client{Timeout: 15 * time.Second},
		log:       log,
	}
}

// PurgeBySurrogateKey purges all content tagged with surrogate keys
// Fastly's instant purge: < 150ms global propagation
func (f *FastlyClient) PurgeBySurrogateKey(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	// Fastly surrogate key purge: batch in one request
	body := strings.Join(keys, " ")

	req, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("https://api.fastly.com/service/%s/purge", f.serviceID),
		bytes.NewBufferString(body),
	)
	if err != nil {
		return err
	}

	req.Header.Set("Fastly-Key", f.apiKey)
	req.Header.Set("Surrogate-Key", body)
	req.Header.Set("Content-Type", "text/plain")

	resp, err := f.http.Do(req)
	if err != nil {
		return fmt.Errorf("fastly purge: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fastly purge failed: status %d", resp.StatusCode)
	}

	f.log.Info("fastly cache purged", "keys", keys)
	return nil
}

// SoftPurge marks content as stale instead of removing (serve stale during revalidation)
func (f *FastlyClient) SoftPurge(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	body := strings.Join(keys, " ")
	req, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("https://api.fastly.com/service/%s/purge", f.serviceID),
		bytes.NewBufferString(body),
	)
	if err != nil {
		return err
	}

	req.Header.Set("Fastly-Key", f.apiKey)
	req.Header.Set("Surrogate-Key", body)
	req.Header.Set("Fastly-Soft-Purge", "1") // soft purge flag
	req.Header.Set("Content-Type", "text/plain")

	resp, err := f.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fastly soft purge failed: %d", resp.StatusCode)
	}
	return nil
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

If you are reading this before your first CDN on-call, the prerequisite knowledge is thinner than it looks. A CDN is a distributed reverse proxy with geographically pinned cache nodes (POPs) in front of your origin. When a user in Tokyo requests `/product/42`, the Fastly POP in NRT serves the cached HTML if present, otherwise it fetches from origin, stores the response, and returns it. The `Cache-Control: s-maxage=3600` header tells the shared cache (CDN) to keep the object for one hour. `max-age` applies to the browser, `s-maxage` applies to the CDN, and they can differ. A frequent junior bug is setting `Cache-Control: no-store` on API responses that genuinely are cacheable, which defeats the entire CDN tier and spikes origin load.

Surrogate keys are the mechanism you will use daily. When the origin emits `Surrogate-Key: product-42 category-shoes brand-nike`, Fastly tags that cached variant with all three keys. When the product price changes, the backend calls `PurgeBySurrogateKey(ctx, []string{"product-42"})` and Fastly evicts every cached object tagged with that key, across every POP, globally, in under 150ms. The worked example you should internalize is a product detail page that is cached per locale (`/en/product/42`, `/fr/product/42`, `/de/product/42`). One surrogate key `product-42` attached to all three variants means one purge call invalidates all locales atomically. Without surrogate keys you would need URL-based purges per locale, which does not scale past a few hundred variants.

The interview entry-point question sounds like "how would you invalidate a product page across 200 edge locations when inventory hits zero." The junior answer lists URL purge. The better answer is surrogate-key purge plus soft purge, because soft purge marks the object stale instead of deleting it, so in-flight requests still get a response from edge cache while the revalidation fetches fresh content from origin. Hard purge creates a brief origin stampede because every POP misses simultaneously. First-job context: your team almost certainly uses Terraform to manage Fastly services, so VCL changes go through a PR, not the UI. Learn `fastly service-version activate` and how to clone a version before editing.

### Senior @ FAANG: Instant Purge Internals, VCL vs Compute@Edge, and Origin Shield Economics

Fastly's sub-150ms global instant purge is not magic, it is a bimodal gossip protocol. The purge API writes to a central authority which publishes a purge record to a hash ring, and each POP subscribes to the slice of the ring relevant to the surrogate-key hash. The purge record propagates POP-to-POP via gossip rather than fan-out-from-origin, which is why p99 purge latency stays under 150ms even at 90+ POP scale. Understand the failure mode: during a regional partition, a POP may receive the purge record late. The defensive pattern is to couple soft-purge with a short `stale-while-revalidate` window so a partitioned POP still serves acceptably stale content, then reconciles when the partition heals. Never rely on purge as the sole consistency mechanism for anything with financial implications. Prices belong behind a content-addressed URL (`/price/v7/product-42`) where the path itself changes on price update, and the old URL simply ages out.

VCL versus Compute@Edge is the 2024-2026 architectural fork you must have an opinion on. VCL is Varnish-derived, declarative, and executes in a tightly sandboxed per-POP VM with sub-millisecond latency per hook. It is perfect for header manipulation, surrogate-key derivation, A/B bucketing via `client.identity`, and request coalescing. Compute@Edge runs WASM compiled from Rust, Go (via TinyGo), or JavaScript in Lucet/Wasmtime, giving you real code for origin selection, JWT validation with rotation, request shaping, and personalization. The cost model differs: VCL billing is request-based at edge, Compute@Edge bills on WASM execution time (measured in microseconds). The decision rule I apply in design review: if the logic fits in 50 lines of VCL and does not need crypto beyond HMAC, keep it VCL. If it needs structured logging, OpenTelemetry propagation, or calls a KV store, it belongs in Compute@Edge. Mixing both is common and supported: VCL for the hot path, `restart` into Compute@Edge for the complex branches.

Fastly Fiddle (fiddle.fastly.dev) is the debugging tool seniors underuse. It gives you a sandbox service where you can paste VCL, send synthetic requests, and inspect every hook (`vcl_recv`, `vcl_hash`, `vcl_fetch`, `vcl_deliver`) with variable values. Reproduce a production cache-key bug in Fiddle before touching production VCL. Pair this with Fastly's real-time log streaming (syslog endpoint over TLS to your log aggregator) and you can triage a cache-key collision within minutes rather than hours. The other underused tool is `vcl_log` with `std.log` plus a structured format, streamed to Honeycomb or Datadog, keyed by `req.http.Fastly-Client-IP` and a correlation ID you inject at `vcl_recv`.

Origin Shield is the second-level cache that every senior-track design uses and every junior design forgets. Without Origin Shield, a surrogate-key purge causes up to 90 POPs to miss simultaneously and hammer origin, a 90x amplification. With Origin Shield, one designated POP (typically closest to origin geographically) acts as the funnel: all other POPs fetch from the shield POP, which fetches from origin. One purge, one origin fetch, 89 shield-to-POP fills. The tradeoff is an extra hop of latency for the shield POP's region, usually 5-15ms. At Fastly's pricing, Origin Shield is a flat fee per shield POP and pays for itself on any service doing more than a few thousand origin RPS. Do not enable it for services where origin is already CDN-hosted or where the shield POP region is geographically hostile to your origin.

Fastly Image Optimizer (IO) deserves a design-review mention. It transforms images at edge based on query parameters (`?width=800&format=webp&quality=75`), caches per transformed variant, and is billed per transformation. The senior pattern is to normalize the query string in VCL before cache-key derivation, because `?width=800&quality=75` and `?quality=75&width=800` must hit the same cache entry. Use `querystring.filter_except` and `querystring.sort` in `vcl_hash`. Without this normalization you will see single-digit hit rates on an IO service and a surprise invoice. Delivery@Edge with the Next-gen WAF integration is the 2025 story for combining IO, Compute@Edge, and bot management in one config surface, and is worth evaluating if your current stack has three separate vendors for edge delivery, WAF, and bot detection.

The operational checklist I enforce on Fastly services: every surrogate-key scheme documented in a runbook with examples, purge operations idempotent and retried with jitter, soft-purge as default with hard-purge reserved for compliance removals, Origin Shield enabled for any origin doing >500 RPS at steady state, VCL changes gated through staging service with synthetic traffic replay, and real-time log streaming with a dashboard showing cache hit rate bucketed by surrogate-key namespace. Miss any of these and the first postmortem will teach you why they exist.

---
