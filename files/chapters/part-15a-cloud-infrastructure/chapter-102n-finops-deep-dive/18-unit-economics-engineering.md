## 102N.16 Unit Economics Engineering

Unit economics engineering answers a deceptively simple question: what does it cost to serve one request? Answering it precisely requires attributing cloud infrastructure costs - billed monthly in aggregate - to individual API endpoints, features, and teams at request granularity. The result is a `cost_per_request_usd` metric that makes engineering trade-offs financially legible.

### Cost Per Request Model

The fundamental model is:

```
cost_per_request = (total_infrastructure_cost / billing_period) / total_requests_in_period
```

At scale you need per-endpoint granularity because endpoints vary by orders of magnitude in compute consumption. A `GET /health` check consumes microseconds of CPU. A `POST /report/generate` may consume 10 seconds of CPU plus S3 and DynamoDB calls.

```go
// pkg/uniteconomics/model.go
package uniteconomics

import "time"

// UnitEconomicModel holds cost attribution data for a single service or endpoint.
type UnitEconomicModel struct {
	Service    string `json:"service"`
	Endpoint   string `json:"endpoint"` // e.g. "POST /v1/reports"
	Team       string `json:"team"`
	CostCenter string `json:"cost_center"`

	PeriodStart time.Time `json:"period_start"`
	PeriodEnd   time.Time `json:"period_end"`

	ComputeCost  float64 `json:"compute_cost_usd"`
	StorageCost  float64 `json:"storage_cost_usd"`
	NetworkCost  float64 `json:"network_cost_usd"`
	DatabaseCost float64 `json:"database_cost_usd"`
	ObservCost   float64 `json:"observability_cost_usd"`
	SharedCost   float64 `json:"shared_cost_usd"`

	TotalRequests int64   `json:"total_requests"`
	ErrorRequests int64   `json:"error_requests"`
	P99LatencyMs  float64 `json:"p99_latency_ms"`

	TotalCOGS      float64 `json:"total_cogs_usd"`
	CostPerRequest float64 `json:"cost_per_request_usd"`
	RevenuePerReq  float64 `json:"revenue_per_request_usd,omitempty"`
	GrossMargin    float64 `json:"gross_margin_pct,omitempty"`
}

// Calculate derives TotalCOGS, CostPerRequest, and GrossMargin from components.
func (m *UnitEconomicModel) Calculate() {
	m.TotalCOGS = m.ComputeCost + m.StorageCost + m.NetworkCost +
		m.DatabaseCost + m.ObservCost + m.SharedCost

	if m.TotalRequests > 0 {
		m.CostPerRequest = m.TotalCOGS / float64(m.TotalRequests)
	}

	if m.RevenuePerReq > 0 && m.CostPerRequest > 0 {
		m.GrossMargin = ((m.RevenuePerReq - m.CostPerRequest) / m.RevenuePerReq) * 100
	}
}

// COGS returns total cost of goods sold.
func (m *UnitEconomicModel) COGS() float64 { return m.TotalCOGS }
```

### Middleware for Per-Endpoint Cost Attribution

This HTTP middleware measures wall-clock time per request and converts it to a USD cost using the instance's hourly rate. Results are emitted as Prometheus metrics.

```go
// pkg/uniteconomics/middleware.go
package uniteconomics

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	costPerRequestGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: "finops",
			Name:      "cost_per_request_usd",
			Help:      "Estimated USD cost to serve one request, by endpoint.",
		},
		[]string{"service", "endpoint", "team"},
	)

	requestCostHistogram = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "finops",
			Name:      "request_cost_usd_histogram",
			Help:      "Distribution of per-request costs in USD.",
			Buckets:   []float64{0.000001, 0.000005, 0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01},
		},
		[]string{"service", "endpoint"},
	)
)

// PricingConfig holds instance cost parameters for CPU-time attribution.
type PricingConfig struct {
	InstanceHourlyCostUSD float64 // e.g. 0.192 for m5.xlarge on-demand
	VCPUs                 int
	ServiceName           string
	TeamName              string
}

// CostPerCPUSecond returns the USD cost of 1 second of 1 vCPU at 100% utilization.
func (p *PricingConfig) CostPerCPUSecond() float64 {
	if p.VCPUs == 0 {
		return 0
	}
	return p.InstanceHourlyCostUSD / float64(p.VCPUs) / 3600.0
}

type contextKeyCost struct{}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// UnitEconomicsMiddleware records per-endpoint cost metrics for every request.
// Wall-clock elapsed time is used as an upper-bound approximation of CPU cost.
// For accurate attribution, use cgroups CPU accounting via /sys/fs/cgroup.
func UnitEconomicsMiddleware(cfg PricingConfig, next http.Handler) http.Handler {
	cpuCostPerSec := cfg.CostPerCPUSecond()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rw, r)

		elapsed := time.Since(start)
		endpoint := fmt.Sprintf("%s %s", r.Method, r.URL.Path)
		costUSD := elapsed.Seconds() * cpuCostPerSec

		costPerRequestGauge.WithLabelValues(cfg.ServiceName, endpoint, cfg.TeamName).Set(costUSD)
		requestCostHistogram.WithLabelValues(cfg.ServiceName, endpoint).Observe(costUSD)
		_ = context.WithValue(r.Context(), contextKeyCost{}, costUSD)
	})
}
```

### Querying AWS Cost Explorer for COGS per Service

AWS Cost Explorer's `GetCostAndUsage` API returns monthly unblended costs grouped by any combination of dimensions and tags. By filtering on a `service` tag value and grouping by the `SERVICE` dimension, you receive a breakdown of what each AWS product (EC2, S3, DynamoDB, CloudWatch) contributed to that service's total COGS for the billing period. The resulting `COGSBreakdown` is then passed to `BuildUnitEconomicModel`, which maps each AWS product line to the appropriate cost field, compute, storage, database, or observability, and computes the final `cost_per_request_usd` and `gross_margin_pct` once request volume and revenue figures are supplied.

```go
// pkg/uniteconomics/costexplorer.go
package uniteconomics

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer/types"
)

const dateLayout = "2006-01-02"

// COGSBreakdown holds infrastructure cost broken down by AWS service dimension.
type COGSBreakdown struct {
	ServiceTag   string
	PeriodStart  time.Time
	PeriodEnd    time.Time
	ByAWSService map[string]float64
	Total        float64
}

// FetchCOGSByService queries Cost Explorer grouped by SERVICE dimension,
// filtered to a specific service tag value.
func FetchCOGSByService(
	ctx context.Context,
	client *costexplorer.Client,
	serviceTag string,
	start, end time.Time,
) (*COGSBreakdown, error) {
	resp, err := client.GetCostAndUsage(ctx, &costexplorer.GetCostAndUsageInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start.Format(dateLayout)),
			End:   aws.String(end.Format(dateLayout)),
		},
		Granularity: types.GranularityMonthly,
		Filter: &types.Expression{
			Tags: &types.TagValues{Key: aws.String("service"), Values: []string{serviceTag}},
		},
		GroupBy: []types.GroupDefinition{
			{Type: types.GroupDefinitionTypeDimension, Key: aws.String("SERVICE")},
		},
		Metrics: []string{"UnblendedCost"},
	})
	if err != nil {
		return nil, fmt.Errorf("GetCostAndUsage(%q): %w", serviceTag, err)
	}

	b := &COGSBreakdown{
		ServiceTag: serviceTag, PeriodStart: start, PeriodEnd: end,
		ByAWSService: make(map[string]float64),
	}
	for _, res := range resp.ResultsByTime {
		for _, g := range res.Groups {
			if len(g.Keys) == 0 {
				continue
			}
			amount, _ := strconv.ParseFloat(aws.ToString(g.Metrics["UnblendedCost"].Amount), 64)
			b.ByAWSService[g.Keys[0]] += amount
			b.Total += amount
		}
	}
	return b, nil
}

// BuildUnitEconomicModel combines COGS data with request volume to produce a
// complete UnitEconomicModel with derived CostPerRequest and GrossMargin.
func BuildUnitEconomicModel(b *COGSBreakdown, totalRequests int64, revenuePerReq float64) *UnitEconomicModel {
	m := &UnitEconomicModel{
		Service:       b.ServiceTag,
		PeriodStart:   b.PeriodStart,
		PeriodEnd:     b.PeriodEnd,
		ComputeCost:   b.ByAWSService["Amazon EC2"],
		StorageCost:   b.ByAWSService["Amazon Simple Storage Service"],
		DatabaseCost:  b.ByAWSService["Amazon DynamoDB"] + b.ByAWSService["Amazon Relational Database Service"],
		NetworkCost:   b.ByAWSService["Amazon Virtual Private Cloud"],
		ObservCost:    b.ByAWSService["AmazonCloudWatch"],
		TotalRequests: totalRequests,
		RevenuePerReq: revenuePerReq,
	}
	accounted := m.ComputeCost + m.StorageCost + m.DatabaseCost + m.NetworkCost + m.ObservCost
	if m.SharedCost = b.Total - accounted; m.SharedCost < 0 {
		m.SharedCost = 0
	}
	m.Calculate()
	return m
}
```

---

### Junior → FAANG: Unit Economics as the Most Career-Relevant FinOps Skill

Unit economics engineering is the FinOps skill with the highest career return on investment. Engineers who can instrument their services with cost-per-request metrics and present cost efficiency improvements in terms of business impact (cost per user reduced by 25%, enabling a 15% margin improvement at current ARR) are operating at a level that most engineers do not reach until staff level. Starting this practice as a junior or mid-level engineer creates a compounding advantage.

The implementation pattern in this section (Prometheus middleware that tracks cost per request) is something you can build in a day and deploy to your team's production service. The result is a `cost_per_request_usd` metric in your Prometheus/Grafana dashboard. Once it is there, you can track it over time, correlate it with architectural changes, and use it to justify optimization work. The metric is the foundation. Everything else (caching decisions, rightsizing, batching) is optimization against the metric.

### Senior @ FAANG: Unit Economics as an Organizational Standard

At staff level, unit economics tracking is an organizational standard, not a per-service experiment. The standard should specify: which services are required to expose cost-per-unit metrics, which cost model to use (RI-adjusted hourly rate vs. on-demand hourly rate, and how to handle Savings Plans discounts), which unit to measure (requests, transactions, active users, events processed), and where the metrics are displayed (team dashboard, engineering all-hands).

The cost model standardization is the hardest part. A service running on Savings Plans-covered instances has a different effective hourly rate than a service running on on-demand. If two services use different cost models, their cost-per-request metrics are not comparable, which undermines the cross-team cost efficiency conversations that unit economics is meant to enable. The organizational standard should specify a single cost model (typically the blended on-demand rate, treating all Savings Plans savings as organizational benefit rather than per-service savings) and provide a shared library that implements the model consistently across all services. The platform team owns the library, teams import it, and all cost-per-unit metrics are computed consistently.
