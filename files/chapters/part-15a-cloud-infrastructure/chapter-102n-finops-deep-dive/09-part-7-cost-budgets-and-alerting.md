## 102N.7 Cost Budgets and Alerting

AWS Budgets lets you define monthly cost thresholds per account, service, or tag and triggers SNS notifications when actual or forecasted spend crosses configurable percentage thresholds. The Go SDK's `budgets.CreateBudget` call accepts two independent notification types: `ACTUAL` for real-time breach detection at 80% consumed and `FORECASTED` for predictive alerting when AWS's ML model projects a full-month overrun before month-end. Tag-based `CostFilters` scope the budget to production workloads only, preventing development spend from inflating the alert signal.

```go
package budgets

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/budgets"
	budgetstypes "github.com/aws/aws-sdk-go-v2/service/budgets/types"
)

// BudgetManager creates and manages AWS Budgets
type BudgetManager struct {
	client    *budgets.Client
	accountID string
}

// CreateMonthlyBudget creates a monthly cost budget with SNS alerts
func (m *BudgetManager) CreateMonthlyBudget(ctx context.Context, name string, limitUSD float64, alertEmail string) error {
	limitStr := fmt.Sprintf("%.2f", limitUSD)

	_, err := m.client.CreateBudget(ctx, &budgets.CreateBudgetInput{
		AccountId: aws.String(m.accountID),
		Budget: &budgetstypes.Budget{
			BudgetName: aws.String(name),
			BudgetType: budgetstypes.BudgetTypeCost,
			TimeUnit:   budgetstypes.TimeUnitMonthly,
			BudgetLimit: &budgetstypes.Spend{
				Amount: aws.String(limitStr),
				Unit:   aws.String("USD"),
			},
			CostFilters: map[string][]string{
				"TagKeyValue": {"user:Environment$prod"},
			},
		},
		NotificationsWithSubscribers: []budgetstypes.NotificationWithSubscribers{
			{
				Notification: &budgetstypes.Notification{
					NotificationType:   budgetstypes.NotificationTypeActual,
					ComparisonOperator: budgetstypes.ComparisonOperatorGreaterThan,
					Threshold:          aws.Float64(80), // Alert at 80%
					ThresholdType:      budgetstypes.ThresholdTypePercentage,
				},
				Subscribers: []budgetstypes.Subscriber{
					{
						SubscriptionType: budgetstypes.SubscriptionTypeEmail,
						Address:          aws.String(alertEmail),
					},
				},
			},
			{
				Notification: &budgetstypes.Notification{
					NotificationType:   budgetstypes.NotificationTypeForecasted,
					ComparisonOperator: budgetstypes.ComparisonOperatorGreaterThan,
					Threshold:          aws.Float64(100), // Alert when forecast exceeds budget
					ThresholdType:      budgetstypes.ThresholdTypePercentage,
				},
				Subscribers: []budgetstypes.Subscriber{
					{
						SubscriptionType: budgetstypes.SubscriptionTypeEmail,
						Address:          aws.String(alertEmail),
					},
				},
			},
		},
	})
	return err
}

// GetBudgetStatus returns current vs budgeted spend
func (m *BudgetManager) GetBudgetStatus(ctx context.Context, budgetName string) (*BudgetStatus, error) {
	out, err := m.client.DescribeBudget(ctx, &budgets.DescribeBudgetInput{
		AccountId:  aws.String(m.accountID),
		BudgetName: aws.String(budgetName),
	})
	if err != nil {
		return nil, fmt.Errorf("describe budget: %w", err)
	}

	b := out.Budget
	status := &BudgetStatus{Name: aws.ToString(b.BudgetName)}

	if b.BudgetLimit != nil && b.BudgetLimit.Amount != nil {
		fmt.Sscanf(aws.ToString(b.BudgetLimit.Amount), "%f", &status.LimitUSD)
	}
	if b.CalculatedSpend != nil && b.CalculatedSpend.ActualSpend != nil {
		fmt.Sscanf(aws.ToString(b.CalculatedSpend.ActualSpend.Amount), "%f", &status.ActualUSD)
	}
	if b.CalculatedSpend != nil && b.CalculatedSpend.ForecastedSpend != nil {
		fmt.Sscanf(aws.ToString(b.CalculatedSpend.ForecastedSpend.Amount), "%f", &status.ForecastUSD)
	}

	if status.LimitUSD > 0 {
		status.UtilizationPercent = status.ActualUSD / status.LimitUSD * 100
	}

	return status, nil
}

type BudgetStatus struct {
	Name               string
	LimitUSD           float64
	ActualUSD          float64
	ForecastUSD        float64
	UtilizationPercent float64
}
```

---

### Junior → FAANG: Budget Alerts as the Safety Net for All Cloud Spend

AWS Budgets is the safety net that catches runaway spend before it becomes a crisis. The three alert thresholds in this section (80% actual, 100% forecasted, 100% actual) form a graduated response pattern: the 80% actual alert is an early warning that gives the team time to investigate and potentially reduce spend before the month ends. The 100% forecasted alert is a predictive signal that spend is on track to exceed the budget even if no spike has occurred yet (gradual regressions, increasing traffic, new feature cost). The 100% actual alert is the breach notification requiring immediate response.

The tag-based filter (production environment only) is a design choice worth understanding: development and staging spend is excluded from the production budget because development spend is expected to be variable and lower priority. Without this filter, a developer who spins up a large dev environment temporarily would trigger production budget alerts, causing false urgency. Separating production from non-production budgets with different thresholds (production at 80%/100%, non-production at 150% with no forecasted alert) reflects the different risk profiles of each environment.

### Senior @ FAANG: Budget Architecture as Organizational Cost Governance

At staff level, budget architecture is a governance mechanism, not just a technical alert configuration. The organizational questions to answer before implementing budgets: what is the budget authority model? Who sets the budget for each team? Who approves budget increases? What happens when a team exceeds their budget? A budget system without answers to these questions produces alerts that no one acts on.

The recommended model: the FinOps team or finance sets the organizational cloud budget and allocates it to cost centers (typically product areas or engineering verticals). Each cost center manager allocates their portion to teams. Team leads own their team's budget and are accountable for overruns in quarterly engineering reviews. Budget increases require a written justification that includes the expected business outcome (traffic growth, new feature, migration) and the projected cost impact. This model creates accountability at each level of the organization without micromanaging individual resource decisions.

Savings Plans utilization tracking (the `UtilizationPercent` struct in this section) is the final piece of the budget governance picture. Savings Plans are commitments: the organization pays for the committed capacity whether it is used or not. A Savings Plans with 60% utilization wastes 40% of the commitment value. Tracking utilization and alerting when it drops below 80% is the mechanism that catches Savings Plans that were purchased for a workload that was later scaled down or terminated. The alert gives the organization time to reallocate the Savings Plans commitment to a different instance family (for Compute Savings Plans, which are portable) before the commitment period ends.
