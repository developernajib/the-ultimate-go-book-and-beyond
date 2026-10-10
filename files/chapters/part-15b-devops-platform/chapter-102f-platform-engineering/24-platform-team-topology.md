## 102F.22 Platform Team Topology

### Platform as a Product

The platform team is not an infrastructure team that reacts to tickets. It is a product team with internal customers (developers), a roadmap, OKRs, and SLAs. This shift in mindset is the single most important factor in platform engineering success.

```
Platform Team Product Model
===========================

External Product Teams           Platform Team
+----------------------+        +------------------------------------+
|  payments-team       |        |  Product Management                |
|  identity-team       |------> |    Internal roadmap                |
|  search-team         |        |    Quarterly planning with teams   |
|  data-team           |<------ |    Usage / adoption metrics        |
+----------------------+        |                                    |
          ^                     |  Engineering                       |
          |  consumes            |    CLI, Backstage plugins          |
          |                     |    CI/CD reusable workflows        |
          |                     |    Kubernetes operators            |
          +---------------------|  Developer Relations               |
                                |    Office hours (weekly)           |
                                |    Slack #platform-support         |
                                |    Migration guides & TechDocs     |
                                +------------------------------------+
```

### XaaS Model: Everything as a Service

Formalise each platform capability as a named service with an owner, SLA, documentation link, and a Slack channel:

```go
// internal/platform/catalog.go
package platform

import "time"

// ServiceTier represents the support tier for a platform XaaS offering.
type ServiceTier string

const (
	TierFoundational ServiceTier = "foundational" // 99.9% SLA, 24/7 on-call
	TierManaged      ServiceTier = "managed"       // 99.5% SLA, business hours
	TierExperimental ServiceTier = "experimental"  // best-effort, no SLA
)

// PlatformService describes one XaaS offering.
type PlatformService struct {
	Name           string
	Description    string
	Tier           ServiceTier
	SLAUptime      float64       // percentage, e.g. 99.9
	ResponseTime   time.Duration // incident response target
	Documentation  string
	Slack          string
	CurrentVersion string
}

// InternalCatalog is the authoritative list of all platform services.
var InternalCatalog = []PlatformService{
	{
		Name:           "CI/CD Pipeline (GitHub Actions)",
		Description:    "Reusable GitHub Actions workflows: build, test, security scan, deploy",
		Tier:           TierFoundational,
		SLAUptime:      99.9,
		ResponseTime:   30 * time.Minute,
		Documentation:  "https://backstage.internal/docs/default/component/ci-cd-platform",
		Slack:          "#platform-cicd",
		CurrentVersion: "v3.2.1",
	},
	{
		Name:           "Kubernetes Namespaces (NamespaceaaS)",
		Description:    "Self-service namespace provisioning with quotas, RBAC, and network policies",
		Tier:           TierFoundational,
		SLAUptime:      99.9,
		ResponseTime:   30 * time.Minute,
		Documentation:  "https://backstage.internal/docs/default/component/namespace-service",
		Slack:          "#platform-k8s",
		CurrentVersion: "v2.0.0",
	},
	{
		Name:           "Secrets Management (Vault)",
		Description:    "HashiCorp Vault with Kubernetes auth, dynamic secrets, and auto-rotation",
		Tier:           TierFoundational,
		SLAUptime:      99.9,
		ResponseTime:   15 * time.Minute,
		Documentation:  "https://backstage.internal/docs/default/component/secrets-platform",
		Slack:          "#platform-secrets",
		CurrentVersion: "v1.5.0",
	},
	{
		Name:           "Observability Stack",
		Description:    "Prometheus, Grafana, Loki, Tempo - pre-wired dashboards for all golden-path services",
		Tier:           TierManaged,
		SLAUptime:      99.5,
		ResponseTime:   2 * time.Hour,
		Documentation:  "https://backstage.internal/docs/default/component/observability",
		Slack:          "#platform-observability",
		CurrentVersion: "v4.1.0",
	},
	{
		Name:           "Feature Flags (Flagsmith)",
		Description:    "Feature flag service with Go SDK, gradual rollouts, and A/B testing",
		Tier:           TierManaged,
		SLAUptime:      99.5,
		ResponseTime:   2 * time.Hour,
		Documentation:  "https://backstage.internal/docs/default/component/feature-flags",
		Slack:          "#platform-flags",
		CurrentVersion: "v1.0.2",
	},
	{
		Name:           "Service Mesh (Cilium)",
		Description:    "eBPF-based network policy, mTLS, and Hubble observability",
		Tier:           TierExperimental,
		SLAUptime:      0,
		ResponseTime:   0,
		Documentation:  "https://backstage.internal/docs/default/component/service-mesh",
		Slack:          "#platform-mesh-beta",
		CurrentVersion: "v0.3.0",
	},
}
```

### Internal SLA Management

Platform SLA management involves two distinct calculations: point-in-time uptime (queried from Prometheus `probe_success` data produced by the blackbox exporter) and burn rate (how quickly the error budget is being consumed relative to the allowed pace). A burn rate above 14.4× over a one-hour window is the canonical Google SRE alert threshold. At that pace the entire 30-day error budget would be exhausted in two hours, warranting immediate incident response. Expressing SLA targets as error budgets rather than raw uptime percentages reframes reliability as a shared engineering constraint: teams can choose to spend budget on risky deploys, but the platform team gets objective data to prioritize reliability work when the budget runs low.

```go
// internal/sla/tracker.go
package sla

import (
	"context"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

// Report holds the SLA compliance report for a service over a window.
type Report struct {
	Service      string
	Period       time.Duration
	TargetUptime float64
	ActualUptime float64
	IsCompliant  bool
	ErrorBudget  ErrorBudget
	Incidents    []Incident
}

// ErrorBudget tracks how much error budget remains in the current window.
type ErrorBudget struct {
	TotalMinutes     float64
	ConsumedMinutes  float64
	RemainingMinutes float64
	BurnRate         float64 // 1.0 == on pace; >1.0 == burning too fast
}

// Incident represents a platform outage or degradation event.
type Incident struct {
	StartTime     time.Time
	EndTime       time.Time
	Duration      time.Duration
	Severity      string
	AffectedTeams []string
	PostmortemURL string
}

// Tracker computes SLA compliance from Prometheus blackbox exporter data.
type Tracker struct {
	promAPI v1.API
}

// NewTracker creates an SLA tracker backed by the given Prometheus address.
func NewTracker(prometheusAddr string) (*Tracker, error) {
	client, err := api.NewClient(api.Config{Address: prometheusAddr})
	if err != nil {
		return nil, err
	}
	return &Tracker{promAPI: v1.NewAPI(client)}, nil
}

// ComputeReport calculates the SLA report for a platform service.
func (t *Tracker) ComputeReport(ctx context.Context, service string, target float64, period time.Duration) (*Report, error) {
	end := time.Now()
	query := fmt.Sprintf(
		`avg_over_time(probe_success{job="blackbox",target="%s"}[%s])`,
		service, fmt.Sprintf("%dh", int(period.Hours())),
	)

	result, _, err := t.promAPI.Query(ctx, query, end)
	if err != nil {
		return nil, fmt.Errorf("prometheus query: %w", err)
	}

	var actualUptime float64
	if vec, ok := result.(model.Vector); ok && len(vec) > 0 {
		actualUptime = float64(vec[0].Value) * 100
	}

	totalMinutes := period.Minutes()
	targetDowntime := totalMinutes * (1 - target/100)
	actualDowntime := totalMinutes * (1 - actualUptime/100)

	var burnRate float64
	if targetDowntime > 0 {
		burnRate = actualDowntime / targetDowntime
	}

	return &Report{
		Service:      service,
		Period:       period,
		TargetUptime: target,
		ActualUptime: actualUptime,
		IsCompliant:  actualUptime >= target,
		ErrorBudget: ErrorBudget{
			TotalMinutes:     targetDowntime,
			ConsumedMinutes:  actualDowntime,
			RemainingMinutes: targetDowntime - actualDowntime,
			BurnRate:         burnRate,
		},
	}, nil
}

// BurnRateAlert returns true when the 1-hour burn rate exceeds the critical
// threshold of 14.4x - meaning the entire monthly error budget will be
// exhausted in approximately 2 hours.
func (t *Tracker) BurnRateAlert(ctx context.Context, service string, target float64) (bool, float64, error) {
	hourReport, err := t.ComputeReport(ctx, service, target, 1*time.Hour)
	if err != nil {
		return false, 0, err
	}
	monthReport, err := t.ComputeReport(ctx, service, target, 30*24*time.Hour)
	if err != nil {
		return false, 0, err
	}
	if monthReport.ErrorBudget.BurnRate == 0 {
		return false, 0, nil
	}
	relBurnRate := hourReport.ErrorBudget.BurnRate / monthReport.ErrorBudget.BurnRate
	return relBurnRate > 14.4, relBurnRate, nil
}
```

### Platform Roadmap Management

The platform roadmap is driven by developer pain surveys, usage telemetry, and OKR alignment. A quarterly planning cycle works well:

```
Quarter Planning Cycle
======================

Week 1:  Developer pain survey (15 questions, 10 minutes max)
         Usage telemetry review: adoption rates and support ticket themes
         Platform team retrospective on previous quarter OKRs

Week 2:  Roadmap draft: 3 themes, 6-8 epics
         Stakeholder review with engineering leadership
         Dependency identification (infra budget, vendor contracts)

Week 3:  Public roadmap published to Backstage TechDocs
         Open office hours: "Ask the platform team anything"
         Pilot team recruitment for new capabilities

Week 4:  Sprint planning: epics decomposed into 2-week sprint stories
         OKR alignment confirmed
         Quarterly kickoff posted to #engineering
```

### Platform KPIs

Track these eight KPIs quarterly and publish them publicly to the engineering org:

```go
// internal/kpis/platform.go
package kpis

// Trend indicates whether a KPI is improving, worsening, or flat.
type Trend string

const (
	TrendImproving Trend = "improving"
	TrendWorsening Trend = "worsening"
	TrendStable    Trend = "stable"
)

// KPI defines a single measurable platform team performance indicator.
type KPI struct {
	Name        string
	Description string
	Unit        string
	Target      float64
	Current     float64
	Trend       Trend
	Source      string
}

// PlatformKPIs returns the full standard set of platform team KPIs.
// Current values are populated at runtime from their respective data sources.
func PlatformKPIs() []KPI {
	return []KPI{
		{
			Name:        "Golden Path Adoption Rate",
			Description: "Percentage of production services on the current golden path version",
			Unit:        "%",
			Target:      90,
			Source:      "Backstage catalog: count(golden-path label) / count(total services)",
		},
		{
			Name:        "Time to Production (New Service)",
			Description: "Median elapsed time from `platform create service` to first production deploy",
			Unit:        "days",
			Target:      2,
			Source:      "GitHub repo creation timestamp vs. ArgoCD first production sync timestamp",
		},
		{
			Name:        "Developer Satisfaction (eNPS)",
			Description: "Engineering Net Promoter Score from quarterly platform-specific survey",
			Unit:        "score (-100 to +100)",
			Target:      40, // >= 40 is good; >= 70 is excellent
			Source:      "Quarterly developer survey",
		},
		{
			Name:        "Platform-Caused Production Incidents",
			Description: "Count of production incidents attributed to platform per calendar month",
			Unit:        "incidents/month",
			Target:      2,
			Source:      "PagerDuty: incidents tagged platform-caused=true",
		},
		{
			Name:        "CI Pipeline P95 Duration",
			Description: "95th-percentile end-to-end CI duration across all golden-path services",
			Unit:        "minutes",
			Target:      8,
			Source:      "GitHub Actions API: workflow_run durations for golden-path pipelines",
		},
		{
			Name:        "Self-Service Rate",
			Description: "Percentage of platform requests resolved automatically without manual intervention",
			Unit:        "%",
			Target:      85,
			Source:      "Jira/Linear: auto-resolved vs. manually-triaged tickets",
		},
		{
			Name:        "Onboarding Time to First Merged PR",
			Description: "Median calendar days from new engineer start date to their first merged PR",
			Unit:        "days",
			Target:      3,
			Source:      "HRIS hire date vs. GitHub first merged PR date",
		},
		{
			Name:        "Security Vulnerability Resolution Time",
			Description: "Median hours from Trivy HIGH/CRITICAL CVE detection to fix in production",
			Unit:        "hours",
			Target:      24,
			Source:      "Trivy scan timestamp vs. ArgoCD production deployment timestamp",
		},
	}
}
```

### Avoiding Shadow IT

Shadow IT emerges when the platform team is too slow, too opinionated, or too difficult to engage with. Telltale signs:

- Teams managing their own Terraform state outside the platform module
- Hand-rolled CI/CD pipelines that duplicate golden-path functionality
- Unregistered services in production (detectable via namespace drift reports)
- Engineers deploying directly via AWS Console instead of through the platform

```go
// internal/compliance/shadow_it.go
package compliance

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// ShadowITReport summarizes namespaces and services outside platform governance.
type ShadowITReport struct {
	UnmanagedNamespaces  []string
	UnregisteredServices []string
	TotalNamespaces      int
	ManagedNamespaces    int
}

// UnmanagedPct returns the percentage of namespaces not platform-managed.
func (r *ShadowITReport) UnmanagedPct() float64 {
	if r.TotalNamespaces == 0 {
		return 0
	}
	return float64(len(r.UnmanagedNamespaces)) / float64(r.TotalNamespaces) * 100
}

// BackstageClient is a minimal interface for catalog entity existence checks.
type BackstageClient interface {
	EntityExists(ctx context.Context, kind, namespace, name string) (bool, error)
}

// Detector finds workloads running outside platform governance.
type Detector struct {
	k8sClient       client.Client
	backstageClient BackstageClient
}

// NewDetector creates a Detector with the supplied clients.
func NewDetector(k8sClient client.Client, backstageClient BackstageClient) *Detector {
	return &Detector{k8sClient: k8sClient, backstageClient: backstageClient}
}

// Scan inspects all non-system namespaces for governance compliance.
func (d *Detector) Scan(ctx context.Context) (*ShadowITReport, error) {
	report := &ShadowITReport{}

	var nsList corev1.NamespaceList
	if err := d.k8sClient.List(ctx, &nsList); err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}

	systemNamespaces := map[string]bool{
		"kube-system": true, "kube-public": true, "kube-node-lease": true,
		"argocd": true, "monitoring": true, "cert-manager": true,
		"platform-system": true, "ingress-nginx": true,
	}

	for _, ns := range nsList.Items {
		if systemNamespaces[ns.Name] {
			continue
		}
		report.TotalNamespaces++

		if _, managed := ns.Labels["platform.acme.io/managed"]; !managed {
			report.UnmanagedNamespaces = append(report.UnmanagedNamespaces, ns.Name)
			continue
		}
		report.ManagedNamespaces++

		exists, err := d.backstageClient.EntityExists(ctx, "Component", "default", ns.Name)
		if err != nil {
			continue
		}
		if !exists {
			report.UnregisteredServices = append(report.UnregisteredServices, ns.Name)
		}
	}

	return report, nil
}
```

When shadow IT is detected the response must be empathetic, not punitive. The right question is not "why did you break the rules?" but "what was missing from the platform that caused you to build your own solution?"

### Junior → FAANG: Using These Structures as Interview Blueprints

The code artifacts in this section (XaaS catalog, SLA tracker, KPI definitions, shadow IT detector) are the kind of internal platform tooling that most developers have never seen, because they are rarely open-sourced. Knowing these patterns exist and being able to describe them in an interview demonstrates exposure to platform engineering maturity that goes beyond what most junior candidates have.

The `InternalCatalog` slice with `PlatformService` structs is a code-as-configuration pattern. Rather than storing the XaaS catalog in a database or a YAML file, the platform team defines it in Go code. This means changes to the catalog go through code review, are versioned with the binary, and are always in sync with the service's deployment. The `ServiceTier` enum (foundational, managed, experimental) is a governance classification that sets expectations for SLA and support level before a team takes a dependency on a platform service.

The `ShadowITReport.UnmanagedPct()` method and the color-coded Slack alerting in Exercise 9 show a complete feedback loop: detect, measure, report, act. This is the kind of operational discipline that separates an ad-hoc platform from a mature one. A junior engineer who can implement this loop (detect unmanaged namespaces, compute percentage, send color-coded Slack message) demonstrates both Go competency and platform thinking.

The KPI list in `PlatformKPIs()` is a starting point for any platform team's measurement strategy. For interview preparation, memorize the eight KPIs and know how each one would be measured. "Golden Path Adoption Rate: count services with the `golden-path` label in Backstage catalog divided by total service count." "CI Pipeline P95 Duration: 95th percentile of workflow run duration from GitHub Actions API." These are precise, measurable definitions, not aspirational goals.

### Senior @ FAANG: Platform Maturity Models and Where Organizations Get Stuck

The SLA tracker, KPI framework, and shadow IT detector in this section collectively define what a mature platform organization looks like. Understanding where organizations typically plateau in their platform maturity journey is a staff-level capability.

Stage one maturity: the platform has a Backstage catalog and a golden path template for the primary language. Teams use it for new services. Existing services are not migrated. Shadow IT exists but is not measured. KPIs are tracked manually in a spreadsheet.

Stage two maturity: all new services use the golden path. Backstage catalog accuracy is above 80%. CI/CD standardization is above 90%. Platform SLOs are defined and published. KPIs are automated via the kind of `PlatformKPIs()` structure shown here. Shadow IT is detected weekly.

Stage three maturity: existing services have been migrated to the current golden path version via automated tooling. Backstage catalog accuracy is above 95% via automated validation. The platform team has a documented product roadmap driven by quarterly developer surveys. DORA metrics are computed automatically for every service and surfaced in Backstage. Platform incidents are tracked against an error budget with the same rigor as customer-facing services.

Most organizations plateau at stage one because the transition to stage two requires organizational change management (migrating existing services) and governance investment (SLOs, KPI automation, shadow IT detection) in addition to technical work. A staff engineer joining an organization at stage one should identify which stage two capabilities have the most effective (usually catalog accuracy and SLO definition) and make those the first-quarter priorities.

The burn rate alert in `BurnRateAlert` (14.4x threshold) is the canonical Google SRE alert threshold, derived from the observation that a 14.4x burn rate over one hour means the entire monthly error budget will be consumed in two hours. This threshold should be applied to the platform's own services with the same rigor that the platform team expects product services to apply it. A platform team that pages for product service SLO violations but has no alerting for its own CI/CD pipeline availability has not internalized the "platform as a product" mindset at the operational level.
