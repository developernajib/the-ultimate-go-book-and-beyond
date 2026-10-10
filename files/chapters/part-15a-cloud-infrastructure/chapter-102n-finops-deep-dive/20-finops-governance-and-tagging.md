## 102N.18 FinOps Governance and Tagging Policy

Cost tags are the backbone of any FinOps programme. Without consistent tagging, attribution is impossible. This section covers the standard tag schema, a Go compliance CLI tool, budget alert automation, and the showback vs chargeback decision.

### Required Tag Schema

| Tag Key       | Example Value        | Purpose                         |
|---------------|----------------------|---------------------------------|
| `team`        | `platform`           | Cost allocation to team         |
| `service`     | `api-gateway`        | Per-service cost breakdown      |
| `environment` | `production`         | Separate prod vs non-prod costs |
| `cost-center` | `CC-1042`            | Finance chargeback              |
| `owner`       | `alice@example.com`  | Escalation contact              |

### Tagging Compliance CLI Tool

The AWS Resource Groups Tagging API provides a single paginated endpoint that returns every tagged resource in an account along with its current tags, making it straightforward to check compliance programmatically. This CLI tool pages through all resources, compares each resource's tags against the four required keys, and produces a JSON report with per-resource detail. It exits with a non-zero status when the account falls below 95 % compliance, making it suitable as a CI gate or a scheduled audit job.

```go
// cmd/tag-enforcer/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/resourcegroupstaggingapi"
	taggingtypes "github.com/aws/aws-sdk-go-v2/service/resourcegroupstaggingapi/types"
)

var requiredTags = []string{"team", "service", "environment", "cost-center"}

// ComplianceReport summarizes tagging compliance across an AWS account.
type ComplianceReport struct {
	TotalResources     int                `json:"total_resources"`
	CompliantResources int                `json:"compliant_resources"`
	NonCompliantCount  int                `json:"non_compliant_count"`
	CompliancePct      float64            `json:"compliance_pct"`
	NonCompliant       []NonCompliantItem `json:"non_compliant_items"`
}

// NonCompliantItem is a resource missing one or more required tags.
type NonCompliantItem struct {
	ResourceARN string   `json:"resource_arn"`
	MissingTags []string `json:"missing_tags"`
}

func main() {
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("AWS config: %v", err)
	}

	report, err := buildReport(ctx, resourcegroupstaggingapi.NewFromConfig(cfg))
	if err != nil {
		log.Fatalf("report: %v", err)
	}

	b, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(b))
	fmt.Printf("\nCompliance: %d/%d (%.1f%%)\n",
		report.CompliantResources, report.TotalResources, report.CompliancePct)

	if report.CompliancePct < 95.0 {
		fmt.Fprintln(os.Stderr, "FAIL: below 95% compliance threshold")
		os.Exit(1)
	}
	fmt.Println("PASS: tagging compliance within threshold.")
}

func buildReport(ctx context.Context, c *resourcegroupstaggingapi.Client) (*ComplianceReport, error) {
	r := &ComplianceReport{}
	var token *string
	for {
		resp, err := c.GetResources(ctx, &resourcegroupstaggingapi.GetResourcesInput{
			PaginationToken:          token,
			ResourcesPerPage:         aws.Int32(100),
			IncludeComplianceDetails: aws.Bool(true),
		})
		if err != nil {
			return nil, err
		}
		for _, res := range resp.ResourceTagMappingList {
			r.TotalResources++
			if missing := findMissing(res.Tags); len(missing) == 0 {
				r.CompliantResources++
			} else {
				r.NonCompliant = append(r.NonCompliant, NonCompliantItem{
					ResourceARN: aws.ToString(res.ResourceARN),
					MissingTags: missing,
				})
			}
		}
		if resp.PaginationToken == nil || *resp.PaginationToken == "" {
			break
		}
		token = resp.PaginationToken
	}
	r.NonCompliantCount = len(r.NonCompliant)
	if r.TotalResources > 0 {
		r.CompliancePct = float64(r.CompliantResources) / float64(r.TotalResources) * 100
	}
	return r, nil
}

func findMissing(tags []taggingtypes.Tag) []string {
	have := make(map[string]struct{}, len(tags))
	for _, t := range tags {
		have[strings.ToLower(aws.ToString(t.Key))] = struct{}{}
	}
	var missing []string
	for _, req := range requiredTags {
		if _, ok := have[req]; !ok {
			missing = append(missing, req)
		}
	}
	return missing
}
```

### Budget Alerts Automation

Reacting to cost overruns after month-end is too late. proactive budget alerts at 50 %, 80 %, and 100 % of a monthly cap give teams enough notice to investigate and intervene. The `CreateTeamBudget` function below provisions an AWS Budget filtered to a specific team tag value and wires three SNS notifications at graduated thresholds so alerts escalate naturally as spend climbs. Factoring this into a shared `budgets` package means every team budget follows the same structure and alert policy without duplicating CloudFormation or Terraform.

```go
// pkg/budgets/alerts.go
package budgets

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	"github.com/aws/aws-sdk-go-v2/service/budgets/types"
)

// CreateTeamBudget creates an AWS Budget with SNS alerts at 50%, 80%, and 100%.
func CreateTeamBudget(
	ctx context.Context,
	c *budgets.Client,
	accountID, team, snsARN string,
	limitUSD float64,
) error {
	name := fmt.Sprintf("team-%s-monthly", team)
	_, err := c.CreateBudget(ctx, &budgets.CreateBudgetInput{
		AccountId: aws.String(accountID),
		Budget: &types.Budget{
			BudgetName: aws.String(name),
			BudgetType: types.BudgetTypeCost,
			TimeUnit:   types.TimeUnitMonthly,
			BudgetLimit: &types.Spend{
				Amount: aws.String(fmt.Sprintf("%.2f", limitUSD)),
				Unit:   aws.String("USD"),
			},
			CostFilters: map[string][]string{
				"TagKeyValue": {fmt.Sprintf("user:team$%s", team)},
			},
		},
		NotificationsWithSubscribers: []types.NotificationWithSubscribers{
			alertAt(50, snsARN), alertAt(80, snsARN), alertAt(100, snsARN),
		},
	})
	if err != nil {
		return fmt.Errorf("CreateBudget %s: %w", name, err)
	}
	fmt.Printf("Budget %q: $%.2f/month, alerts at 50/80/100%%\n", name, limitUSD)
	return nil
}

func alertAt(pct float64, snsARN string) types.NotificationWithSubscribers {
	return types.NotificationWithSubscribers{
		Notification: &types.Notification{
			ComparisonOperator: types.ComparisonOperatorGreaterThan,
			NotificationType:   types.NotificationTypeActual,
			Threshold:          aws.Float64(pct),
			ThresholdType:      types.ThresholdTypePercentage,
		},
		Subscribers: []types.Subscriber{
			{Address: aws.String(snsARN), SubscriptionType: types.SubscriptionTypeSns},
		},
	}
}
```

### Showback vs Chargeback Models

**Showback** gives each team a cost report without moving budget. It builds cost awareness without financial consequences - the recommended starting point for most organizations. Teams see their cloud costs, discuss optimization, and build FinOps literacy before money is at stake.

**Chargeback** transfers budget from a central cloud account to each team's P&L. It creates strong financial incentives but requires accurate attribution and finance department integration. Implementing chargeback before tagging is accurate leads to disputes and erodes trust.

Recommended transition sequence: Showback → Showback with published allocation methodology → Chargeback with dispute resolution → Chargeback automated through internal billing APIs.

### Cost Anomaly Detection with Z-Score Analysis

Budget alerts fire when spend crosses a fixed threshold, but they miss sudden spikes that are still below the cap. Z-score analysis computes how many standard deviations a day's spend is from the rolling historical mean, flagging statistically unusual values regardless of their absolute size. The `Detect` function below requires at least seven historical data points to compute a meaningful baseline, then classifies anomalies into low, medium, and high severity based on whether the z-score exceeds 2.0, 2.5, or 3.0 respectively.

```go
// pkg/anomaly/detector.go
package anomaly

import (
	"math"
	"time"
)

// DailyCost holds cloud spend for a single calendar day.
type DailyCost struct {
	Date time.Time
	USD  float64
}

// AnomalyResult describes whether a data point is statistically anomalous.
type AnomalyResult struct {
	Date        time.Time
	ObservedUSD float64
	ExpectedUSD float64
	ZScore      float64
	IsAnomaly   bool
	Severity    string // "low", "medium", "high"
}

// Detect applies z-score anomaly detection against a rolling window of history.
// Requires at least 7 data points for a meaningful signal.
func Detect(history []DailyCost, point DailyCost) AnomalyResult {
	if len(history) < 7 {
		return AnomalyResult{Date: point.Date, ObservedUSD: point.USD}
	}
	mean, std := stats(history)
	z := 0.0
	if std > 0 {
		z = (point.USD - mean) / std
	}
	res := AnomalyResult{Date: point.Date, ObservedUSD: point.USD, ExpectedUSD: mean, ZScore: z}
	switch a := math.Abs(z); {
	case a >= 3.0:
		res.IsAnomaly, res.Severity = true, "high"
	case a >= 2.5:
		res.IsAnomaly, res.Severity = true, "medium"
	case a >= 2.0:
		res.IsAnomaly, res.Severity = true, "low"
	}
	return res
}

func stats(data []DailyCost) (mean, std float64) {
	n := float64(len(data))
	for _, d := range data {
		mean += d.USD
	}
	mean /= n
	var v float64
	for _, d := range data {
		diff := d.USD - mean
		v += diff * diff
	}
	return mean, math.Sqrt(v / n)
}
```

---

### Junior → FAANG: Showback vs. Chargeback as the FinOps Organizational Decision

The showback vs. chargeback decision has a clear progression: start with showback, build organizational trust in the attribution data, then migrate to chargeback when teams are confident the numbers are accurate. Attempting chargeback before the attribution methodology is validated and trusted by teams produces disputes and erodes confidence in the entire FinOps program. Junior engineers should understand this sequence because they will be asked "why aren't we doing chargeback yet?" by finance stakeholders and need to explain the prerequisite quality bar.

The compliance CLI tool in this section is a practical artifact that can be built in a weekend and immediately useful: it scans all resources in an AWS account for missing or incorrect tags and produces a prioritized remediation list. Building this tool for your team's actual account and running it produces the current tagging compliance percentage, which is the starting point for any governance improvement conversation.

### Senior @ FAANG: FinOps Governance as an Organizational Trust-Building Program

At staff level, FinOps governance is as much about building organizational trust as it is about technical accuracy. Teams that receive cost attribution reports will question the numbers, especially for shared infrastructure costs. The two most common disputes: "why am I being charged for the NAT gateway when other teams use it more?" and "my service tag changed last month so the attribution is wrong for half the month." Both are legitimate concerns that require transparent responses.

The response to shared cost disputes is a documented allocation methodology that is published alongside the cost reports. The response to tag change attribution errors is a versioned tag history that shows exactly which resources were tagged with which values on which dates, allowing the cost report to use the correct tag for each billing period. Building the tag history log (capturing tag change events from CloudTrail) is a one-time platform investment that eliminates the retroactive attribution disputes permanently.

The z-score anomaly detection in this section applies to governance as well as cost: a team whose resource count increases by more than 2 standard deviations in a day is anomalous and warrants investigation (did they launch a new environment? is a test environment running that should have been terminated?). Connecting governance events (resource creation, tag changes) with cost anomaly detection creates a proactive governance system that catches problems before they appear in the monthly bill.
