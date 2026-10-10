## 102N.1 Cloud Cost APIs

### AWS Cost Explorer Client

```go
package costexplorer

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer/types"
)

// CostClient wraps AWS Cost Explorer with domain-specific queries
type CostClient struct {
	ce *costexplorer.Client
}

func NewCostClient(ctx context.Context) (*CostClient, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	return &CostClient{ce: costexplorer.NewFromConfig(cfg)}, nil
}

// DailyCost represents the cost for a single day
type DailyCost struct {
	Date    time.Time
	Amount  float64
	Unit    string
	Service string
}

// GetDailyCostByService returns daily costs grouped by service for a date range
func (c *CostClient) GetDailyCostByService(ctx context.Context, start, end time.Time) ([]DailyCost, error) {
	out, err := c.ce.GetCostAndUsage(ctx, &costexplorer.GetCostAndUsageInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start.Format("2006-01-02")),
			End:   aws.String(end.Format("2006-01-02")),
		},
		Granularity: types.GranularityDaily,
		Metrics:     []string{"UnblendedCost"},
		GroupBy: []types.GroupDefinition{
			{
				Type: types.GroupDefinitionTypeDimension,
				Key:  aws.String("SERVICE"),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get cost and usage: %w", err)
	}

	var results []DailyCost
	for _, period := range out.ResultsByTime {
		date, _ := time.Parse("2006-01-02", aws.ToString(period.TimePeriod.Start))
		for _, group := range period.Groups {
			amount := parseAmount(group.Metrics["UnblendedCost"].Amount)
			unit := aws.ToString(group.Metrics["UnblendedCost"].Unit)
			service := ""
			if len(group.Keys) > 0 {
				service = group.Keys[0]
			}
			if amount > 0 {
				results = append(results, DailyCost{
					Date:    date,
					Amount:  amount,
					Unit:    unit,
					Service: service,
				})
			}
		}
	}
	return results, nil
}

// GetMonthlyCostByTag returns monthly costs grouped by a cost allocation tag
func (c *CostClient) GetMonthlyCostByTag(ctx context.Context, tagKey string, months int) (map[string]float64, error) {
	end := time.Now()
	start := end.AddDate(0, -months, 0)

	out, err := c.ce.GetCostAndUsage(ctx, &costexplorer.GetCostAndUsageInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start.Format("2006-01-02")),
			End:   aws.String(end.Format("2006-01-02")),
		},
		Granularity: types.GranularityMonthly,
		Metrics:     []string{"UnblendedCost"},
		GroupBy: []types.GroupDefinition{
			{
				Type: types.GroupDefinitionTypeTag,
				Key:  aws.String(tagKey),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get cost by tag: %w", err)
	}

	totals := make(map[string]float64)
	for _, period := range out.ResultsByTime {
		for _, group := range period.Groups {
			key := "untagged"
			if len(group.Keys) > 0 {
				key = group.Keys[0]
				if key == "" {
					key = "untagged"
				}
			}
			totals[key] += parseAmount(group.Metrics["UnblendedCost"].Amount)
		}
	}
	return totals, nil
}

// GetCostForecast forecasts costs for the next N days
func (c *CostClient) GetCostForecast(ctx context.Context, days int) (float64, error) {
	now := time.Now()
	start := now.Format("2006-01-02")
	end := now.AddDate(0, 0, days).Format("2006-01-02")

	out, err := c.ce.GetCostForecast(ctx, &costexplorer.GetCostForecastInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start),
			End:   aws.String(end),
		},
		Metric:      types.MetricUnblendedCost,
		Granularity: types.GranularityMonthly,
	})
	if err != nil {
		return 0, fmt.Errorf("get forecast: %w", err)
	}

	if out.Total == nil {
		return 0, nil
	}
	return parseAmount(out.Total.Amount), nil
}

// GetSavingsPlanRecommendations returns savings plan purchase recommendations
func (c *CostClient) GetSavingsPlanRecommendations(ctx context.Context) ([]SavingsRecommendation, error) {
	out, err := c.ce.GetSavingsPlansPurchaseRecommendation(ctx, &costexplorer.GetSavingsPlansPurchaseRecommendationInput{
		SavingsPlansType:     types.SupportedSavingsPlansTypeComputeSp,
		TermInYears:          types.TermInYearsOneYear,
		PaymentOption:        types.PaymentOptionNoUpfront,
		LookbackPeriodInDays: types.LookbackPeriodInDaysThirtyDays,
	})
	if err != nil {
		return nil, fmt.Errorf("get savings recommendations: %w", err)
	}

	var recs []SavingsRecommendation
	if out.SavingsPlansPurchaseRecommendation != nil {
		for _, r := range out.SavingsPlansPurchaseRecommendation.SavingsPlansPurchaseRecommendationDetails {
			recs = append(recs, SavingsRecommendation{
				HourlyCommitment:        parseAmount(r.HourlyCommitmentToPurchase),
				EstimatedMonthlySavings: parseAmount(r.EstimatedMonthlySavingsAmount),
				SavingsPercentage:       parseAmount(r.EstimatedSavingsPercentage),
				CurrentOnDemandSpend:    parseAmount(r.CurrentAverageHourlyOnDemandSpend),
			})
		}
	}
	return recs, nil
}

type SavingsRecommendation struct {
	HourlyCommitment        float64
	EstimatedMonthlySavings float64
	SavingsPercentage       float64
	CurrentOnDemandSpend    float64
}

func parseAmount(s *string) float64 {
	if s == nil {
		return 0
	}
	var f float64
	fmt.Sscanf(*s, "%f", &f)
	return f
}
```

### GCP Billing API Client

Unlike AWS, GCP's primary cost analysis path runs through BigQuery rather than a dedicated billing API, GCP billing data is exported to a BigQuery dataset, and cost queries are plain SQL against that export. The `CloudBillingClient` is used for account management operations (listing accounts, linking projects), while actual spend analytics use the `BigQueryCostQuery` helper to generate parameterized SQL that aggregates `cost` plus credits (committed-use discounts, sustained-use credits) into a net cost figure. This two-tier design means GCP cost queries scale to billions of billing rows without hitting API rate limits.

```go
package gcpbilling

import (
	"context"
	"fmt"
	"time"

	billing "cloud.google.com/go/billing/apiv1"
	billingpb "cloud.google.com/go/billing/apiv1/billingpb"
	"google.golang.org/api/iterator"
)

// GCPCostClient queries GCP billing data
type GCPCostClient struct {
	client    *billing.CloudBillingClient
	projectID string
	datasetID string // BigQuery dataset for billing export
}

// NewGCPCostClient creates a new GCP cost client
func NewGCPCostClient(ctx context.Context, projectID string) (*GCPCostClient, error) {
	client, err := billing.NewCloudBillingClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("new billing client: %w", err)
	}
	return &GCPCostClient{
		client:    client,
		projectID: projectID,
	}, nil
}

// ListBillingAccounts returns all billing accounts accessible to the caller
func (c *GCPCostClient) ListBillingAccounts(ctx context.Context) ([]*billingpb.BillingAccount, error) {
	var accounts []*billingpb.BillingAccount
	it := c.client.ListBillingAccounts(ctx, &billingpb.ListBillingAccountsRequest{})
	for {
		account, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("list billing accounts: %w", err)
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

// GCP billing data is typically exported to BigQuery - query it there
type BigQueryCostQuery struct {
	projectID string
	dataset   string
	table     string
}

func (q *BigQueryCostQuery) MonthlyCostByService(month time.Time) string {
	return fmt.Sprintf(`
SELECT
  service.description as service,
  SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) as net_cost,
  currency
FROM %s.%s.%s
WHERE
  invoice.month = '%s'
  AND project.id = '%s'
GROUP BY service, currency
ORDER BY net_cost DESC
`,
		q.projectID, q.dataset, q.table,
		month.Format("200601"),
		q.projectID,
	)
}

func (q *BigQueryCostQuery) DailySpendTrend(days int) string {
	return fmt.Sprintf(`
SELECT
  DATE(usage_start_time) as date,
  SUM(cost) as daily_cost,
  currency
FROM %s.%s.%s
WHERE
  DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL %d DAY)
  AND project.id = '%s'
GROUP BY date, currency
ORDER BY date
`,
		q.projectID, q.dataset, q.table,
		days, q.projectID,
	)
}
```

---

### Junior → FAANG: Cloud Cost APIs as Data Engineering Foundations

The AWS Cost Explorer API and GCP BigQuery billing export are the data sources for all cost attribution work. Understanding them before building cost tooling prevents the most common mistake: querying Cost Explorer at high granularity (daily, per-resource) in a tight loop, which quickly exhausts the 1,000 requests/month API limit and generates unexpected Cost Explorer API charges. The correct pattern is to pull cost data once per day, cache it in a database or object storage, and serve all dashboard queries from the cache.

The GCP BigQuery billing export pattern (querying the billing export table directly) is more efficient at scale than the Cost Explorer API because BigQuery bills per byte scanned rather than per API call, and the billing export table is optimized for analytical queries. For organizations with large GCP spend, the BigQuery approach provides richer historical data (up to 12 months of detailed usage) at lower query cost than equivalent Cost Explorer API calls.

First-job habit: always add pagination to Cost Explorer API calls. The API returns a maximum of 20 grouped results per call, with a NextPageToken for subsequent pages. Forgetting pagination produces silently incomplete reports: your cost attribution shows 20 services when you have 40, and the missing services' costs disappear from your reports.

### Senior @ FAANG: Multi-Cloud Cost Aggregation as Platform Architecture

At staff level, the cost API section is a starting point for a multi-cloud cost aggregation pipeline. The organizational challenge is not pulling data from one cloud's API but normalizing and correlating cost data across AWS, GCP, and Azure into a unified model that answers questions like: what is the total cost of running the recommendation service, including its Lambda functions (AWS), its Cloud Spanner database (GCP), and its Azure Cognitive Services calls?

The normalization problem is harder than it appears. AWS bills in USD with hourly granularity. GCP bills in the billing account currency with sub-hourly granularity in the detailed export. Azure bills in the subscription currency with daily granularity by default. Tags across the three providers may use different naming conventions (AWS uses `service`, GCP uses `label`, Azure uses `tag`). Building a canonical cost schema that maps all three providers' data structures is the core engineering problem. The canonical schema should have at minimum: resource ID, resource type, team tag, service tag, environment tag, cost in USD, usage amount, usage unit, and date. Everything else can be provider-specific metadata.

The Go-based cost aggregation pipeline in this section is the foundation for the organizational FinOps platform. At scale, this pipeline runs daily, pulls data from all cloud providers, normalizes it into the canonical schema, applies allocation rules for shared resources, and populates a cost warehouse (typically BigQuery or Redshift) that powers all downstream dashboards and alerting. The staff engineer's design decision for this pipeline: batch vs. streaming? For most organizations, batch is correct: cost data is not real-time (billing records may lag up to 48 hours), so streaming adds complexity without benefit. The exception is organizations with runaway spend risk (autoscaling with no upper bound, spot interruptions that trigger re-provisioning cascades) that need near-real-time cost alerting.
