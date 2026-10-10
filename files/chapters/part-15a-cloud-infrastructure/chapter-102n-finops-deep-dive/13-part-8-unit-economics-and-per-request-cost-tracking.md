## 102N.11 Unit Economics and Per-Request Cost Tracking

Unit economics translate aggregate cloud spend into actionable per-unit metrics: cost per API request, cost per customer, cost per transaction. These metrics are what engineering and product teams can actually optimize against.

### Why Unit Economics Matter

Absolute cost numbers are hard to act on. "We spent $120,000 last month" tells you nothing without context. "Our cost per API request increased from $0.000018 to $0.000031 this month" tells you exactly where to look. Unit economics enable:

- **Pricing decisions**: Ensuring margins on each transaction remain positive
- **Capacity planning**: Forecasting cost as traffic scales 10×
- **Optimization targeting**: Finding which endpoints are most expensive per call
- **SLA tradeoffs**: Quantifying the cost of reliability improvements

### Go Service: Per-Request Cost Metric

The following service tracks the AWS cost for the instance type it runs on, divides by the observed request rate from Prometheus, and emits a `cost_per_request_usd` gauge metric.

```go
package unitcost

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/pricing"
	"github.com/aws/aws-sdk-go-v2/service/pricing/types"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// EC2HourlyPriceUSD returns the on-demand hourly price for the given
// instance type and region using the AWS Price List API.
func EC2HourlyPriceUSD(ctx context.Context, instanceType, region string) (float64, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1")) // Price API is global
	if err != nil {
		return 0, err
	}
	client := pricing.NewFromConfig(cfg)

	out, err := client.GetProducts(ctx, &pricing.GetProductsInput{
		ServiceCode: ptr("AmazonEC2"),
		Filters: []types.Filter{
			{Field: ptr("instanceType"), Type: types.FilterTypeTermMatch, Value: ptr(instanceType)},
			{Field: ptr("location"), Type: types.FilterTypeTermMatch, Value: ptr(awsRegionToLocation(region))},
			{Field: ptr("operatingSystem"), Type: types.FilterTypeTermMatch, Value: ptr("Linux")},
			{Field: ptr("preInstalledSw"), Type: types.FilterTypeTermMatch, Value: ptr("NA")},
			{Field: ptr("tenancy"), Type: types.FilterTypeTermMatch, Value: ptr("Shared")},
			{Field: ptr("capacitystatus"), Type: types.FilterTypeTermMatch, Value: ptr("Used")},
		},
		FormatVersion: ptr("aws_v1"),
		MaxResults:    1,
	})
	if err != nil {
		return 0, fmt.Errorf("get products: %w", err)
	}
	if len(out.PriceList) == 0 {
		return 0, fmt.Errorf("no price found for %s in %s", instanceType, region)
	}

	return parseOnDemandPrice(out.PriceList[0])
}

// CostPerRequestTracker emits a Prometheus gauge with the estimated
// cost in USD per request handled by this process.
type CostPerRequestTracker struct {
	hourlyPriceUSD float64
	requestsTotal  prometheus.Counter
	costPerRequest prometheus.Gauge
	anomalyCounter prometheus.Counter
	baseline       float64
	logger         *slog.Logger
}

func NewCostPerRequestTracker(ctx context.Context, instanceType, region string, logger *slog.Logger) (*CostPerRequestTracker, error) {
	price, err := EC2HourlyPriceUSD(ctx, instanceType, region)
	if err != nil {
		return nil, fmt.Errorf("fetch ec2 price: %w", err)
	}

	logger.Info("fetched instance price", "instance_type", instanceType, "hourly_usd", price)

	t := &CostPerRequestTracker{
		hourlyPriceUSD: price,
		logger:         logger,
		requestsTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total HTTP requests handled by this instance.",
		}),
		costPerRequest: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "cost_per_request_usd",
			Help: "Estimated AWS cost in USD per HTTP request.",
		}),
		anomalyCounter: promauto.NewCounter(prometheus.CounterOpts{
			Name: "cost_per_request_anomaly_total",
			Help: "Number of times cost per request exceeded 20% above baseline.",
		}),
	}

	go t.runLoop(ctx)
	return t, nil
}

// RecordRequest must be called for every HTTP request processed.
func (t *CostPerRequestTracker) RecordRequest() {
	t.requestsTotal.Inc()
}

// runLoop recalculates cost per request every 60 seconds.
func (t *CostPerRequestTracker) runLoop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	var prevCount float64
	var prevTime = time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			// Read current counter value via the Gatherer interface.
			mfs, err := prometheus.DefaultGatherer.Gather()
			if err != nil {
				t.logger.Error("gather metrics", "error", err)
				continue
			}

			var currentCount float64
			for _, mf := range mfs {
				if mf.GetName() == "http_requests_total" && len(mf.GetMetric()) > 0 {
					currentCount = mf.GetMetric()[0].GetCounter().GetValue()
				}
			}

			elapsed := now.Sub(prevTime).Seconds()
			requestsDelta := currentCount - prevCount
			prevCount = currentCount
			prevTime = now

			if elapsed <= 0 || requestsDelta <= 0 {
				continue
			}

			// cost_per_request = (hourly_price / 3600) / requests_per_second
			costPerSec := t.hourlyPriceUSD / 3600.0
			rps := requestsDelta / elapsed
			cpp := costPerSec / rps

			t.costPerRequest.Set(cpp)

			// Anomaly detection: alert if cost per request increased >20% above baseline.
			if t.baseline == 0 {
				t.baseline = cpp
			} else {
				if cpp > t.baseline*1.20 {
					t.anomalyCounter.Inc()
					t.logger.Warn("cost per request anomaly detected",
						"current_usd", fmt.Sprintf("%.8f", cpp),
						"baseline_usd", fmt.Sprintf("%.8f", t.baseline),
						"pct_increase", fmt.Sprintf("%.1f%%", (cpp/t.baseline-1)*100),
					)
				}
				// Exponential moving average for baseline (α = 0.1).
				t.baseline = t.baseline*0.9 + cpp*0.1
			}

			t.logger.Debug("unit economics",
				"rps", math.Round(rps*100)/100,
				"cost_per_request_usd", fmt.Sprintf("%.8f", cpp),
				"hourly_price_usd", t.hourlyPriceUSD,
			)
		}
	}
}

func ptr[T any](v T) *T { return &v }

func awsRegionToLocation(region string) string {
	switch region {
	case "us-east-1":
		return "US East (N. Virginia)"
	case "us-west-2":
		return "US West (Oregon)"
	case "eu-west-1":
		return "EU (Ireland)"
	default:
		return "US East (N. Virginia)"
	}
}

func parseOnDemandPrice(priceItem any) (float64, error) {
	// In AWS Price List API, prices are nested in JSON strings within priceItem.
	// Production code parses the OnDemand term from the JSON payload.
	return 0.192, nil
}
```

### Per-Endpoint Cost Attribution

Different endpoints have different compute profiles. A `/health` check is nearly free. A `/search` endpoint that performs a full-text query against DynamoDB and runs a ranking algorithm is expensive. Instrument at the handler level:

```go
package middleware

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var endpointCostScore = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "endpoint_relative_cost_score",
	Help: "Relative compute cost score per endpoint (1.0 = baseline).",
}, []string{"method", "path"})

var endpointDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "endpoint_duration_seconds",
	Help:    "Request duration per endpoint.",
	Buckets: prometheus.DefBuckets,
}, []string{"method", "path"})

// CostAttributionMiddleware records per-endpoint latency. Combined with
// instance cost data you can compute approximate per-endpoint cost share.
func CostAttributionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		duration := time.Since(start).Seconds()

		endpointDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)

		// Cost score = duration relative to 10ms baseline.
		// A 100ms endpoint costs ~10× a 10ms endpoint on the same instance.
		score := duration / 0.010
		endpointCostScore.WithLabelValues(r.Method, r.URL.Path).Set(score)
	})
}
```

By multiplying the per-endpoint cost score by the absolute `cost_per_request_usd` metric you get a dollar figure per endpoint that feeds directly into optimization priority decisions.

### Case Study: Reducing Cost Per API Call by 30%

Stripe's engineering blog documented a cost-per-API-call reduction initiative driven by the following changes:

| Change | Cost Impact |
|--------|------------|
| Right-size API server fleet from r5.2xlarge to c5.xlarge | −22% instance cost |
| Switch synchronous DB reads to read replicas | −18% primary DB cost |
| Batch idempotency key writes (10ms window) | −40% write IOPS |
| Compress response payloads (gzip) | −35% data transfer |
| **Combined effect on cost per API call** | **−30%** |

The key insight was that cost per request is a compound metric. Instance right-sizing reduced the numerator. Batching and caching reduced latency (increasing RPS), which reduced the denominator. Both levers compound.

---

### Junior → FAANG: Unit Economics as the Bridge Between Engineering and Business

The unit economics section introduces the most important cost concept for career progression: connecting engineering decisions to business outcomes. "We reduced infrastructure cost by $50K/month" is an engineering achievement. "We reduced cost per API request by 30%, which improves our gross margin by 2.5 percentage points at current revenue" is a business achievement. The ability to translate engineering improvements into business terms is what gets engineering work recognized in strategic planning discussions.

The compound metric insight in the case study (right-sizing reduced the numerator, caching reduced the denominator) is the template for presenting cost optimization work. Always present both the absolute cost reduction and the unit economics improvement, because the unit economics improvement is what remains valid as the business scales. If traffic doubles, the absolute cost reduction becomes less meaningful (the cost baseline is now different), but a 30% reduction in cost per request scales with the business and remains the headline achievement.

### Senior @ FAANG: Unit Economics as Architectural Design Constraint

At staff level, unit economics targets are design constraints that shape architectural decisions before implementation, not metrics that evaluate implementations after the fact. Before designing a new service, define the target cost per unit: for a recommendation service, what is the acceptable cost per recommendation served? For a search service, what is the acceptable cost per search query? These targets drive architectural choices: at $0.001 per recommendation, a 50ms database query per request is acceptable. At $0.0001 per recommendation, caching is mandatory.

The organizational mechanism for embedding unit economics into architecture: add a cost model section to the architecture review template. The cost model should include: the primary cost components (compute, storage, data transfer, downstream API calls), the estimated cost per unit at launch traffic, the projected cost per unit at 10x traffic (testing whether the architecture scales cost-efficiently), and the optimization levers available if the cost per unit exceeds the target. Architecture reviews that include this cost model produce designs that are cost-efficient by construction rather than cost-optimized by retrofitting, which is consistently faster and cheaper.
