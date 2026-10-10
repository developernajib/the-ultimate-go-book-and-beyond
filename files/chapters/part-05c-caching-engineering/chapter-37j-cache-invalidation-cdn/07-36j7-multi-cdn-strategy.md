## 37J.7 Multi-CDN Strategy

### Unified CDN Abstraction

Running multiple CDN providers (Cloudflare and Fastly, for instance) requires a unified interface so that the invalidation service does not need to know which CDNs are active. The `CDNProvider` interface below defines the two purge operations that all CDN clients must implement, and `MultiCDN` fans out purge calls to every registered provider in parallel.

```go
package cdn

import (
	"context"
	"fmt"
	"log/slog"
)

// CDNProvider abstraction for multi-CDN deployments
type CDNProvider interface {
	PurgeByTags(ctx context.Context, tags []string) error
	PurgeByURLs(ctx context.Context, urls []string) error
}

// MultiCDN manages multiple CDN providers simultaneously
type MultiCDN struct {
	providers []CDNProvider
	log       *slog.Logger
}

// PurgeByTags purges from all CDN providers in parallel
func (m *MultiCDN) PurgeByTags(ctx context.Context, tags []string) error {
	if len(tags) == 0 {
		return nil
	}

	errs := make(chan error, len(m.providers))

	for _, provider := range m.providers {
		go func(p CDNProvider) {
			errs <- p.PurgeByTags(ctx, tags)
		}(provider)
	}

	var failures []error
	for i := 0; i < len(m.providers); i++ {
		if err := <-errs; err != nil {
			failures = append(failures, err)
			m.log.Error("CDN purge failed", "err", err)
		}
	}

	if len(failures) > 0 {
		return fmt.Errorf("%d CDN purge(s) failed", len(failures))
	}
	return nil
}

// PurgeByURLs purges specific URLs from all CDN providers
func (m *MultiCDN) PurgeByURLs(ctx context.Context, urls []string) error {
	if len(urls) == 0 {
		return nil
	}

	errs := make(chan error, len(m.providers))
	for _, p := range m.providers {
		go func(provider CDNProvider) {
			errs <- provider.PurgeByURLs(ctx, urls)
		}(p)
	}

	for i := 0; i < len(m.providers); i++ {
		if err := <-errs; err != nil {
			m.log.Error("multi-CDN URL purge failed", "err", err)
		}
	}
	return nil
}

// CDNInvalidationService orchestrates cache invalidation across all layers
type CDNInvalidationService struct {
	cdn      CDNProvider
	redis    *RedisCache
	localBus *CacheInvalidationBus
	log      *slog.Logger
}

// InvalidateProduct invalidates all caches for a product update
func (s *CDNInvalidationService) InvalidateProduct(ctx context.Context, productID string) error {
	tags := []string{
		fmt.Sprintf("product:%s", productID),
		"products",
	}

	// 1. L1: broadcast to all app instances
	s.localBus.Publish(ctx, "product:"+productID)

	// 2. L2: Redis delete
	s.redis.Delete(ctx,
		fmt.Sprintf("product:%s", productID),
		fmt.Sprintf("product:%s:reviews", productID),
		fmt.Sprintf("product:%s:related", productID),
	)

	// 3. L3: CDN surrogate key purge
	if err := s.cdn.PurgeByTags(ctx, tags); err != nil {
		s.log.Error("CDN invalidation failed", "product_id", productID, "err", err)
		// Don't return error - CDN is eventually consistent anyway
		// TTL will expire stale content within max-age
	}

	return nil
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Multi-CDN means you put more than one CDN provider in front of origin, and a traffic steering layer decides which provider serves each user. The naive reason is redundancy. The real reasons are price arbitrage (CDN pricing varies 3x to 5x across providers by region), performance arbitrage (one CDN is faster in Jakarta, another in Sao Paulo), and bargaining leverage at renewal. If you are on your first multi-CDN rollout, the prerequisite concept is DNS-based steering. A CNAME `cdn.example.com` resolves differently per client based on a traffic director (NS1, Cedexis, Route53 with health checks), returning `fastly.example.com` to one user and `cloudfront.example.com` to another. The CDN the user hits is determined at DNS time, minutes before the HTTP request.

The first worked example that teaches the pattern: deploy the same origin behind both Fastly and CloudFront, use a traffic director to send 90 percent of traffic to Fastly and 10 percent to CloudFront, watch error rates and latency on both for a week. If CloudFront looks healthy, ramp to 50/50 and measure whether p99 latency improved in any region. If yes, that region splits per user, if no, send all of that region to whichever is cheaper. This is the day-to-day multi-CDN work.

Interview entry-point: "what do you do when one CDN has an outage." The junior answer is failover, which is correct but incomplete. The better answer is active-active with health-check-driven DNS steering, because failover alone has a DNS TTL window (typically 60 to 300 seconds) where users still hit the failed CDN. First-job context: learn how your traffic director actually fails open, what happens if the director itself is down (answer: browsers use cached DNS and the last known good CDN), and how purge across multiple CDNs must be idempotent because the abstraction in this file fans out purges in parallel and one CDN can succeed while another fails.

### Senior @ FAANG: GTM Architectures, RUM-based Steering, and Cost Optimization at Scale

The multi-CDN control plane is the staff-level design surface. Three architectural options dominate in 2026: (1) NS1 Pulsar / Cedexis (acquired by Citrix, now NetScaler ITM) use real-user measurement beacons embedded in your pages to build a live performance map of CDN-to-ASN pairs, then answer DNS queries with the best-performing CDN for that requesting resolver. (2) Cloudflare Load Balancer offers geo-steering and health-checked failover but keeps you within the Cloudflare ecosystem, which limits the price arbitrage advantage. (3) AWS Route 53 with latency-based routing and health checks is the budget option, accurate to the AWS region level but blind to actual client experience. For any service above roughly $50k/month CDN spend, RUM-driven steering pays for itself within the quarter through latency improvements and price optimization, because the steering engine can route India traffic to the CDN that is both fastest and cheapest in India.

Active-active versus failover is a policy decision, not a technology decision. Active-active means both CDNs receive production traffic continuously, so you know immediately if one breaks, origin is warm in both, and purge must hit both atomically. Failover means 100 percent traffic on CDN A, CDN B is cold standby, cheaper but with a cold-cache spike on cutover and no continuous validation that B works. The staff rule I apply: if downtime cost per hour exceeds 3x the monthly cost of the secondary CDN, go active-active. Otherwise, failover with weekly synthetic traffic replay to keep B warm suffices.

RUM-based CDN selection has subtleties. The beacon JS adds a network penalty (typically 50 to 200ms of background measurement per session), the measurement set must be statistically sufficient per ASN (at least 1,000 samples per hour per decision cell), and the steering engine must smooth over transient spikes (a single 5-minute packet-loss event on one CDN in one ASN should not flip all traffic away, because the flip itself causes a cold-cache miss storm). The parameters I tune in production: a 15-minute rolling window for decision data, a 10 percent hysteresis band to avoid flap, a hard floor of 5 percent traffic to every active CDN per region to keep the measurement set honest, and a manual override path for incident response.

Cost optimization per region is where multi-CDN earns its keep. CloudFront charges roughly $0.085/GB in North America and $0.17/GB in India and South America in 2026. Fastly and Cloudflare compete closer to $0.03 to $0.06/GB at committed-use tiers. Bunny CDN and BlazingCDN have entered the FAANG cost-conversation at $0.01/GB for specific geographies. The senior pattern: three-CDN deployment with Fastly or Cloudflare as primary in NA/EU where performance matters most, a budget CDN as primary in cost-sensitive regions like APAC-south and LATAM, CloudFront as tertiary because it integrates with your AWS origin via OAC and Lambda@Edge and you already have the contract. Model this in a spreadsheet with GB per region, blend rate per provider, and a 12-month projection, then feed the result to the steering engine as regional weights.

The invalidation fan-out shown in this file is correct but incomplete for production. Add (a) a per-provider retry with exponential backoff because CloudFront's CreateInvalidation throttles at 15 concurrent invalidations per distribution, (b) a circuit breaker per provider so a broken purge API does not block user-visible flows, (c) observability tags `cdn_provider` and `purge_type` on all metrics so you can see which provider's purge is failing, and (d) an audit log capturing every purge with correlation ID, initiator user/service, tag set, and per-provider result. The audit log pays dividends the first time Legal asks "prove this GDPR-subject content was invalidated from all edges by timestamp X." Without it, the answer is "we hope so."

Cache-key normalization must be identical across providers or you ship a consistency bug. If Fastly keys on `req.url.path + req.http.Accept-Language` and CloudFront keys on `uri + Accept-Language + User-Agent`, the same user request produces different cache variants on different CDNs and purge-by-tag misses. Document cache-key composition in a versioned spec, test it with synthetic probes across all providers nightly, and treat cache-key drift as a sev-3 incident.

---
