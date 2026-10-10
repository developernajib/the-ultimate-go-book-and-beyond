## 89.1 When to Refactor

### The Refactoring Decision Framework

Not every piece of ugly code deserves a refactor. The decision to refactor should be driven by measurable pain, not aesthetics or boredom. Before committing engineering time, you need to distinguish between good reasons (the system is actively hurting velocity, reliability, or security) and bad reasons (the code style offends you). The following framework helps you make that distinction by forcing you to articulate the concrete problem, the cost of inaction, and the opportunity cost of doing the work.

```
┌──────────────────────────────────────────────────────────────────┐
│              SHOULD WE REFACTOR?                                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  GOOD REASONS TO REFACTOR:                                       │
│  ├── Velocity impact: "Changes take 3x longer than they should"  │
│  ├── Bug magnet: "This area has repeated production issues"      │
│  ├── Scaling blocker: "System can't handle projected load"       │
│  ├── Security risk: "Architecture has known vulnerabilities"     │
│  ├── Team pain: "Onboarding takes weeks due to complexity"       │
│  └── Business enabler: "New features impossible without change"  │
│                                                                  │
│  BAD REASONS TO REFACTOR:                                        │
│  ├── Resume driven: "I want to use new technology X"             │
│  ├── Aesthetic: "The code is ugly but works fine"                │
│  ├── Boredom: "We haven't changed this in a while"               │
│  ├── Perfect is enemy of good: "It could be better"              │
│  └── New hire syndrome: "Previous engineers were wrong"          │
│                                                                  │
│  QUESTIONS TO ASK:                                               │
│  1. What is the concrete problem we're solving?                  │
│  2. How do we measure success?                                   │
│  3. What's the cost of not refactoring?                          │
│  4. What's the opportunity cost of refactoring?                  │
│  5. Can we achieve the goal with smaller changes?                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Measuring Technical Debt

If you want leadership to fund your refactor, you need numbers, not feelings. Technical debt is real, but "the code is hard to work with" does not survive a prioritization meeting. Instead, measure the impact in terms that matter to the business: how long do changes take, how often does this component cause incidents, how long does onboarding take? The struct below shows the categories of metrics you should collect before proposing any large refactor, along with a simple ROI calculation that translates engineering pain into dollar amounts.

```go
// Ways to quantify technical debt

type TechnicalDebtMetrics struct {
    // Time-based metrics
    AverageTimeToChange    time.Duration  // How long to make typical changes
    TimeSpentOnBugs        float64        // % of time on bugs vs features
    OnboardingTime         time.Duration  // Time for new engineer to contribute

    // Quality metrics
    BugsPerMonth           int
    IncidentsFromComponent int
    TestCoverage           float64
    CyclomaticComplexity   float64

    // Velocity metrics
    DeployFrequency        float64  // Deploys per week
    ChangeFailureRate      float64  // % of changes causing issues
    LeadTime               time.Duration  // Commit to production

    // Team metrics
    DeveloperSatisfaction  float64  // Survey score
    PRReviewTime           time.Duration
}

// Example: Making the case for refactoring
func BuildRefactoringCase() {
    current := TechnicalDebtMetrics{
        AverageTimeToChange: 2 * 24 * time.Hour,  // 2 days
        BugsPerMonth:        15,
        OnboardingTime:      4 * 7 * 24 * time.Hour,  // 4 weeks
    }

    projected := TechnicalDebtMetrics{
        AverageTimeToChange: 4 * time.Hour,  // 4 hours
        BugsPerMonth:        5,
        OnboardingTime:      1 * 7 * 24 * time.Hour,  // 1 week
    }

    // ROI calculation
    engineerCostPerHour := 100  // USD
    hoursPerWeek := 40
    engineers := 10

    currentCostPerMonth := current.BugsPerMonth * 8 * engineerCostPerHour  // 8 hours per bug
    projectedCostPerMonth := projected.BugsPerMonth * 8 * engineerCostPerHour

    monthlySavings := currentCostPerMonth - projectedCostPerMonth
    // $12,000 - $4,000 = $8,000/month savings
    _ = hoursPerWeek
    _ = engineers
    _ = monthlySavings
}
```

### Junior → FAANG: Speaking the Language of Justified Refactoring

Junior candidates often fail refactoring questions by justifying the work aesthetically: "the code was messy." FAANG interviewers hear this as an inability to reason about trade-offs. Practice reframing every refactoring story in terms of measured pain (incident rate, deployment frequency, time to onboard) and calculated benefit. Even a small refactor you did becomes a stronger interview story when you can say "we reduced the time to add a new payment method from three weeks to two days."

The ROI framework in this section is directly transferable to a behavioral answer. The formula cost-of-inaction versus cost-of-action is the same logic an Amazon interviewer uses when applying "Frugality" and "Bias for Action" simultaneously.

### Senior @ FAANG: The Decision Not to Refactor as a Leadership Signal

At staff level, the decision NOT to refactor is as important as the decision to do so. A bar-raiser interviewer at Google will probe this explicitly: "Tell me about technical debt you chose to leave in place and why." The strong answer names the opportunity cost of the refactor, the business priority that took precedence, the mitigation you put in place to contain the debt (a linter rule, a runbook, a type alias that prevents incorrect usage), and the trigger condition that would revisit the decision.

Governance at scale means your "when to refactor" criteria should be documented and shared across your org, not just applied individually. A maturity indicator for a platform team is a written policy that defines the refactoring threshold: for example, a service that generates more than 15 percent of incident load per quarter automatically enters a refactoring review. This transforms a judgment call into an organizational process, which is L7-level thinking.

---
