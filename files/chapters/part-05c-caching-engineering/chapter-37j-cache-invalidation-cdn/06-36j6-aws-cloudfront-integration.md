## 37J.6 AWS CloudFront Integration

### CloudFront Cache Invalidation

CloudFront differs from Cloudflare and Fastly in that it lacks tag-based purging. invalidation targets URL paths instead, and AWS charges per path after the first 1,000 invalidations per month. The Go client below wraps the AWS SDK v2 to create path invalidations, poll for completion, and issue wildcard purges when an entire prefix needs clearing.

```go
package cdn

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
)

// CloudFrontClient handles CloudFront cache invalidations
type CloudFrontClient struct {
	client         *cloudfront.Client
	distributionID string
	log            *slog.Logger
}

// NewCloudFrontClient creates an AWS CloudFront client
func NewCloudFrontClient(ctx context.Context, region, distributionID string, log *slog.Logger) (*CloudFrontClient, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}

	return &CloudFrontClient{
		client:         cloudfront.NewFromConfig(cfg),
		distributionID: distributionID,
		log:            log,
	}, nil
}

// InvalidatePaths invalidates specific URL paths
// CloudFront: $0.005 per path after first 1000/month
func (c *CloudFrontClient) InvalidatePaths(ctx context.Context, paths []string) (string, error) {
	if len(paths) == 0 {
		return "", nil
	}

	items := make([]string, len(paths))
	copy(items, paths)

	result, err := c.client.CreateInvalidation(ctx, &cloudfront.CreateInvalidationInput{
		DistributionId: aws.String(c.distributionID),
		InvalidationBatch: &types.InvalidationBatch{
			CallerReference: aws.String(fmt.Sprintf("%d", time.Now().UnixNano())),
			Paths: &types.Paths{
				Quantity: aws.Int32(int32(len(items))),
				Items:    items,
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("cloudfront invalidation: %w", err)
	}

	invalidationID := aws.ToString(result.Invalidation.Id)
	c.log.Info("cloudfront invalidation created",
		"id", invalidationID,
		"paths", len(paths),
	)
	return invalidationID, nil
}

// WaitForInvalidation waits until invalidation completes
func (c *CloudFrontClient) WaitForInvalidation(ctx context.Context, invalidationID string) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	timeout := time.After(5 * time.Minute)

	for {
		select {
		case <-timeout:
			return fmt.Errorf("timeout waiting for invalidation %s", invalidationID)
		case <-ticker.C:
			result, err := c.client.GetInvalidation(ctx, &cloudfront.GetInvalidationInput{
				DistributionId: aws.String(c.distributionID),
				Id:             aws.String(invalidationID),
			})
			if err != nil {
				return err
			}

			status := aws.ToString(result.Invalidation.Status)
			c.log.Debug("invalidation status", "id", invalidationID, "status", status)

			if status == "Completed" {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// InvalidateWildcard invalidates all paths under a prefix
// Use sparingly: /products/* invalidates all product pages
func (c *CloudFrontClient) InvalidateWildcard(ctx context.Context, prefix string) (string, error) {
	path := prefix
	if !strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "/") + "/*"
	}
	return c.InvalidatePaths(ctx, []string{path})
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

CloudFront is AWS's CDN, and its mental model is different from Fastly in three ways that trip every junior. First, there are no surrogate keys. Invalidation is path-based (`/products/42`) or wildcard (`/products/*`), and you pay per path invalidated after the first 1,000 per month. Second, cache behaviors are configured declaratively on the distribution, not in runtime code, so you cannot change TTLs or origin routing without a distribution update, which propagates in minutes. Third, CloudFront has a two-tier cache: edge POPs in front of regional edge caches. A request path goes browser -> edge POP -> regional edge cache -> origin. The regional tier catches misses from several edge POPs and shields origin.

The worked example your first ticket will resemble: a product goes on sale, marketing wants the homepage and the product page refreshed immediately. You call `InvalidatePaths(ctx, []string{"/", "/products/42"})` which costs two paths. Resist the reflex to invalidate `/*` because that counts as one path but evicts everything and spikes origin cost. If you find yourself invalidating wildcards often, the design is wrong, and the fix is versioned URLs or a stale-while-revalidate behavior on the cache policy.

The interview entry-point topic is "why is CloudFront invalidation slow and expensive compared to Fastly, and what do you do about it." The senior-track answer is: you design so you rarely need invalidation. Use `Cache-Control: max-age=60, stale-while-revalidate=3600`, versioned asset URLs, and ETag-driven conditional requests. Reserve `CreateInvalidation` for compliance takedowns and emergency rollbacks. First-job context: your team's distribution config lives in CDK or Terraform, cache policies and origin request policies are separate resources in 2026, and changing a cache behavior means a distribution deployment that takes 3 to 5 minutes to reach all POPs. Learn to use `aws cloudfront get-distribution` and watch the `Status: InProgress` to `Deployed` transition.

### Senior @ FAANG: Invalidation Economics, Lambda@Edge vs Functions, OAC, and KeyValueStore

CloudFront invalidation pricing is the first thing a staff engineer interrogates. $0.005 per path after the free 1,000/month sounds trivial until a buggy webhook handler invalidates 50,000 paths on a cache-miss storm, which is a $245 surprise on one service per day. The architectural response is a dedupe-and-coalesce layer in Go: accept invalidation requests into a bounded channel, window them over 2 to 5 seconds, dedupe by path, collapse adjacent paths into wildcards when safe, and submit a single `CreateInvalidation` call with up to 3,000 paths in a single batch. Wildcards count as one path regardless of how many objects they clear, so a coalescing layer that converts `/products/42`, `/products/42/reviews`, `/products/42/related` into `/products/42*` is pure margin. Build this once, reuse across every service that touches CloudFront.

Lambda@Edge versus CloudFront Functions is the architectural fork. CloudFront Functions run in a proprietary JS runtime with sub-millisecond cold start, 1ms CPU budget, 2KB request/response size cap, no network calls, no file system, no KV until 2024. They fire on viewer-request and viewer-response, not origin-request. Use them for header rewrites, URL normalization, A/B bucketing cookie assignment, HTTP to HTTPS redirects, and host/path routing. Lambda@Edge runs Node.js or Python (2026: Python 3.13 and Node 22), supports viewer-request, origin-request, origin-response, and viewer-response, has a full VPC reachable runtime, and bills per-invocation at Lambda rates plus a regional premium. Use it when you need DynamoDB lookup for personalization, Secrets Manager for signed URL minting, or KMS decrypt for edge-side crypto. The decision rule: if it does not need network, it is a CloudFront Function. If you find yourself wanting network, first check whether KeyValueStore can serve the data from edge.

CloudFront KeyValueStore (launched late 2023, matured through 2024-2025) is the feature seniors should reach for before Lambda@Edge. It provides a globally replicated KV readable from CloudFront Functions with single-digit millisecond lookup. The design pattern: write feature flags, redirect maps, geo routing tables, and A/B assignments to KVS from a control plane, read from CloudFront Functions at viewer-request. This eliminates 80 percent of the Lambda@Edge use cases and cuts per-request cost by roughly 10x. KVS has a 5MB total size cap and 1KB per-key value cap in 2026, so it is unsuitable for user-keyed data, but ideal for config plane data.

Origin Access Control (OAC) replaces the deprecated Origin Access Identity (OAI) and is mandatory for any S3 origin in 2026. OAC signs CloudFront-to-S3 requests with SigV4, supports KMS-encrypted S3 buckets (OAI did not), and works with cross-region buckets. The bucket policy grants access only to the specific CloudFront distribution ARN via the `AWS:SourceArn` condition. Every new S3 origin should land as OAC from day one, and migrating legacy OAI distributions is a staff-level project because the bucket policy cutover must coordinate with distribution propagation to avoid a window where public access is needed.

Regional edge caches (RECs) are the unsung hero of CloudFront's economics. RECs sit between the 600+ edge POPs and origin, and they exist in roughly 13 AWS regions. A miss at an edge POP in Mumbai consults the REC in ap-south-1 before going to origin in us-east-1. This dramatically reduces origin fetches and is free, no config required. The trap is that invalidation propagates to both tiers but the propagation to RECs can lag edge POPs by 30 to 60 seconds in observation. Any consistency critical use case must either version the URL or use a short TTL with `stale-while-revalidate`.

Cost optimization patterns I enforce in review: set a `DefaultTTL` explicitly on every cache policy (the AWS default of 24 hours bites on stale content incidents), use `Origin Shield` in the region closest to origin for any service exceeding 1,000 origin RPS, enable CloudFront compression so origin can stop gzipping, use HTTP/3 via QUIC (GA on CloudFront in 2022) for mobile-heavy workloads, and route all API traffic through a separate distribution from static content so invalidation blast radius stays bounded. The observability hookup is CloudFront real-time logs to Kinesis Firehose to S3 with Athena on top, partitioned by date and distribution, and a Grafana dashboard showing hit rate, origin latency p99, and invalidation volume per service. Miss the invalidation volume panel and you will find out about the $245/day bug from finance, not your own monitoring.

---
