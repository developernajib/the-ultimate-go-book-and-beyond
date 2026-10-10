## Hands-On Prometheus and Grafana Implementation Pipeline

This end-to-end practical guide walks through implementing a production-grade metrics monitoring pipeline from service level objectives down to scrape configurations, alerts, and dashboards.

---

### Phase 1: DEFINE SLIS AND SLOS 5 MINUTES

"First, I'd work with the team to define our Service Level
Indicators and Objectives:
- Availability: 99.9% (measured by error rate)
- Latency: P99 < 500ms
- Throughput: handle 1000 req/s at peak

These SLOs drive what we measure."

### Junior → FAANG: SLI and SLO Definition as the Foundation of Observability

SLIs and SLOs are not metrics configuration: they are engineering contracts with users. An SLI is the measurement. An SLO is the target. "Availability: 99.9%" only becomes an SLO when you also specify how it is measured (which requests count, what counts as an error, what time window is used).

For a first job, practice writing SLIs in the form: "The proportion of [qualifying requests] that are [considered successful] measured over [time window]." This structure forces you to make the measurement explicit before you write a single line of PromQL.

Interview entry point: the 99.9% availability SLO allows 43.8 minutes of downtime per month. Know this number. Interviewers use it to test whether you understand the operational implications of SLO target selection.

### Senior @ FAANG: SLO Governance, Error Budget Policy, and Stakeholder Alignment

SLO setting is a negotiation between engineering, product, and business stakeholders. A 99.99% SLO on a payment service sounds responsible but allows only 4.4 minutes of downtime per month, which may require engineering investment (multi-region active-active, zero-downtime deployments) that costs more than the customer impact it prevents. An L6 engineer quantifies this trade-off: "Achieving 99.99% requires $X in infrastructure and Y weeks of engineering. The expected revenue protected by moving from 99.9% to 99.99% is $Z. The investment is [justified / not justified] because [reasoning]."

Error budget policy transforms an SLO from a measurement into an operational feedback loop. A written error budget policy specifies what happens when the budget is exhausted: freeze feature work, focus engineering on reliability, require post-mortems for all incidents. Without a written policy, an exhausted error budget is just a number on a dashboard. With a policy, it triggers a specific organizational response. Defining and getting leadership sign-off on this policy is an L6-level responsibility.


---

### Phase 2: INSTRUMENT THE CODE 10 MINUTES

"I'd add Prometheus instrumentation using the official Go client:

```go
// Four golden signals + business metrics
var (
    // Latency
    requestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Buckets: []float64{0.1, 0.25, 0.5, 0.75, 1.0, 2.5},
        },
        []string{"method", "endpoint", "status"},
    )
    // Traffic
    requestTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
        },
        []string{"method", "endpoint", "status"},
    )
    // Errors
    errorTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_errors_total",
        },
        []string{"method", "endpoint"},
    )
    // Saturation
    inFlightRequests = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "http_in_flight_requests",
        },
    )
)
```

Key considerations:
- Use histogram with buckets at SLO boundaries (500ms = 0.5)
- Keep label cardinality low (method, endpoint, status_class)
- Expose standard Go metrics (goroutines, memory, GC)"

### Junior → FAANG: Instrument the Four Golden Signals First

The four golden signals (latency, traffic, errors, saturation) cover the most common incident root causes. Instrument them before any business-specific metric. A service with the four golden signals instrumented can diagnose most production issues. A service with 50 business metrics but no latency histogram cannot.

The bucket boundaries in the code above (0.1, 0.25, 0.5, 0.75, 1.0, 2.5) are chosen to place a boundary at the SLO threshold (0.5 = 500ms P99 SLO). This ensures `histogram_quantile()` gives the most accurate estimate exactly at the threshold that matters.

### Senior @ FAANG: Instrumentation as a Shared Library Concern

At scale, instrumentation code is not written by each team independently. The platform team provides a `go-metrics` library that pre-registers the four golden signals with correct bucket boundaries and label sets, and exposes them via a single `metrics.NewHTTPMiddleware()` call. Individual teams call this middleware in their router setup and get production-grade instrumentation for free.

The benefit is consistency: every service's latency histogram uses the same bucket boundaries, enabling cross-service percentile comparisons in Grafana. The platform team can update bucket boundaries or add new standard metrics by releasing a new library version, without requiring individual teams to change their code.


---

### Phase 3: CONFIGURE PROMETHEUS SCRAPING

"Add scrape configuration and service discovery. In Kubernetes,
I'd use ServiceMonitor for automatic discovery."

### Junior → FAANG: ServiceMonitor and the Prometheus Operator

In Kubernetes, static scrape configs in `prometheus.yml` do not scale: every new service requires a manual config change. The Prometheus Operator introduces `ServiceMonitor` and `PodMonitor` custom resources that configure scraping declaratively. A service that exposes a `/metrics` endpoint on port 8080 creates a `ServiceMonitor` in its namespace, and the Operator automatically reconfigures Prometheus without requiring a Prometheus restart.

First-job habit: always annotate your Kubernetes `Service` with `prometheus.io/scrape: "true"` and `prometheus.io/port: "8080"` as a fallback for environments that use annotation-based discovery, and create a `ServiceMonitor` for environments using the Prometheus Operator.

### Senior @ FAANG: Scrape Configuration Governance and Cardinality from Discovery

`ServiceMonitor` resources created without review can introduce unbounded label cardinality from Kubernetes labels (pod name, node name, IP address) that are automatically added as metric labels via `relabelings`. An L6 engineer defines a standard `relabeling` configuration in the platform's `ServiceMonitor` template that keeps only approved Kubernetes labels (`namespace`, `service`, `cluster`) and drops all others. This template is enforced by a validating webhook that rejects `ServiceMonitor` resources that deviate from the standard relabeling configuration.


---

### Phase 4: CREATE ALERTING RULES

"Alert on SLO breach using multi-window burn rates from Google's
SRE workbook. This prevents noisy alerts while catching real issues."

### Junior → FAANG: Alert on Symptoms, Not Causes

The most common alerting mistake is alerting on infrastructure causes (CPU > 80%) rather than user-facing symptoms (error rate > 1%). A CPU spike that does not affect request latency or error rate is not worth waking an engineer at 3am. An error rate that exceeds the SLO threshold always is, regardless of whether CPU is involved.

Multi-window burn rate alerting (from the Google SRE workbook) provides the right balance: fast detection of severe outages and slow detection of gradual degradation, both tied directly to SLO impact rather than infrastructure thresholds.

### Senior @ FAANG: Alert Rule Review Process and Runbook Completeness

An alert rule without a runbook is an incomplete alert. The runbook must answer: what does this alert mean, what are the most common causes, what are the diagnostic steps, and what are the escalation paths. An L6 engineer establishes an alert rule review checklist: correct `for` clause, meaningful `summary` annotation, runbook URL in `description`, owner label set, and a `promtool test rules` test that covers at least one firing and one non-firing scenario. Alerts that fail this checklist are not merged.


---

### Phase 5: BUILD GRAFANA DASHBOARDS

"Create dashboards with:
- Overview page: request rate, error rate, latency, saturation
- Detailed page: per-endpoint breakdown, resource usage
- On-call page: simplified view for incidents"

### Junior → FAANG: The Three-Dashboard Minimum

Three dashboards cover the three distinct audiences: the overview dashboard is for anyone checking service health at a glance, the detailed dashboard is for an engineer investigating a specific problem, and the on-call dashboard is for the person responding to an alert at 3am who needs to know "is it still happening, and is it getting better or worse" without cognitive overhead.

The on-call dashboard is the most important. It should have fewer than 10 panels, no logarithmic scales (which hide the shape of a spike), and prominent error rate and latency panels with SLO threshold lines drawn on them. If the on-call engineer cannot answer "is this better or worse than 5 minutes ago" within 30 seconds of opening the dashboard, it needs to be simplified.

### Senior @ FAANG: Dashboard Hierarchy as an Organizational Asset

At scale, dashboards are organizational assets that outlive the engineers who created them. An L6 engineer treats dashboard design with the same rigor as API design: clear ownership, version history in git, review process for changes, and documentation of the operational decisions each panel supports. A dashboard with no documentation of why each panel exists will be misinterpreted during an incident by an engineer who was not involved in building it.


---

### Phase 6: RECORDING RULES

"Pre-compute expensive queries like percentiles to improve
dashboard performance."

### Junior → FAANG: Recording Rules as a Performance Optimization

A `histogram_quantile(0.99, rate(http_duration_bucket[5m]))` query that scans 50,000 series on every dashboard panel refresh makes Grafana slow and Prometheus expensive. A recording rule pre-computes this query every 30 seconds and stores the result as a new single-series metric. Dashboard panels then query the pre-computed series instead of running the full aggregation on every load.

As a rule of thumb: any PromQL expression used in an alert rule or a dashboard that takes more than 100ms to execute should be a recording rule. The recording rule's result is also faster to alert on because it is a simple threshold comparison on a single series.

### Senior @ FAANG: Recording Rule Naming Conventions and Dependency Management

Recording rules create new metrics with names that must follow the same governance standards as application metrics. A recording rule that produces `job:http_request_duration_seconds:p99` must be documented, have an owner, and have its retention policy defined. When the underlying metric is renamed or the rule is changed, all dashboards and alerts that depend on the recording rule must be updated simultaneously. An L6 engineer maintains a dependency graph of recording rules, and changes to rules require an impact assessment of all downstream consumers before merging.

---

### Question 2: "What are the Prometheus metric types and when would you use each?"

**Strong Answer Framework:** the four sections that follow, Counter, Gauge, Histogram, and Summary, are the answer structure. Cover what each type is, what to use it for, how to query it, and its anti-pattern.
