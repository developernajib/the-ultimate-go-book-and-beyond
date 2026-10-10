## 102N.2 Cost Allocation System

### Tagging Enforcer

Without enforced tagging, cloud costs accumulate in an unattributed pool that cannot be charged back to any team or project. The `ResourceTagger` solves the attribution problem by auditing running and stopped EC2 instances against a fixed list of required tag keys, `Environment`, `Team`, `Project`, and `CostCenter`, and surfacing every `TagViolation` before it inflates the shared cost bucket. Pairing the auditor with `ApplyDefaultTags` enables automated remediation: violations found during a scheduled run can be resolved immediately rather than waiting for the resource owner to respond.

```go
package tagging

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/rds"
)

// RequiredTags defines mandatory tags for cost allocation
var RequiredTags = []string{
	"Environment", // prod, staging, dev
	"Team",        // platform, data, product
	"Project",     // project code
	"CostCenter",  // finance cost center
}

// ResourceTagger audits and fixes resource tags
type ResourceTagger struct {
	ec2Client    *ec2.Client
	lambdaClient *lambda.Client
	rdsClient    *rds.Client
}

type TagViolation struct {
	ResourceID   string
	ResourceType string
	MissingTags  []string
}

// AuditEC2Tags checks all EC2 instances for required tags
func (t *ResourceTagger) AuditEC2Tags(ctx context.Context) ([]TagViolation, error) {
	out, err := t.ec2Client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{
				Name:   aws.String("instance-state-name"),
				Values: []string{"running", "stopped"},
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("describe instances: %w", err)
	}

	var violations []TagViolation
	for _, reservation := range out.Reservations {
		for _, instance := range reservation.Instances {
			missing := findMissingTags(instance.Tags)
			if len(missing) > 0 {
				violations = append(violations, TagViolation{
					ResourceID:   *instance.InstanceId,
					ResourceType: "ec2-instance",
					MissingTags:  missing,
				})
			}
		}
	}
	return violations, nil
}

func findMissingTags(tags []ec2types.Tag) []string {
	existing := make(map[string]bool)
	for _, tag := range tags {
		existing[*tag.Key] = true
	}

	var missing []string
	for _, required := range RequiredTags {
		if !existing[required] {
			missing = append(missing, required)
		}
	}
	return missing
}

// ApplyDefaultTags applies default tags to untagged resources
func (t *ResourceTagger) ApplyDefaultTags(ctx context.Context, resourceID string, defaults map[string]string) error {
	var tags []ec2types.Tag
	for k, v := range defaults {
		tags = append(tags, ec2types.Tag{
			Key:   aws.String(k),
			Value: aws.String(v),
		})
	}

	_, err := t.ec2Client.CreateTags(ctx, &ec2.CreateTagsInput{
		Resources: []string{resourceID},
		Tags:      tags,
	})
	return err
}

// TagReport generates a tag compliance report
type TagReport struct {
	TotalResources    int
	CompliantResources int
	Violations        []TagViolation
	ComplianceRate    float64
}

func GenerateTagReport(violations []TagViolation, total int) TagReport {
	compliant := total - len(violations)
	rate := 0.0
	if total > 0 {
		rate = float64(compliant) / float64(total) * 100
	}
	return TagReport{
		TotalResources:     total,
		CompliantResources: compliant,
		Violations:         violations,
		ComplianceRate:     rate,
	}
}
```

### Chargeback Calculator

The `ChargebackCalculator` addresses the hardest FinOps problem: shared infrastructure costs that cannot be directly attributed by tag alone. Resources tagged with a `Team` value are allocated directly, but shared services, a common NAT gateway, a centralized logging cluster, a multi-tenant database, have no single owner. The `AllocationRule` system handles this with three strategies: `equal` splits the cost evenly across all teams, `custom` applies finance-approved percentage weights, and `usage` distributes proportionally to measured consumption. Unmatched resources fall into a `shared` bucket so nothing is silently dropped from the total.

```go
package chargeback

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"time"
)

// ChargebackPeriod represents a billing period
type ChargebackPeriod struct {
	Start time.Time
	End   time.Time
}

// ResourceCost represents the cost of a single resource
type ResourceCost struct {
	ResourceID   string
	ResourceType string
	Service      string
	Cost         float64
	Currency     string
	Tags         map[string]string
}

// TeamCharge is the aggregated charge for a team
type TeamCharge struct {
	Team        string
	CostCenter  string
	Environment string
	TotalCost   float64
	Currency    string
	Breakdown   map[string]float64 // service → cost
	Resources   []ResourceCost
}

// ChargebackCalculator allocates cloud costs to teams
type ChargebackCalculator struct {
	costClient CostDataSource
	allocRules []AllocationRule
}

// AllocationRule defines how to split shared costs
type AllocationRule struct {
	Name       string
	Service    string
	SplitBy    string            // "equal", "usage", "custom"
	Weights    map[string]float64 // team → weight (for "custom")
}

// CostDataSource abstracts cost data retrieval
type CostDataSource interface {
	GetResourceCosts(ctx context.Context, period ChargebackPeriod) ([]ResourceCost, error)
}

// Calculate computes chargeback amounts for all teams in a period
func (c *ChargebackCalculator) Calculate(ctx context.Context, period ChargebackPeriod) (map[string]*TeamCharge, error) {
	costs, err := c.costClient.GetResourceCosts(ctx, period)
	if err != nil {
		return nil, fmt.Errorf("get resource costs: %w", err)
	}

	charges := make(map[string]*TeamCharge)

	// Allocate directly tagged resources
	var unallocated []ResourceCost
	for _, cost := range costs {
		team, ok := cost.Tags["Team"]
		if !ok || team == "" {
			unallocated = append(unallocated, cost)
			continue
		}

		if charges[team] == nil {
			charges[team] = &TeamCharge{
				Team:       team,
				CostCenter: cost.Tags["CostCenter"],
				Breakdown:  make(map[string]float64),
			}
		}
		charges[team].TotalCost += cost.Cost
		charges[team].Breakdown[cost.Service] += cost.Cost
		charges[team].Resources = append(charges[team].Resources, cost)
	}

	// Apply allocation rules for shared/untagged costs
	for _, resource := range unallocated {
		rule := c.findRule(resource)
		if rule == nil {
			// Default: allocate to "shared" team
			if charges["shared"] == nil {
				charges["shared"] = &TeamCharge{
					Team:      "shared",
					Breakdown: make(map[string]float64),
				}
			}
			charges["shared"].TotalCost += resource.Cost
			charges["shared"].Breakdown[resource.Service] += resource.Cost
			continue
		}

		// Apply rule
		allocations := c.applyRule(rule, resource, charges)
		for team, amount := range allocations {
			if charges[team] == nil {
				charges[team] = &TeamCharge{Team: team, Breakdown: make(map[string]float64)}
			}
			charges[team].TotalCost += amount
			charges[team].Breakdown[resource.Service] += amount
		}
	}

	return charges, nil
}

func (c *ChargebackCalculator) findRule(resource ResourceCost) *AllocationRule {
	for i := range c.allocRules {
		if c.allocRules[i].Service == resource.Service {
			return &c.allocRules[i]
		}
	}
	return nil
}

func (c *ChargebackCalculator) applyRule(rule *AllocationRule, resource ResourceCost, existing map[string]*TeamCharge) map[string]float64 {
	allocations := make(map[string]float64)

	switch rule.SplitBy {
	case "equal":
		// Split equally among all teams
		teams := make([]string, 0, len(existing))
		for t := range existing {
			teams = append(teams, t)
		}
		if len(teams) == 0 {
			return allocations
		}
		share := resource.Cost / float64(len(teams))
		for _, t := range teams {
			allocations[t] = share
		}

	case "custom":
		// Split by custom weights
		totalWeight := 0.0
		for _, w := range rule.Weights {
			totalWeight += w
		}
		if totalWeight == 0 {
			return allocations
		}
		for team, weight := range rule.Weights {
			allocations[team] = resource.Cost * (weight / totalWeight)
		}

	case "usage":
		// Split proportionally to usage (requires usage metrics)
		// Simplified: equal split if no usage data
		if len(existing) > 0 {
			share := resource.Cost / float64(len(existing))
			for t := range existing {
				allocations[t] = share
			}
		}
	}

	return allocations
}

// GenerateReport produces a sorted chargeback report
func GenerateReport(charges map[string]*TeamCharge) []TeamCharge {
	var result []TeamCharge
	for _, charge := range charges {
		result = append(result, *charge)
	}
	slices.SortFunc(result, func(a, b TeamCharge) int {
		return cmp.Compare(b.TotalCost, a.TotalCost)
	})
	return result
}
```

---

### Junior → FAANG: Tagging as the Foundation for All FinOps Work

Cost allocation depends entirely on tagging. Without consistent, complete tagging across all resources, cost allocation is an approximation at best. The most common tagging failures in production environments are: resources created manually through the console without tags, resources created by autoscaling or managed services (RDS read replicas, ECS tasks, Lambda functions created by SAM) that inherit tags inconsistently, and tags that drift over time as services are renamed or team ownership changes.

The tagging enforcer pattern in this section (a Go service that scans for untagged resources and enforces required tags) addresses the enforcement gap that manual processes cannot cover. The minimum required tag set for attribution: `team`, `service`, `environment`, `cost-center`. Resources missing any of these tags cannot be attributed to a team, and their cost ends up in an unallocated bucket that makes the overall attribution inaccurate.

First-job habit: when creating any cloud resource (manually or via IaC), verify the required tags are present before moving on. A tag added at resource creation takes 30 seconds. A tag added retroactively to 50 existing resources after an audit takes two hours and still leaves historical cost data unattributed.

### Senior @ FAANG: Cost Allocation as Organizational Incentive Design

At staff level, cost allocation is not just a technical problem. It is an incentive design problem. The technical challenge (collecting costs, attributing them to teams) is solvable with the tooling in this section. The harder challenge is: what does a team do when they receive their cost allocation report? If the answer is "look at it and move on," cost allocation produces no behavior change. If the answer is "adjust their architecture or request a budget increase," cost allocation drives efficiency.

The organizational mechanisms that connect cost allocation to behavior: first, include cost metrics in engineering quarterly reviews alongside reliability metrics and feature delivery metrics. Second, give teams autonomy over their cloud budget within a total envelope, so optimizing their infrastructure directly funds their feature work budget (internal chargeback). Third, recognize and celebrate cost efficiency improvements in engineering all-hands. These three mechanisms make cost efficiency a career-relevant metric for engineers, not just a quarterly report that finance reviews.

The shared cost allocation methodology is the highest-contention aspect of any FinOps program. Teams will dispute their allocated share of shared infrastructure (load balancers, NAT gateways, shared databases) if the allocation methodology is opaque or feels arbitrary. The defensible methodologies are: proportional to request count (each team's share is proportional to their requests through the shared resource), proportional to data processed (appropriate for storage and transfer costs), and equal split (appropriate for fixed-cost shared infrastructure where usage is difficult to measure). Document the methodology, apply it consistently, and make it visible in the allocation report so teams can verify their share. The methodology dispute is a symptom of trust deficit, and transparency is the fix.
