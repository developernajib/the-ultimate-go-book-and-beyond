## 105.6 Post-Mortem Template

### Blameless Post-Mortem Structure

Post-mortems extract systematic improvements from incidents by establishing a blameless root cause analysis and tracking action items to completion. The following template structures the timeline, contributing factors, detection gaps, and preventive actions in a format that facilitates productive team review.

```go
package postmortem

import (
    "time"
)

type PostMortem struct {
    IncidentID      string
    Title           string
    Date            time.Time
    Authors         []string
    Status          string // draft, reviewed, published

    Summary         Summary
    Timeline        []TimelineEvent
    RootCause       RootCause
    Impact          Impact
    LessonsLearned  LessonsLearned
    ActionItems     []ActionItem
}

type Summary struct {
    Brief           string
    Duration        time.Duration
    Severity        string
    ServicesAffected []string
    TeamsInvolved   []string
}

type TimelineEvent struct {
    Time        time.Time
    Event       string
    DetectedBy  string // alert, user report, engineer
}

type RootCause struct {
    Description string
    Category    string // deployment, config, capacity, dependency, code bug
    Details     string
    Contributing []string // Contributing factors
}

type Impact struct {
    UserImpact       string
    RevenueImpact    string
    SLOImpact        string
    ErrorBudgetSpent float64
    RequestsFailed   int64
    UsersAffected    int64
}

type LessonsLearned struct {
    WhatWorked    []string
    WhatDidntWork []string
    WhereLucky    []string
}

type ActionItem struct {
    ID          string
    Description string
    Type        string // prevent, detect, mitigate
    Owner       string
    Priority    string // P0, P1, P2
    DueDate     time.Time
    Status      string // open, in-progress, completed
    Bug         string // link to tracking issue
}

func parseTime(s string) time.Time {
    t, _ := time.Parse("2006-01-02 15:04", s)
    return t
}

// Example post-mortem
var ExamplePostMortem = PostMortem{
    Title: "Database Connection Pool Exhaustion",
    Summary: Summary{
        Brief:            "Database connection pool exhausted causing cascading failures",
        Duration:         45 * time.Minute,
        Severity:         "P1",
        ServicesAffected: []string{"api-gateway", "user-service", "order-service"},
        TeamsInvolved:    []string{"Platform", "Backend", "SRE"},
    },
    Timeline: []TimelineEvent{
        {Time: parseTime("2024-01-15 14:00"), Event: "Deployment of user-service v2.1.0"},
        {Time: parseTime("2024-01-15 14:15"), Event: "Connection pool metrics start rising", DetectedBy: "monitoring"},
        {Time: parseTime("2024-01-15 14:25"), Event: "First 5xx errors reported", DetectedBy: "alert"},
        {Time: parseTime("2024-01-15 14:30"), Event: "Incident declared, on-call paged"},
        {Time: parseTime("2024-01-15 14:45"), Event: "Root cause identified - connection leak"},
        {Time: parseTime("2024-01-15 14:50"), Event: "Rollback initiated"},
        {Time: parseTime("2024-01-15 15:00"), Event: "Services recovering"},
        {Time: parseTime("2024-01-15 15:15"), Event: "Incident resolved"},
    },
    RootCause: RootCause{
        Description: "New code path in user-service v2.1.0 didn't properly close database connections",
        Category:    "code bug",
        Details:     "defer stmt.Close() was missing in the new GetUsersByRole function",
        Contributing: []string{
            "Code review didn't catch missing defer",
            "No integration test for connection cleanup",
            "Connection pool exhaustion alert threshold too high",
        },
    },
    Impact: Impact{
        UserImpact:       "Users unable to log in or access their accounts",
        RevenueImpact:    "Estimated $15,000 in failed transactions",
        SLOImpact:        "Availability dropped to 95.2% (target 99.9%)",
        ErrorBudgetSpent: 0.048, // 4.8%
        RequestsFailed:   125000,
        UsersAffected:    8500,
    },
    LessonsLearned: LessonsLearned{
        WhatWorked: []string{
            "Alert fired within 10 minutes of issue",
            "Rollback process worked smoothly",
            "Incident commander assigned quickly",
        },
        WhatDidntWork: []string{
            "Connection pool alert threshold was 90% - too high",
            "No automated canary deployment",
            "Debug logging was insufficient",
        },
        WhereLucky: []string{
            "Incident occurred during business hours with full team available",
            "Recent deployment made rollback target obvious",
        },
    },
    ActionItems: []ActionItem{
        {
            ID:          "PM-2024-001-01",
            Description: "Add integration test for database connection cleanup",
            Type:        "prevent",
            Owner:       "backend-team",
            Priority:    "P0",
            Status:      "in-progress",
        },
        {
            ID:          "PM-2024-001-02",
            Description: "Lower connection pool alert threshold to 70%",
            Type:        "detect",
            Owner:       "sre-team",
            Priority:    "P1",
            Status:      "completed",
        },
        {
            ID:          "PM-2024-001-03",
            Description: "Implement canary deployments",
            Type:        "mitigate",
            Owner:       "platform-team",
            Priority:    "P1",
            Status:      "open",
        },
    },
}
```

### Junior → FAANG: Blameless Post-Mortems Are About System Design, Not People

A blameless post-mortem starts from the premise that engineers make reasonable decisions given the information and tools available to them at the time. When something goes wrong, the question is not "who made the mistake" but "what system or process allowed this mistake to have the observed impact, and how do we prevent the same class of mistake in the future?"

For a first job, participate in post-mortems even when you were not directly involved in the incident. Reading the timeline, understanding the contributing factors, and thinking about what you would have done differently builds operational judgment faster than any other practice.

Interview entry point: "Describe a production incident and what you learned from the post-mortem." The strong answer describes a specific incident, the timeline, the contributing factors (not the person who deployed the bad code, but the system that allowed the deployment to proceed without catching the issue), and a specific improvement that resulted. The weak answer describes blame.

### Senior @ FAANG: Post-Mortem Culture as an Organizational Reliability Investment

At L6, the post-mortem process is a reliability investment. Each post-mortem produces action items, and those action items must be tracked to completion with owners and due dates. A post-mortem without follow-through is worse than no post-mortem: it creates the expectation of improvement without delivering it, eroding trust in the reliability process.

An L6 engineer implements post-mortem governance: action items are tracked in the engineering backlog alongside feature work, reviewed in sprint planning, and reported on a monthly reliability engineering dashboard. The metric is "percentage of P1 post-mortem action items completed within 30 days." If this metric is below 80%, the reliability process is broken and needs an organizational intervention.

Staff-level engineers use post-mortem data as a signal for platform investment priorities. If 40% of post-mortems in the past quarter mention "lack of visibility into X" as a contributing factor, that is a quantified case for investing in observability for X. The post-mortem corpus is a data asset that makes reliability investment decisions evidence-based rather than opinion-driven.

---
