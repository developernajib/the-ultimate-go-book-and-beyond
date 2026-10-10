## 105.10 On-Call Strategies for Go Services

### Effective On-Call Rotation

Effective on-call design minimizes alert fatigue by routing only actionable, high-severity alerts to on-call engineers and providing sufficient context for rapid triage. The following code models a rotation with escalation policies, the health metrics that reveal whether a rotation is sustainable, and a handoff checklist that keeps context from being lost between shifts.

```go
// On-call rotation management for Go teams
package oncall

import (
    "time"
)

// OnCallRotation manages team on-call schedules
type OnCallRotation struct {
    TeamName       string
    PrimaryShift   time.Duration // Usually 1 week
    SecondaryShift time.Duration // Backup rotation
    Handoff        time.Time     // When shifts change
    Members        []OnCallMember
    Escalation     EscalationPolicy
}

type OnCallMember struct {
    Name        string
    Email       string
    Phone       string
    Timezone    string
    Skills      []string // e.g., "database", "kubernetes"
    MaxShifts   int      // Per month
}

type EscalationPolicy struct {
    Levels []EscalationLevel
}

type EscalationLevel struct {
    WaitTime time.Duration
    Target   string // e.g., "secondary_oncall", "team_lead"
}

// On-call health metrics
type OnCallMetrics struct {
    AlertsPerShift     int
    AcknowledgeTime    time.Duration
    MTTRAcknowledge    time.Duration
    MTTRResolve        time.Duration
    EscalationRate     float64 // Percentage escalated
    FalsePositiveRate  float64 // Non-actionable alerts
    ToilHours          float64 // Hours spent on repetitive tasks
}

// Healthy on-call targets
var HealthyOnCallTargets = struct {
    MaxAlertsPerShift int
    MaxAckTime        time.Duration
    MaxEscalationRate float64
    MaxFalsePositives float64
    MaxToilPercent    float64
}{
    MaxAlertsPerShift: 10,              // More = alert fatigue
    MaxAckTime:        5 * time.Minute, // Reasonable response
    MaxEscalationRate: 0.10,            // 10% escalated
    MaxFalsePositives: 0.25,            // 25% non-actionable
    MaxToilPercent:    0.30,            // 30% toil maximum
}

// On-call handoff checklist
var HandoffChecklist = []string{
    "Review open incidents",
    "Check error budget status",
    "Review recent deployments",
    "Check pending action items from postmortems",
    "Review any service changes this week",
    "Confirm escalation contacts available",
    "Test paging system",
}
```

### Toil Management

Toil is manual, repetitive operational work that scales with service load rather than improving over time, and its reduction is a core SRE objective. The following automation examples demonstrate common toil elimination patterns: self-healing scripts, automated certificate renewal, and capacity scaling triggers.

```go
// Toil tracking and automation planning
package toil

import (
    "cmp"
    "slices"
    "strconv"
    "strings"
    "time"
)

// ToilCategory represents types of repetitive work
type ToilCategory string

const (
    ToilManualDeploy     ToilCategory = "manual_deploy"
    ToilCapacityPlanning ToilCategory = "capacity_planning"
    ToilSecurityPatching ToilCategory = "security_patching"
    ToilIncidentCleanup  ToilCategory = "incident_cleanup"
    ToilReportGeneration ToilCategory = "report_generation"
    ToilConfigChanges    ToilCategory = "config_changes"
    ToilUserRequests     ToilCategory = "user_requests"
)

// ToilItem represents a piece of toil work
type ToilItem struct {
    Category        ToilCategory
    Description     string
    Frequency       string // daily, weekly, monthly
    TimePerOccurrence time.Duration
    OccurrencesPerMonth int
    MonthlyToilHours float64
    CanAutomate     bool
    AutomationEffort string // hours to automate
    Priority        int     // 1-5, based on ROI
}

// parseHours converts an effort estimate like "16h" to hours
func parseHours(s string) float64 {
    h, _ := strconv.ParseFloat(strings.TrimSuffix(s, "h"), 64)
    return h
}

// Calculate automation ROI
func (t *ToilItem) AutomationROI() float64 {
    if !t.CanAutomate {
        return 0
    }

    annualToilHours := t.MonthlyToilHours * 12
    // Assume automation lasts 2 years
    totalSavings := annualToilHours * 2

    automationHours := parseHours(t.AutomationEffort)
    if automationHours == 0 {
        return 0
    }

    return totalSavings / automationHours
}

// ToilBudget for a team
type ToilBudget struct {
    TeamCapacity    float64 // Total engineering hours/month
    ToilTarget      float64 // Target toil percentage (e.g., 0.30)
    CurrentToil     float64 // Actual toil hours
}

func (b *ToilBudget) ToilPercentage() float64 {
    return b.CurrentToil / b.TeamCapacity
}

func (b *ToilBudget) IsHealthy() bool {
    return b.ToilPercentage() <= b.ToilTarget
}

func (b *ToilBudget) ToilOverrun() float64 {
    if b.IsHealthy() {
        return 0
    }
    return b.CurrentToil - (b.TeamCapacity * b.ToilTarget)
}

// Automation prioritization
func PrioritizeAutomation(items []ToilItem) []ToilItem {
    // Sort by ROI (highest first)
    slices.SortFunc(items, func(a, b ToilItem) int {
        return cmp.Compare(b.AutomationROI(), a.AutomationROI())
    })
    return items
}
```

### Junior → FAANG: On-Call as a Learning Opportunity

Many junior engineers dread on-call. The most effective reframe is to treat each on-call incident as a free production debugging session with stakes that force focused attention. Every incident you respond to teaches you something about the system that you would not learn from reading documentation or code.

Two practical habits for first on-call rotations: keep a personal incident journal (what fired, what you checked, what resolved it), and debrief with a senior engineer after each non-trivial incident. The journal builds pattern recognition. The debrief fills gaps in your mental model of the system.

For Go services specifically, learn the `net/http/pprof` endpoints before your first on-call shift. Being able to capture goroutine dumps, heap profiles, and CPU profiles during a live incident is a skill that directly reduces MTTR.

### Senior @ FAANG: On-Call Health as an Engineering Leadership Responsibility

On-call is not just an engineering task: it is an engineering health metric. Sustained high on-call load (more than 10 actionable pages per shift, more than 2 hours of on-call work per week) degrades engineer well-being, increases attrition, and reduces the cognitive capacity available for feature work. An L6 engineer treats on-call health with the same urgency as system reliability.

Concrete interventions: review the on-call rotation quarterly to identify the highest-volume alert categories and automate or eliminate them. A toil reduction target of 10% per quarter is achievable without heroics if it is treated as engineering work with capacity allocated, not a background activity done between incidents. Publish the on-call volume metric (pages per rotation, MTTR, alert volume by category) to engineering leadership to create organizational visibility and accountability for on-call health.

At staff level, sustainable on-call is a design constraint: new services should not be allowed to add their on-call load to an already-overloaded rotation without corresponding automation investment. The platform team defines an on-call capacity model that quantifies how many additional services a rotation can absorb before health degrades, and uses this model to gate service launches and team on-call scope expansions.

---
