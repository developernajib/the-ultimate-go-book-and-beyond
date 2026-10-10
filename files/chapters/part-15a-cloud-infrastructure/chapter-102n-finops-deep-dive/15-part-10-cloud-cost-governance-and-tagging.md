## 102N.13 Cloud Cost Governance and Tagging

### Tagging Strategy

A consistent tagging strategy is the foundation of every cost governance program. Without tags you cannot answer "which team owns this resource?" or "what is the cost of the checkout service?".

**Required tags for every AWS resource:**

| Tag Key | Example Value | Purpose |
|---|---|---|
| `service` | `checkout-api` | Maps to a microservice or application |
| `team` | `payments` | Team responsible for the resource |
| `environment` | `production` / `staging` | Separates prod vs non-prod costs |
| `cost-center` | `CC-1042` | Maps to finance chargeback code |
| `owner` | `alice@example.com` | Individual accountable for the resource |
| `project` | `card-tokenization-v2` | Optional: tracks initiative-level costs |

Enforce via AWS Service Control Policies (SCPs) so that resource creation is blocked if required tags are missing:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RequireCostTags",
      "Effect": "Deny",
      "Action": [
        "ec2:RunInstances",
        "rds:CreateDBInstance",
        "elasticloadbalancing:CreateLoadBalancer",
        "lambda:CreateFunction"
      ],
      "Resource": "*",
      "Condition": {
        "Null": {
          "aws:RequestTag/team": "true",
          "aws:RequestTag/service": "true",
          "aws:RequestTag/environment": "true"
        }
      }
    }
  ]
}
```

### Go Tool: Untagged Resource Auditor

SCPs prevent new resources from being created without tags, but they do not fix the existing untagged inventory that accumulated before governance was enforced. The `AuditUntaggedResources` function uses the AWS Resource Groups Tagging API, which covers over 100 resource types in a single paginated call, to enumerate every resource in a region and check it against the required tag list locally. This is more efficient than making per-service API calls (DescribeInstances, DescribeFunctions, etc.) and produces a unified violation report across all resource types that can drive automated remediation or Jira ticket creation.

```go
package tagaudit

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/resourcegroupstaggingapi"
)

// RequiredTags lists tags that every resource must carry.
var RequiredTags = []string{"team", "service", "environment", "cost-center", "owner"}

// UntaggedResource describes a resource missing one or more required tags.
type UntaggedResource struct {
	ARN         string
	ResourceType string
	MissingTags []string
}

// AuditUntaggedResources queries AWS Resource Groups Tagging API for resources
// that are missing any of the required tags.
func AuditUntaggedResources(ctx context.Context, region string, logger *slog.Logger) ([]UntaggedResource, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}

	client := resourcegroupstaggingapi.NewFromConfig(cfg)

	// Build tag filters: resources where any required tag key is missing.
	// The API allows filtering by tag key presence - we query all resources
	// then check locally for missing tags.
	var results []UntaggedResource
	paginator := resourcegroupstaggingapi.NewGetResourcesPaginator(client, &resourcegroupstaggingapi.GetResourcesInput{
		ResourcesPerPage: aws.Int32(100),
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list resources: %w", err)
		}

		for _, mapping := range page.ResourceTagMappingList {
			tagMap := make(map[string]struct{}, len(mapping.Tags))
			for _, t := range mapping.Tags {
				if t.Key != nil {
					tagMap[*t.Key] = struct{}{}
				}
			}

			var missing []string
			for _, required := range RequiredTags {
				if _, ok := tagMap[required]; !ok {
					missing = append(missing, required)
				}
			}

			if len(missing) > 0 {
				results = append(results, UntaggedResource{
					ARN:         aws.ToString(mapping.ResourceARN),
					MissingTags: missing,
				})
				logger.Warn("untagged resource found",
					"arn", aws.ToString(mapping.ResourceARN),
					"missing_tags", missing,
				)
			}
		}
	}

	logger.Info("tag audit complete",
		"total_untagged", len(results),
		"region", region,
	)
	return results, nil
}

// TagEC2Instance applies a set of tags to an EC2 instance. Used for
// remediation after an audit identifies missing tags.
func TagEC2Instance(ctx context.Context, region, instanceID string, tags map[string]string) error {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return err
	}

	client := ec2.NewFromConfig(cfg)

	ec2Tags := make([]ec2types.Tag, 0, len(tags))
	for k, v := range tags {
		ec2Tags = append(ec2Tags, ec2types.Tag{Key: aws.String(k), Value: aws.String(v)})
	}

	_, err = client.CreateTags(ctx, &ec2.CreateTagsInput{
		Resources: []string{instanceID},
		Tags:      ec2Tags,
	})
	return err
}
```

### Chargeback vs Showback Models

**Showback**: Teams can see their cloud costs but are not billed. Benefits: builds awareness, low friction, suitable for organizations beginning their FinOps journey (the "Crawl" phase).

**Chargeback**: Actual cloud costs are billed back to team or business unit budgets. Benefits: creates direct financial accountability, drives behavior change. Requires mature tagging and allocation before implementation.

The FinOps Foundation's Crawl-Walk-Run framework maps governance maturity:

| Phase | Crawl | Walk | Run |
|---|---|---|---|
| Visibility | Basic cost reports | Cost per team/service | Real-time per-request cost |
| Allocation | Manual tagging | Enforced tagging + showback | Automated chargeback |
| Optimization | Manual rightsizing | VPA + Savings Plans | Continuous automated optimization |
| Governance | Guidelines | SCP enforcement | Cost gates in CI/CD |
| Culture | Ad hoc reviews | Monthly FinOps reviews | Cost KPIs in team OKRs |

### Budget Alert Service: Slack Notification at 80% Spend

```go
package budgetalert

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer/types"
)

// TeamBudget defines a monthly budget limit for a tagged team.
type TeamBudget struct {
	TeamTag  string
	LimitUSD float64
}

// BudgetAlertService monitors per-team AWS spend and sends Slack
// notifications when a team exceeds a configurable threshold.
type BudgetAlertService struct {
	ce         *costexplorer.Client
	budgets    []TeamBudget
	webhook    string
	threshold  float64 // fraction, e.g. 0.80
	httpClient *http.Client
	logger     *slog.Logger
}

func NewBudgetAlertService(ctx context.Context, budgets []TeamBudget, webhookURL string, threshold float64, logger *slog.Logger) (*BudgetAlertService, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &BudgetAlertService{
		ce:         costexplorer.NewFromConfig(cfg),
		budgets:    budgets,
		webhook:    webhookURL,
		threshold:  threshold,
		httpClient: &http.Client{Timeout: 5 * time.Second},
		logger:     logger,
	}, nil
}

// CheckAndAlert queries month-to-date spend per team and sends Slack
// alerts for any team that has exceeded the configured threshold.
func (s *BudgetAlertService) CheckAndAlert(ctx context.Context) error {
	now := time.Now().UTC()
	startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	for _, budget := range s.budgets {
		actual, err := s.monthToDateSpend(ctx, budget.TeamTag, startOfMonth, now)
		if err != nil {
			s.logger.Error("fetch spend failed", "team", budget.TeamTag, "error", err)
			continue
		}

		utilization := actual / budget.LimitUSD
		s.logger.Info("team budget status",
			"team", budget.TeamTag,
			"actual_usd", fmt.Sprintf("%.2f", actual),
			"limit_usd", fmt.Sprintf("%.2f", budget.LimitUSD),
			"utilization_pct", fmt.Sprintf("%.1f%%", utilization*100),
		)

		if utilization >= s.threshold {
			if err := s.sendSlackAlert(ctx, budget.TeamTag, actual, budget.LimitUSD, utilization); err != nil {
				s.logger.Error("slack alert failed", "team", budget.TeamTag, "error", err)
			}
		}
	}
	return nil
}

func (s *BudgetAlertService) monthToDateSpend(ctx context.Context, team string, start, end time.Time) (float64, error) {
	out, err := s.ce.GetCostAndUsage(ctx, &costexplorer.GetCostAndUsageInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start.Format("2006-01-02")),
			End:   aws.String(end.Format("2006-01-02")),
		},
		Granularity: types.GranularityMonthly,
		Filter: &types.Expression{
			Tags: &types.TagValues{
				Key:    aws.String("team"),
				Values: []string{team},
			},
		},
		Metrics: []string{"UnblendedCost"},
	})
	if err != nil {
		return 0, err
	}

	var total float64
	for _, result := range out.ResultsByTime {
		if v, ok := result.Total["UnblendedCost"]; ok && v.Amount != nil {
			var amount float64
			fmt.Sscanf(aws.ToString(v.Amount), "%f", &amount)
			total += amount
		}
	}
	return total, nil
}

func (s *BudgetAlertService) sendSlackAlert(ctx context.Context, team string, actual, limit, utilization float64) error {
	emoji := ":warning:"
	if utilization >= 1.0 {
		emoji = ":rotating_light:"
	}

	text := fmt.Sprintf(
		"%s *Budget Alert: Team %s*\nSpent $%.2f of $%.2f monthly budget (%.1f%%).\nReview spend at https://console.aws.amazon.com/cost-management/",
		emoji, team, actual, limit, utilization*100,
	)

	payload, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.webhook, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack returned %d", resp.StatusCode)
	}
	return nil
}
```

---

### Junior → FAANG: Governance and Tagging as Foundational FinOps Habits

The tagging strategy in this section is not a FinOps-specific concern. It is a general cloud resource management discipline that makes debugging, cost attribution, security auditing, and compliance all easier. A resource tagged with `team`, `service`, `environment`, and `owner` can be found in 30 seconds during an incident. An untagged resource of the same type requires cross-referencing creation logs, CloudTrail events, and manual investigation that takes 30 minutes.

The most important governance habit for junior engineers: enforce tagging in your IaC from day one. Terraform and CDK both support default tags at the provider level, which apply to all resources created in the configuration. Setting up default tags (team, service, environment) at the provider level is a five-minute configuration change that ensures every resource created by the IaC is tagged correctly, even resources added months later when the original governance intent may have faded.

### Senior @ FAANG: Cost Governance as an Organizational Platform Capability

At staff level, cost governance is an organizational platform capability that requires tooling, process, and enforcement to function. The governance framework has three layers: prevention (tagging policies enforced at resource creation via AWS Config rules or Service Control Policies that deny untagged resource creation), detection (regular audits that surface untagged or incorrectly tagged resources and route remediation tasks to owning teams), and attribution (the cost allocation system that converts tagged resources into per-team cost reports).

Service Control Policies (SCPs) are the enforcement mechanism at the AWS organization level. An SCP that denies the `ec2:RunInstances` API call if the request does not include the required tag keys (`team`, `service`, `environment`) prevents untagged EC2 resources from being created, regardless of whether the creator is using IaC or the console. The SCP approach has a bootstrap problem (the SCP itself must be deployed before it can enforce tagging, and existing untagged resources are not retroactively affected) but provides the strongest enforcement guarantee. Implementing this SCP for new accounts while running tag enforcement tooling for existing accounts is the migration strategy that covers both cases.

The tagging governance program's success metric: percentage of cloud spend attributed to a specific team and service. Measure this monthly. An organization where 95% of spend is attributed is a healthy FinOps program. An organization where 60% of spend is attributed has significant governance gaps that are producing inaccurate cost allocation reports and reducing the accountability value of the chargeback system. The gap between 60% and 95% attribution is the platform team's primary governance improvement target, and the path to closing it is identifying which resource types and which account regions have the worst tagging coverage and addressing them systematically.
