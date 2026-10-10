## 105.7 Company Case Studies: SRE at Scale

### Google: The Birthplace of SRE

Google pioneered Site Reliability Engineering with these practices:

```go
// Google-style error budget tracking
package sre

import (
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// SLO definitions following Google's SRE book
type GoogleSLO struct {
    Name             string
    Target           float64       // e.g., 0.999 for 99.9%
    Window           time.Duration // Rolling window
    ConsequenceLevel string        // "page", "ticket", "log"
}

var ProductionSLOs = []GoogleSLO{
    {
        Name:             "availability",
        Target:           0.999,
        Window:           30 * 24 * time.Hour,
        ConsequenceLevel: "page",
    },
    {
        Name:             "latency_p50",
        Target:           0.99,
        Window:           30 * 24 * time.Hour,
        ConsequenceLevel: "ticket",
    },
    {
        Name:             "latency_p99",
        Target:           0.95,
        Window:           30 * 24 * time.Hour,
        ConsequenceLevel: "page",
    },
}

// Google's multi-window burn rate alerting (SRE Workbook)
// Fast burn: 1h window consuming 2% of monthly budget = page
// Slow burn: 3d window consuming 10% of monthly budget = ticket
var burnRateAlerts = []struct {
    Window        time.Duration
    BudgetPercent float64
    BurnRate      float64
}{
    {1 * time.Hour, 0.02, 14.4},   // Fast burn: page
    {6 * time.Hour, 0.05, 6.0},    // Medium burn: page
    {3 * 24 * time.Hour, 0.10, 1.0}, // Slow burn: ticket
}

// Toil tracking for SRE team
var toilHours = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "sre_toil_hours_total",
        Help: "Hours spent on toil by category",
    },
    []string{"category", "service"},
)

func RecordToil(category, service string, hours float64) {
    toilHours.WithLabelValues(category, service).Add(hours)
}
```

### Uber: Incident Management at Scale

Uber's SRE practices for managing incidents across 4,000+ microservices:

```go
// Uber-style incident management
package incident

import (
    "time"
)

type UberIncident struct {
    ID           string
    Severity     Severity
    Title        string
    Commander    *OnCallEngineer
    StartTime    time.Time

    // Uber-specific fields
    AffectedCities []string
    AffectedTrips  int64
    EstimatedLossCents int64

    // Communication
    SlackChannel   string
    StatusPageURL  string
    CustomerComms  []CustomerUpdate
}

type Severity int

const (
    SEV4 Severity = iota // Minor issues, no user impact
    SEV3                 // Degraded experience, limited impact
    SEV2                 // Major feature broken, significant impact
    SEV1                 // Complete outage, revenue impact
    SEV0                 // Company-wide emergency
)

// Response time expectations by severity
var ResponseTimes = map[Severity]struct {
    Acknowledge time.Duration
    Mitigate    time.Duration
    Resolve     time.Duration
}{
    SEV0: {1 * time.Minute, 15 * time.Minute, 4 * time.Hour},
    SEV1: {5 * time.Minute, 30 * time.Minute, 8 * time.Hour},
    SEV2: {15 * time.Minute, 2 * time.Hour, 24 * time.Hour},
    SEV3: {1 * time.Hour, 4 * time.Hour, 72 * time.Hour},
    SEV4: {4 * time.Hour, 24 * time.Hour, 168 * time.Hour},
}

// Automatic severity escalation based on impact
func (i *UberIncident) AutoEscalate() {
    // Lower iota value = less severe, so escalate when below the target level
    if i.AffectedTrips > 100000 && i.Severity < SEV1 {
        i.Severity = SEV1
        i.notifyEscalation()
    }
    if i.EstimatedLossCents > 100_000_000 && i.Severity < SEV0 {
        i.Severity = SEV0
        i.notifyExecutives()
    }
}
```

### Netflix: Chaos Engineering Integration

Netflix integrates chaos engineering into their SRE practices:

```go
// Netflix-style chaos-aware SRE
package sre

import (
    "math/rand/v2"
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// ChaosConfig for production resilience testing
type ChaosConfig struct {
    Enabled            bool
    LatencyInjection   LatencyConfig
    FailureInjection   FailureConfig
    ResourceExhaustion ResourceConfig
}

type LatencyConfig struct {
    Probability float64
    MinLatency  time.Duration
    MaxLatency  time.Duration
}

type FailureConfig struct {
    Probability float64
    ErrorCodes  []int
}

var chaosEventsTotal = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "chaos_events_total",
        Help: "Chaos injections performed",
    },
    []string{"type", "code"},
)

// ChaosMiddleware for controlled failure injection
func ChaosMiddleware(cfg ChaosConfig) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !cfg.Enabled {
                next.ServeHTTP(w, r)
                return
            }

            // Latency injection
            if rand.Float64() < cfg.LatencyInjection.Probability {
                latency := cfg.LatencyInjection.MinLatency +
                    time.Duration(rand.Int64N(int64(cfg.LatencyInjection.MaxLatency-cfg.LatencyInjection.MinLatency)))
                time.Sleep(latency)
            }

            // Failure injection
            if rand.Float64() < cfg.FailureInjection.Probability {
                code := cfg.FailureInjection.ErrorCodes[rand.IntN(len(cfg.FailureInjection.ErrorCodes))]
                http.Error(w, "Chaos Monkey says hi", code)
                chaosEventsTotal.WithLabelValues("failure", strconv.Itoa(code)).Inc()
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// GameDay exercise tracking
type GameDay struct {
    Date        time.Time
    Scenario    string
    Hypothesis  string
    Outcome     string
    Findings    []Finding
    ActionItems []ActionItem
}

var gameDayMetrics = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "netflix_gameday_exercises_total",
        Help: "Game day exercises conducted",
    },
    []string{"scenario_type", "outcome"},
)
```

### Stripe: Financial SRE

Stripe's SRE practices for financial systems:

```go
// Stripe-style financial SRE
package sre

import (
    "time"
)

// Financial SLOs are stricter than typical SLOs
var StripeSLOs = []SLO{
    {
        Name:   "payment_availability",
        Target: 0.9999, // 99.99% (4 nines)
        Window: 30 * 24 * time.Hour,
        Impact: "Revenue loss, merchant trust",
    },
    {
        Name:   "payment_latency_p99",
        Target: 0.99,
        Threshold: 500 * time.Millisecond,
        Window: 24 * time.Hour,
        Impact: "Checkout abandonment",
    },
    {
        Name:   "data_consistency",
        Target: 1.0, // Must be 100%
        Window: 24 * time.Hour,
        Impact: "Financial reconciliation failures",
    },
}

// Incident classification for financial systems
type FinancialIncident struct {
    BaseIncident

    // Financial-specific fields
    MoneyMoved      bool
    ReconciliationImpact bool
    ComplianceImpact    bool
    MerchantNotified    bool
}

// Mandatory post-mortem for any money-moving incident
// or anything at SEV2 severity or worse
func (i *FinancialIncident) RequiresPostMortem() bool {
    return i.MoneyMoved || i.ReconciliationImpact || i.Severity >= SEV2
}

// Automatic regulatory notification for certain incidents
func (i *FinancialIncident) CheckComplianceNotification() {
    if i.ComplianceImpact {
        i.notifyCompliance()
        i.startRegulatoryTimer() // 72-hour notification requirement
    }
}
```

### Amazon: Two-Pizza Team SRE

Amazon's approach to distributed SRE ownership:

```go
// Amazon-style service ownership and on-call
package sre

import (
    "time"
)

// TwoPizzaTeam owns their service end-to-end
type TwoPizzaTeam struct {
    TeamName    string
    Services    []Service
    OnCall      OnCallRotation
    RunBooks    []RunBook
    Dashboards  []Dashboard

    // Operational metrics
    MTTR        time.Duration // Mean Time To Recovery
    ChangeFailRate float64   // Percentage of changes causing incidents
    DeployFreq     int       // Deploys per day
}

// COE (Correction of Error): Amazon's post-mortem format
type COE struct {
    IncidentID    string
    Title         string

    // The 5 Whys
    ProblemStatement string
    Why1            string
    Why2            string
    Why3            string
    Why4            string
    Why5            string // Root cause

    // Corrective actions
    ImmediateActions []Action
    PreventiveActions []Action

    // Review
    ReviewDate    time.Time
    Reviewers     []string
    Status        string
}

// Weekly operations review (WOR) metrics
type WeeklyOpsReview struct {
    Week               time.Time
    IncidentCount      int
    SeverityBreakdown  map[Severity]int
    MTTRByService      map[string]time.Duration
    TopIssues          []string
    ActionItemProgress int // Percentage complete
}
```

**SRE Practices by Company**:

| Company | Key Practice | Unique Approach |
|---------|-------------|-----------------|
| Google | Error Budgets | Multi-window burn rate alerts |
| Uber | Impact-Based Severity | Auto-escalation based on trips/revenue |
| Netflix | Chaos Engineering | Production failure injection |
| Stripe | Financial SLOs | 99.99% availability, 100% consistency |
| Amazon | Two-Pizza Teams | Full service ownership, COE process |

### Junior → FAANG: What These Companies Have in Common

Each company in the table started somewhere simpler and evolved their SRE practices as their scale and reliability requirements grew. The common thread is that reliability investment was driven by business impact: Uber's impact-based severity system ties on-call response directly to trips and revenue, which makes the business case for reliability unmistakable.

For a first job, the Netflix chaos engineering case study is the most teachable: the idea that deliberately injecting failures in production makes systems more reliable sounds counterintuitive but is deeply practical. A system that has survived random instance termination repeatedly is provably more resilient than one that has never been tested under failure conditions.

### Senior @ FAANG: Contextualizing These Patterns for Your Organization

Bar-raiser interviewers test whether candidates can adapt these patterns to their specific context rather than cargo-culting them. Google's error budget policy works because product and engineering leadership are aligned on the trade-off. Amazon's two-pizza team model works because the organization is structured to give teams full ownership of their services including production operations. Neither works if transplanted to an organization without the corresponding cultural and structural foundations.

An L6 engineer who has successfully introduced SRE practices at a company has a story about the organizational change, not just the technical implementation. Which stakeholders needed to be convinced? What metrics were used to demonstrate early value? What resistance was encountered and how was it overcome? These organizational change management skills are what distinguishes a staff engineer from a senior engineer.

---
