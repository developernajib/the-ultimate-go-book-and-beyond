## 102F.6 Developer Experience Metrics - SPACE Framework

The SPACE framework (published by GitHub and Microsoft Research in 2021) provides a multi-dimensional model for measuring developer productivity that avoids the trap of using a single proxy metric like lines of code or PR count. It recognizes that developer experience is shaped by five factors: satisfaction, performance, activity, communication, and efficiency. Platform teams use SPACE to design developer surveys, choose leading indicators for their infrastructure investments, and communicate impact to engineering leadership in terms that go beyond raw throughput numbers.

```
SPACE framework (GitHub, Microsoft Research, 2021):
S - Satisfaction and well-being
P - Performance (outcomes, not output)
A - Activity (volume of actions - use carefully)
C - Communication and collaboration
E - Efficiency and flow

Platform KPIs:
- Time to onboard new service: target < 30 minutes
- Time from code commit to production: target < 1 hour
- Self-service adoption rate: % of infra provisioned via platform vs manually
- Developer NPS: quarterly survey on platform satisfaction
- Toil reduction: hours/week saved by automation
- Incident rate caused by platform: track platform-caused incidents separately
```

### Platform Metrics in Go

Translating SPACE KPIs into Prometheus instruments requires choosing the right metric type for each measurement: histograms for latency distributions (environment provisioning duration, deployment frequency), counters for cumulative events (service onboarding totals), and gauges for ratios that can increase or decrease (self-service adoption rate). Labeling metrics with dimensions like `type`, `status`, and `language` lets engineering leadership slice data by team or resource category without instrumenting separate metrics. The `promauto` package registers instruments at init time, eliminating boilerplate registration calls and reducing the risk of missing metrics in unit tests.

```go
package metrics

import (
    "time"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    environmentProvisionDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "platform_environment_provision_duration_seconds",
            Help:    "Time to provision a new environment",
            Buckets: []float64{10, 30, 60, 120, 300},
        },
        []string{"type", "status"},
    )

    serviceOnboardingTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "platform_service_onboarding_total",
            Help: "Total service onboarding requests",
        },
        []string{"language", "status"},
    )

    selfServiceAdoptionRate = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "platform_self_service_adoption_rate",
            Help: "Percentage of resources provisioned via self-service vs manually",
        },
        []string{"resource_type"},
    )

    deploymentFrequency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "platform_deployment_frequency_seconds",
            Help:    "Time between deployments per service",
            Buckets: prometheus.ExponentialBuckets(300, 2, 10), // 5min to 85 hours
        },
        []string{"service", "environment"},
    )
)

func RecordEnvironmentProvisioned(envType string, duration time.Duration, err error) {
    status := "success"
    if err != nil {
        status = "failure"
    }
    environmentProvisionDuration.WithLabelValues(envType, status).Observe(duration.Seconds())
}
```

### Junior → FAANG: Understanding SPACE Well Enough to Defend It in an Interview

SPACE is frequently asked about in platform engineering interviews but just as frequently misunderstood. The key mistake junior engineers make is treating SPACE as a single score or a replacement for DORA. It is neither.

SPACE is a multi-dimensional framework. You do not compute a single SPACE number. You track metrics across five categories and look for imbalances. A team with high Activity (many commits, many PRs) but low Satisfaction (low eNPS scores) and low Efficiency (long CI times, slow deployments) is a team that is working hard but suffering. The Activity metric alone would make them look productive. SPACE reveals the full picture.

For interview preparation: know one concrete metric for each SPACE dimension and how you would measure it.

Satisfaction: quarterly developer NPS survey, scale of minus 100 to plus 100. Performance: PR review cycle time, calculated from GitHub pull request opened to merged timestamps. Activity: deployments per engineer per week, derived from CI/CD system metrics. Communication: cross-team API reuse percentage, measured from Backstage catalog dependency graph. Efficiency: time from git push to production deployment, measured end-to-end from CI trigger to ArgoCD sync completion.

The Prometheus code in this section shows how Efficiency metrics translate directly into instrumentation. The `environmentProvisionDuration` histogram measures how long provisioning takes, which is a platform Efficiency metric. The labels `type` and `status` let the team slice by environment type and filter for failures. This is the kind of instrumentation detail that impresses interviewers who are used to candidates describing metrics abstractly without connecting them to implementation.

### Senior @ FAANG: Using SPACE to Drive Platform Investment Decisions

At the staff and principal level, SPACE is most valuable as a tool for prioritizing platform investments and communicating those priorities to engineering leadership in terms that resonate with non-technical stakeholders.

The critical skill is triangulating across SPACE dimensions to identify root causes rather than symptoms. A drop in Efficiency (increasing CI duration) might be caused by a Satisfaction problem (developers are writing more tests, which is actually good), a Communication problem (dependencies between teams are increasing build complexity), or an Activity problem (a recent golden path change added a slow lint step). Each root cause has a different fix. Treating the symptom (optimizing CI) without understanding the cause will produce a metric improvement that does not address the underlying problem.

The histogram bucket configuration in the code is a senior-level detail. The `Buckets: []float64{10, 30, 60, 120, 300}` are chosen to bracket the expected distribution of provisioning times. If the platform's SLO is that 95% of environments provision in under 60 seconds, the buckets must include 60 as a boundary so that the p95 can be accurately computed. Choosing buckets that are too coarse (e.g., only 60 and 300) means the histogram cannot distinguish a p50 of 30 seconds from a p50 of 59 seconds. A senior engineer reviewing a monitoring PR should immediately check whether the histogram buckets match the SLO boundaries.

At the governance level, SPACE metrics should be published quarterly alongside DORA metrics as part of the platform team's public accountability report. The combination shows both what the platform delivers (DORA: deployment frequency, lead time) and how it affects the people who use it (SPACE: satisfaction, flow efficiency). Engineering leadership can fund platform investments when they see both dimensions, rather than treating developer experience as a soft concern that is harder to justify than infrastructure cost savings.
