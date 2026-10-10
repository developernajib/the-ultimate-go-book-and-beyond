## 37J.4 CDN Integration: Cloudflare

### Cloudflare Cache API

Cloudflare exposes three purge modes through its REST API: purge by URL (available on all plans), purge by cache tag (Enterprise only), and purge everything. The Go client below wraps all three, batching URL purges to respect Cloudflare's 30-URLs-per-request limit and querying Cloudflare's GraphQL analytics endpoint to track cache hit rates and bandwidth savings.

```go
package cdn

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// CloudflareClient handles Cloudflare cache operations
type CloudflareClient struct {
	apiToken string
	zoneID   string
	baseURL  string
	http     *http.Client
	log      *slog.Logger
}

// NewCloudflareClient creates a Cloudflare CDN client
func NewCloudflareClient(apiToken, zoneID string, log *slog.Logger) *CloudflareClient {
	return &CloudflareClient{
		apiToken: apiToken,
		zoneID:   zoneID,
		baseURL:  "https://api.cloudflare.com/client/v4",
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
		log: log,
	}
}

// PurgeByURLs purges specific URLs from Cloudflare cache
func (c *CloudflareClient) PurgeByURLs(ctx context.Context, urls []string) error {
	if len(urls) == 0 {
		return nil
	}

	// Cloudflare limit: 30 URLs per request
	for i := 0; i < len(urls); i += 30 {
		end := min(i+30, len(urls)) // builtin min (Go 1.21+)
		batch := urls[i:end]

		if err := c.purgeURLBatch(ctx, batch); err != nil {
			return fmt.Errorf("purge batch %d: %w", i/30, err)
		}
	}
	return nil
}

func (c *CloudflareClient) purgeURLBatch(ctx context.Context, urls []string) error {
	body, _ := json.Marshal(map[string]any{
		"files": urls,
	})

	url := fmt.Sprintf("%s/zones/%s/purge_cache", c.baseURL, c.zoneID)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cloudflare API: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Success  bool   `json:"success"`
		Errors   []struct{ Message string `json:"message"` } `json:"errors"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		if len(result.Errors) > 0 {
			return fmt.Errorf("cloudflare purge error: %s", result.Errors[0].Message)
		}
		return fmt.Errorf("cloudflare purge failed")
	}

	c.log.Info("cloudflare cache purged", "url_count", len(urls))
	return nil
}

// PurgeByTags purges cache entries by Cache-Tag headers
// Requires Cloudflare Enterprise plan
func (c *CloudflareClient) PurgeByTags(ctx context.Context, tags []string) error {
	if len(tags) == 0 {
		return nil
	}

	body, _ := json.Marshal(map[string]any{
		"tags": tags,
	})

	url := fmt.Sprintf("%s/zones/%s/purge_cache", c.baseURL, c.zoneID)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Success bool `json:"success"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	if !result.Success {
		return fmt.Errorf("cloudflare tag purge failed")
	}

	c.log.Info("cloudflare cache purged by tags", "tags", tags)
	return nil
}

// PurgeEverything purges the entire CDN cache (use with caution!)
func (c *CloudflareClient) PurgeEverything(ctx context.Context) error {
	body, _ := json.Marshal(map[string]any{
		"purge_everything": true,
	})

	url := fmt.Sprintf("%s/zones/%s/purge_cache", c.baseURL, c.zoneID)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	c.log.Warn("cloudflare entire cache purged")
	return nil
}

// GetCacheAnalytics returns CDN cache statistics
func (c *CloudflareClient) GetCacheAnalytics(ctx context.Context, since, until time.Time) (*CacheAnalytics, error) {
	// GraphQL API for Cloudflare analytics
	query := `{
		viewer {
			zones(filter: {zoneTag: $zoneTag}) {
				httpRequests1dGroups(
					limit: 100
					filter: {date_geq: $since, date_leq: $until}
				) {
					sum {
						requests
						cachedRequests
						bytes
						cachedBytes
					}
					dimensions {
						date
					}
				}
			}
		}
	}`

	body, _ := json.Marshal(map[string]any{
		"query": query,
		"variables": map[string]any{
			"zoneTag": c.zoneID,
			"since":   since.UTC().Format("2006-01-02"),
			"until":   until.UTC().Format("2006-01-02"),
		},
	})

	req, err := http.NewRequestWithContext(ctx, "POST",
		"https://api.cloudflare.com/client/v4/graphql",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result CacheAnalytics
	json.NewDecoder(resp.Body).Decode(&result)
	return &result, nil
}

type CacheAnalytics struct {
	TotalRequests   int64
	CachedRequests  int64
	TotalBytes      int64
	CachedBytes     int64
	CacheHitRate    float64
	BandwidthSaving float64
}
```

### Junior → FAANG: what each purge mode actually costs you

Cloudflare gives you four purge primitives and they are not interchangeable. Purge by URL is available on every plan, takes exact URLs including query string, and is the safest, you know exactly what you evict. Its weakness is that the same logical page often has many URL variants (tracking query params, AMP, mobile, language prefixes) and missing one leaves stale copies serving. Purge by hostname lets you wipe every cached asset on a subdomain, useful for a bad deploy rollback. Purge by prefix wipes a URL subtree. Purge by tag (the `Cache-Tag` header the service sets on responses, requires Enterprise) is the one the code above uses, and it is what makes event-driven invalidation practical, because your Kafka consumer does not need to know every URL that references a product, it only needs to know the tag. Purge everything is the nuclear option, it wipes the entire zone, and within seconds every edge node is a miss and your origin is taking traffic it has not seen in hours. This is how outages happen. A junior who runs `purge_everything` during business hours to fix "one bad page" has triggered a thundering herd that can saturate the origin and cause a real outage. Guard that method behind a role check, a confirmation token, and a rate limiter that caps it to once per hour. For an interview, if asked "how would you invalidate the homepage after a hero banner update," the right answer is tag purge if on Enterprise, URL purge with the small list of homepage variants otherwise, never purge everything.

### Senior @ FAANG: Cloudflare as a programmable edge, not just a cache

Staff-level use of Cloudflare goes beyond the purge API. You are operating a programmable edge and the primitives matter. Cache Rules (the 2023 replacement for Page Rules and the older Cache Level setting) let you declaratively specify, per URL pattern and per request attribute, the edge TTL, browser TTL, cache key composition, and whether to bypass cache. The cache key is the single most important knob. By default it includes host, scheme, path, and query string. Customizing the cache key (Enterprise) lets you drop tracking params like `utm_source`, fold query params into a canonical order, include a device-type header set by a Worker so mobile and desktop share no cache slots but all iPhones do, and include or exclude cookies surgically. Getting the cache key right often lifts hit ratio from 40% to 90% without changing a single Cache-Control header. Tiered Caching (a.k.a. Argo Tiered Cache) introduces a hierarchy where regional hubs aggregate requests from edge PoPs before reaching your origin, which collapses the thundering herd across PoPs into a single origin request and raises origin offload dramatically, and it is nearly always worth enabling for any production zone. Cache Reserve extends this by persisting cache entries to R2 (Cloudflare's S3-compatible object store) with a 30-day minimum retention, which is the difference between "my asset stays hot at 1000 rps" and "my asset stays hot at 1 rph" for long-tail content. Workers KV is eventually consistent globally replicated key-value storage readable from a Worker in single-digit milliseconds at any PoP, ideal for feature flags, A/B assignments, and per-user routing rules where you need edge logic without an origin round trip. The Cache API available inside Workers (`caches.default`) lets you read and write the edge cache programmatically, enabling patterns like cache-by-device-type where the Worker rewrites the cache key before calling `cache.match`, serves the hit directly, or falls through to origin and then `cache.put`s the response. Surrogate-Key plus tag purge plus Workers plus Cache Reserve is the stack that powers serving strategies at Cloudflare-fronted properties like Discord and Canva. The operational discipline is treating the Cloudflare config as code. The cache rules, worker scripts, and purge tokens all live in a Terraform repo with reviewed PRs, because a manual change in the dashboard at 2am is how you ship an outage. Observability matters as much as the config. Export the GraphQL analytics into Prometheus or Datadog, alert on hit ratio dropping below a zone-specific SLO, alert on `Age` header distribution shifting (which catches broken purges before customers notice), and alert on origin egress spiking (which catches cache key regressions). The goal is not to make the CDN faster, it is to make the origin irrelevant to p99 latency and resilient to regional CDN failures via `stale-if-error` and multi-CDN failover (Cloudflare plus Fastly in parallel, with DNS-based or client-side failover, is a pattern at the largest scale). Finally, never forget that a CDN is a security surface. Enable Authenticated Origin Pulls so the origin only accepts requests signed by Cloudflare, enable WAF rules and rate limiting at the edge, and strip or validate host headers to prevent cache poisoning where an attacker sends `Host: victim.com` to your origin and the CDN caches the poisoned response under the victim's cache key. This integrated view, edge as code, edge as cache, edge as security, edge as compute, is what staff interviewers are probing when they ask "tell me how you would design the CDN tier for this product."

---
