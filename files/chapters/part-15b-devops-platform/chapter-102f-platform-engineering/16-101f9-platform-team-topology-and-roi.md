## 102F.14 Platform Team Topology and ROI

### Team Topologies Model

Team Topologies (Skelton & Pais) defines four team types:

```
Stream-aligned teams:    build features for end users
                         → deploy independently, minimal cognitive load

Platform teams:          enable stream-aligned via X-as-a-Service
                         → internal customers are developers, not users

Enabling teams:          short-term coaching (not permanent ownership)
                         → "help all teams adopt tracing this quarter"

Complicated subsystem:   deep specialized expertise (ML infra, trading engine)
                         → not a general platform - domain-specific
```

**The gatekeeper anti-pattern kills adoption:**

```
BAD:  Need a database? → Jira ticket → 2-week wait → manual provisioning
      → no visibility, no SLA, bottleneck scales with usage

GOOD: Need a database? → apply PostgreSQLInstance YAML to namespace
      → Crossplane reconciles → credentials in Secret in 10 minutes
      → zero tickets, no waiting, scales infinitely
```

### Measuring and Communicating Platform ROI

Platform teams are often questioned about value. Quantify ROI:

```go
package roi

// PlatformROI quantifies the business value of the internal developer platform.
type PlatformROI struct {
	// Onboarding
	NewServicesPerMonth          int
	OnboardingDaysBefore         float64 // e.g., 14 days
	OnboardingDaysAfter          float64 // e.g., 0.5 days (4 hours)

	// Deployment velocity
	DeploymentsPerMonth          int
	LeadTimeDaysBefore           float64 // e.g., 5 days
	LeadTimeDaysAfter            float64 // e.g., 0.5 days

	// Incident reduction
	IncidentsPerMonthBefore      float64
	IncidentsPerMonthAfter       float64
	AvgIncidentEngineerHours     float64

	// Costs
	AvgEngineerHourlyCostCents   int64 // fully loaded, including overhead (e.g., 15000 cents = $150/hr)
}

func (r PlatformROI) MonthlyEngineerHoursSaved() float64 {
	onboarding := float64(r.NewServicesPerMonth) *
		(r.OnboardingDaysBefore - r.OnboardingDaysAfter) * 8

	deployment := float64(r.DeploymentsPerMonth) *
		(r.LeadTimeDaysBefore - r.LeadTimeDaysAfter) * 8

	incidents := (r.IncidentsPerMonthBefore - r.IncidentsPerMonthAfter) *
		r.AvgIncidentEngineerHours

	return onboarding + deployment + incidents
}

func (r PlatformROI) MonthlyValueCents() int64 {
	return int64(r.MonthlyEngineerHoursSaved() * float64(r.AvgEngineerHourlyCostCents))
}

// Real-world example:
// 10 new services/month x 13.5 days saved x 8 hrs/day = 1,080 hrs onboarding
// 200 deploys/month x 4.5 days saved x 8 hrs/day    = 7,200 hrs lead time
// 7 incidents prevented x 4 hrs each                =    28 hrs incidents
// Total: 8,308 hrs x $150/hr = $1.25M/month measured value
```

### Junior → FAANG: Using the ROI Model to Talk About Platform Value

The `PlatformROI` struct is one of the most practically useful artifacts in this chapter for interview purposes. Being able to describe platform value in financial terms, not just technical terms, is a skill that distinguishes engineers who can influence organizational decisions from those who can only execute them.

For a junior engineer in an interview, the ROI framing answers the question "why does platform engineering matter to a business?" The answer is not "because it is technically elegant" or "because it reduces toil." The answer is: our platform reduced service onboarding from two weeks to four hours. At ten new services per month and a loaded engineer cost of $150 per hour, that is over $1.5M per year in recovered engineering capacity. That is the kind of answer that earns headcount for the platform team.

The Team Topologies model in this section clarifies why the gatekeeper anti-pattern is so damaging. If a developer needs a database and must wait two weeks for a manual provisioning ticket, the platform team is not providing a service. It is providing a slower, more formal version of what the developer could do themselves with direct cloud console access. The self-service model (apply YAML, get a database in ten minutes) eliminates the wait while preserving governance through automated policy checks.

For interview prep: be ready to explain the four team types in two sentences each, and know which type the platform team is (platform team, X-as-a-Service model) and which type the teams it serves are (stream-aligned, focused on end-user features).

### Senior @ FAANG: ROI Measurement as an Organizational Capability

The `PlatformROI` calculation in this section is a useful template, but senior engineers should recognize its limitations and know how to address them in a board-level or VP-level conversation about platform investment.

The model assumes that time saved equals value created. This is true only if the saved time is redirected to productive work. If onboarding a new service drops from two weeks to four hours but the developer spends the remaining time in unnecessary meetings, the platform has not generated $1.5M in value. It has generated an eighteen-hour gap in a meeting-heavy calendar. A mature ROI argument includes evidence that the saved time was redirected to product work, typically measured by deployment frequency improvement (DORA) or feature throughput improvement.

The model also uses fully loaded engineer cost as the value unit, which is appropriate for engineering leadership audiences but may be challenged by finance teams who will point out that the engineers are already hired and their cost is fixed. The stronger financial argument for a fixed-cost engineering organization is opportunity cost: with the platform, each engineer can work on more valuable features per quarter, increasing the return on each engineer's salary rather than reducing headcount.

At the staff level, building the measurement capability is itself a platform investment. To compute the `PlatformROI` struct accurately, you need reliable data on service onboarding duration (from scaffolding event timestamp to first production deployment), deployment lead time (from commit to production sync), and incident count with attribution. Instrumenting these data sources is engineering work, and it should be part of the platform roadmap from the beginning, not a reporting afterthought. Organizations that invest in measurement infrastructure from the start can justify continued platform investment with data. Those that skip it must rely on anecdotes, which are much weaker in budget conversations.
