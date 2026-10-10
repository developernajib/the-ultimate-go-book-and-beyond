## 102N.5 Cost-Aware Architecture Patterns

### Data Transfer Cost Optimization

Data transfer is one of the most frequently overlooked cost drivers in AWS: cross-AZ traffic at $0.01/GB and internet egress at $0.09/GB accumulate quickly for data-intensive services. The `CompressingTransport` below wraps any `http.RoundTripper` and applies gzip compression to request bodies larger than 1 KB, transparently reducing egress volume without requiring changes at the call site. The `StorageTieringManager` pairs with this by applying a lifecycle policy that automatically cascades S3 objects from Standard through Standard-IA, Glacier Instant Retrieval, and Deep Archive as objects age, cutting per-GB storage cost from $0.023 down to $0.00099 for archival data.

```go
package datatransfer

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// DataTransfer costs in AWS (simplified, region-dependent):
// - Same region: free
// - Cross-AZ: $0.01/GB
// - Internet egress: $0.09/GB (first 10TB)
// - CloudFront: $0.0085/GB (cheaper than direct)

// CompressingTransport compresses HTTP bodies to reduce data transfer costs
type CompressingTransport struct {
	base            http.RoundTripper
	minSizeBytes    int
	compressionLevel int
}

func NewCompressingTransport(base http.RoundTripper) *CompressingTransport {
	return &CompressingTransport{
		base:            base,
		minSizeBytes:    1024, // compress if > 1KB
		compressionLevel: gzip.BestSpeed,
	}
}

func (t *CompressingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Don't compress if already compressed or small body
	if req.Body == nil || req.ContentLength < int64(t.minSizeBytes) {
		return t.base.RoundTrip(req)
	}
	if req.Header.Get("Content-Encoding") != "" {
		return t.base.RoundTrip(req)
	}

	// Read and compress body
	body, err := io.ReadAll(req.Body)
	req.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	var buf bytes.Buffer
	w, err := gzip.NewWriterLevel(&buf, t.compressionLevel)
	if err != nil {
		return nil, fmt.Errorf("gzip writer: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return nil, fmt.Errorf("gzip write: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("gzip close: %w", err)
	}

	compressed := buf.Bytes()
	// Only use compression if it actually reduces size
	if len(compressed) >= len(body) {
		req.Body = io.NopCloser(bytes.NewReader(body))
		return t.base.RoundTrip(req)
	}

	req.Body = io.NopCloser(bytes.NewReader(compressed))
	req.ContentLength = int64(len(compressed))
	req.Header.Set("Content-Encoding", "gzip")

	return t.base.RoundTrip(req)
}

// BatchingClient batches API calls to reduce per-call costs
type BatchingClient struct {
	maxBatchSize  int
	maxWaitMS     int
	pending       []any
	resultCh      chan batchResult
	pendingCh     chan pendingRequest
	flushCh       chan struct{}
}

type pendingRequest struct {
	item     any
	resultCh chan batchResult
}

type batchResult struct {
	results []any
	err     error
}

// RegionAffinityRouter routes requests to the same region as data
type RegionAffinityRouter struct {
	regions map[string]string // datacenter → AWS region
}

func (r *RegionAffinityRouter) SelectRegion(userIP string) string {
	// Use IP geolocation to determine nearest region
	// This avoids unnecessary cross-region data transfer
	region, ok := r.regions[detectDatacenter(userIP)]
	if !ok {
		return "us-east-1" // default
	}
	return region
}

func detectDatacenter(ip string) string {
	// Simplified - use ip2location or similar in production
	return "us-east"
}

// StorageTieringManager manages S3 storage class transitions
type StorageTieringManager struct {
	s3Client *s3.Client
}

// S3 storage class costs (per GB/month, simplified):
// Standard:           $0.023
// Standard-IA:        $0.0125 (min 30 days, min 128KB, $0.01/GB retrieval)
// One Zone-IA:        $0.01   (no redundancy across AZs)
// Glacier Instant:    $0.004  (min 90 days, $0.03/GB retrieval)
// Glacier Flexible:   $0.0036 (min 90 days, 3-5hr retrieval, $0.01/GB)
// Glacier Deep:       $0.00099(min 180 days, 12-48hr retrieval, $0.02/GB)

// SetLifecyclePolicy applies cost-optimizing lifecycle transitions
func (m *StorageTieringManager) SetLifecyclePolicy(ctx context.Context, bucket string) error {
	_, err := m.s3Client.PutBucketLifecycleConfiguration(ctx, &s3.PutBucketLifecycleConfigurationInput{
		Bucket: aws.String(bucket),
		LifecycleConfiguration: &s3types.BucketLifecycleConfiguration{
			Rules: []s3types.LifecycleRule{
				{
					ID:     aws.String("cost-optimization"),
					Status: s3types.ExpirationStatusEnabled,
					Filter: &s3types.LifecycleRuleFilter{Prefix: aws.String("data/")},
					Transitions: []s3types.Transition{
						{
							Days:         aws.Int32(30),
							StorageClass: s3types.TransitionStorageClassStandardIa,
						},
						{
							Days:         aws.Int32(90),
							StorageClass: s3types.TransitionStorageClassGlacierIr,
						},
						{
							Days:         aws.Int32(365),
							StorageClass: s3types.TransitionStorageClassDeepArchive,
						},
					},
					Expiration: &s3types.LifecycleExpiration{
						Days: aws.Int32(2555), // 7 years
					},
				},
			},
		},
	})
	return err
}
```

---

### Junior → FAANG: Cost-Aware Patterns as Day-One Architecture Habits

The data transfer optimization patterns in this section (same-AZ routing, VPC endpoints, compression, CloudFront for static assets) address the cost category that most engineers underestimate: data transfer. EC2 compute costs are visible in instance pricing calculators. Data transfer costs are invisible until the monthly bill arrives and shows a line item that rivals the compute cost.

The four highest-ROI patterns to apply immediately: first, use VPC endpoints for S3 and DynamoDB access to eliminate NAT gateway data processing charges (typically $0.045/GB through NAT vs $0.00/GB through VPC endpoint). Second, co-locate services that communicate frequently in the same AZ to eliminate inter-AZ transfer charges ($0.01/GB in most regions). Third, enable compression for API responses larger than 1KB (gzip or brotli) to reduce data transfer volume by 60-80% for JSON payloads. Fourth, use CloudFront for any static content or public API responses that can be cached, as CloudFront-to-internet pricing is lower than EC2-to-internet pricing.

### Senior @ FAANG: Cost-Aware Architecture as a Design Review Criterion

At staff level, cost awareness is a design review criterion alongside performance, reliability, and security. An architecture review that approves a cross-region replication design without a data transfer cost estimate is incomplete. The cost estimate does not need to be precise: a rough order-of-magnitude estimate (this design will transfer approximately X GB/month cross-region at $0.02/GB, adding approximately $Y/month to the infrastructure cost) is sufficient to surface whether the design is cost-appropriate for the expected value it delivers.

The unit economics pattern in this section (cost per request, cost per user) connects architecture decisions to business metrics in a way that pure infrastructure cost does not. An architecture that costs $50,000/month is expensive or cheap depending on whether it serves 1,000 users or 1,000,000 users. Framing infrastructure cost as cost per unit of business value (cost per request, cost per active user, cost per transaction) creates the context for a meaningful cost efficiency conversation: the goal is to reduce cost per unit while maintaining or improving the unit's quality, not to minimize absolute infrastructure cost at the expense of reliability or user experience.

The organizational implementation: include a cost-per-unit section in capacity planning documents. When a service projects traffic growth from 100K to 1M daily active users, the capacity plan should include the projected infrastructure cost at the new scale and the target cost-per-user that the team is committing to maintain. This creates a feedback loop between architecture decisions (do we cache at the CDN layer or at the application layer?) and business outcomes (does caching reduce cost-per-user below the target?). The feedback loop is the mechanism that makes cost efficiency a sustained organizational behavior rather than a periodic optimization sprint.
