## 105.3 Error Budgets

### Error Budget Calculator

An error budget is the inverse of the SLO target: at 99.9% over 30 days, the service is allowed 0.1% failed requests, which translates to 43.2 minutes of full downtime. The calculator below turns raw request counts into a budget status with burn rate and time to exhaustion, the two numbers that drive freeze and alert decisions.

```go
package errorbudget

import (
    "time"
)

type ErrorBudget struct {
    SLOTarget      float64       // e.g., 0.999 for 99.9%
    WindowDuration time.Duration // e.g., 30 days
}

func NewErrorBudget(target float64, window time.Duration) *ErrorBudget {
    return &ErrorBudget{
        SLOTarget:      target,
        WindowDuration: window,
    }
}

// TotalBudget returns the total error budget as a ratio
func (eb *ErrorBudget) TotalBudget() float64 {
    return 1 - eb.SLOTarget // e.g., 0.001 for 99.9%
}

// TotalBudgetMinutes returns the budget in minutes
func (eb *ErrorBudget) TotalBudgetMinutes() float64 {
    return eb.TotalBudget() * eb.WindowDuration.Minutes()
}

// BudgetStatus represents current error budget state
type BudgetStatus struct {
    TotalBudget       float64
    ConsumedBudget    float64
    RemainingBudget   float64
    RemainingPercent  float64
    BurnRate          float64 // Current burn rate (1.0 = sustainable)
    TimeToExhaustion  time.Duration
    IsHealthy         bool
}

// Calculate calculates current error budget status
func (eb *ErrorBudget) Calculate(totalRequests, failedRequests int64, windowElapsed time.Duration) BudgetStatus {
    if totalRequests == 0 {
        return BudgetStatus{IsHealthy: true}
    }

    totalBudget := eb.TotalBudget()
    actualErrorRate := float64(failedRequests) / float64(totalRequests)
    consumedBudget := actualErrorRate
    remainingBudget := totalBudget - consumedBudget

    // Calculate burn rate
    expectedBudgetUsage := totalBudget * (windowElapsed.Seconds() / eb.WindowDuration.Seconds())
    burnRate := consumedBudget / expectedBudgetUsage
    if expectedBudgetUsage == 0 {
        burnRate = 0
    }

    // Time to exhaustion
    var timeToExhaustion time.Duration
    if burnRate > 0 && consumedBudget < totalBudget {
        remainingTime := eb.WindowDuration - windowElapsed
        budgetRemaining := totalBudget - consumedBudget
        if burnRate > 1 {
            // At current burn rate, when will we exhaust?
            exhaustionRate := (consumedBudget / windowElapsed.Seconds()) // errors per second
            if exhaustionRate > 0 {
                timeToExhaustion = time.Duration(budgetRemaining/exhaustionRate) * time.Second
            }
        } else {
            timeToExhaustion = remainingTime
        }
    }

    return BudgetStatus{
        TotalBudget:       totalBudget,
        ConsumedBudget:    consumedBudget,
        RemainingBudget:   remainingBudget,
        RemainingPercent:  (remainingBudget / totalBudget) * 100,
        BurnRate:          burnRate,
        TimeToExhaustion:  timeToExhaustion,
        IsHealthy:         remainingBudget > 0 && burnRate <= 1.5,
    }
}

// ShouldFreezeReleases returns true if releases should be frozen
func (bs BudgetStatus) ShouldFreezeReleases() bool {
    return bs.RemainingPercent < 25 || bs.BurnRate > 2.0
}

// ShouldAlert returns true if alerting is needed
func (bs BudgetStatus) ShouldAlert() bool {
    return bs.RemainingPercent < 50 || bs.BurnRate > 1.5
}
```

### Junior → FAANG: Error Budget as Permission to Deploy

The most powerful thing about error budgets is what they say about velocity. When the error budget is healthy (greater than 50% remaining), the team has permission to move fast, deploy frequently, and experiment. When the budget is exhausted, the team must stop feature work and focus on reliability. This trade-off is the core insight: reliability and velocity are not opposites, they are connected through the error budget.

For interviews, be ready to explain what happens when the error budget runs out before the end of the month. The answer is not "keep deploying and hope for the best." The answer is: freeze non-critical deployments, investigate the reliability issues that consumed the budget, and implement fixes before the next month's budget resets.

### Senior @ FAANG: Error Budget Policy as an Organizational Forcing Function

An error budget without a policy is just a metric. The policy is what gives it organizational teeth. An L6 engineer writes and gets sign-off on a policy that specifies: when the error budget falls below 25%, the team lead must notify the product manager. When it reaches 0%, all feature deployments are frozen and the team shifts to reliability work. When it reaches 0% for two consecutive months, an SLO review is triggered to determine whether the SLO target is appropriate for the current service maturity.

The hardest part of implementing this policy is the organizational alignment: product managers and engineering managers must agree that "error budget exhausted" is a legitimate reason to pause a feature roadmap. An L6 engineer builds this alignment before writing the policy, by demonstrating the business case: continued deployment into an exhausted error budget correlates with higher incident rates, which correlates with customer churn, which correlates with revenue loss. The data makes the case. The policy formalizes the response.

---
