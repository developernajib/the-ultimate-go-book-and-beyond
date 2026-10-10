# Chapter 105D: Alerting & Metrics Engineering

> *"Every page should be urgent, important, actionable, and real. Four properties. Miss one and you have a problem."* (Google SRE Book)

Alert fatigue is one of the most insidious threats to operational reliability. When an on-call engineer receives dozens of pages per shift, the majority of which are either informational, non-actionable, or duplicates of each other, two things happen: the engineer habituates to alerts and starts ignoring them, and the alerts that actually matter get buried in noise. Studies of on-call culture consistently find that teams with high false-positive alert rates suffer worse incident outcomes than teams that page less frequently but more accurately. Fixing this requires not just tuning thresholds but rethinking the entire philosophy of alerting: grounding every rule in user-observable symptoms rather than internal system metrics.

The Google SRE book's multi-window, multi-burn-rate alerting approach represents the industry standard for SLO-based alerting. Instead of alerting on raw error rates crossing a static threshold, you alert when the error budget is burning faster than sustainable, detecting both fast burns that threaten the budget within hours and slow burns that would exhaust it within days if unchecked. Prometheus recording rules pre-aggregate the expensive range queries needed for burn-rate calculations, keeping alerting responsive even at large scale. Alertmanager's routing tree, with inhibition rules that suppress child alerts during parent incidents, dramatically reduces notification volume during complex multi-service outages.

Metrics engineering, the discipline of designing, naming, labeling, and maintaining the metric schema of a production system, is the often-overlooked prerequisite to good alerting. Metrics designed without forethought accumulate inconsistent naming conventions, redundant series, and exploding cardinality that makes PromQL queries slow and Prometheus memory usage unmanageable. Anomaly detection pushes beyond static thresholds to identify unusual patterns in time-series data using statistical methods: z-score calculations, moving averages, and seasonality-aware bounds that adapt to predictable traffic patterns like daily and weekly cycles. This chapter builds the complete alerting engineering stack: metric design, recording rules, burn-rate alerts, Alertmanager routing, and anomaly detection in Go.

**What you'll learn in this chapter:**
- Metric schema design: naming conventions (`service_operation_unit_total`), label cardinality limits, and deprecation strategies
- Recording rules for pre-aggregation: turning expensive range queries into fast instant queries for dashboards and alerts
- Multi-window multi-burn-rate alerting: fast-burn (1h/5m) and slow-burn (6h/30m) page rules plus long-window (3d/6h) ticket rules
- Alertmanager routing tree design: receiver configuration, grouping, inhibition rules, and silence automation
- Dead man's switch patterns for monitoring critical batch jobs and scheduled tasks with Go heartbeat implementations
- Statistical anomaly detection in Go: z-score, IQR, exponential moving average, and Holt-Winters for seasonal data
- On-call rotation management: escalation policies, override handling, and integration with PagerDuty and OpsGenie
- Runbook automation: linking alerts to structured runbooks and implementing auto-remediation actions in Go

**Why this matters at scale:**
Etsy famously published its journey from alert hell to signal-driven alerting, dramatically reducing weekly pages while actually improving incident detection coverage. Robinhood, after a high-profile 2020 outage, overhauled their alerting to focus on customer-impacting symptoms rather than internal metrics, dramatically improving MTTD for user-facing degradations. Mature SRE organizations run a metrics engineering governance process that reviews all new metric additions for cardinality and naming compliance before they reach production Prometheus, preventing the technical debt that accumulates when metric schemas grow organically without oversight. For any team running production services, alerting quality is a direct multiplier on incident response effectiveness.

**Prerequisites:** Chapters 103--105C (OpenTelemetry, Prometheus & Grafana, SRE Practices, and Log Aggregation & APM), familiarity with PromQL range vectors and aggregation functions, and a local Alertmanager instance for testing routing configurations.

### Junior → FAANG: Alert Quality Is a Craft Skill

Writing alerts is not configuration management: it is a craft that requires understanding what behaviors need human intervention, what can be automated, and what can be safely ignored. Junior engineers often treat alerting as binary (either alert or don't) rather than as a calibration problem.

The calibration is: how sensitive should this alert be? Too sensitive (low threshold, no `for` clause) and it pages on noise. Too insensitive (high threshold, long `for` clause) and it misses real incidents until they are severe. The calibration depends on historical data: what is the baseline error rate, what is the normal variability, and what threshold ensures that when the alert fires, it correlates with real user impact?

For a first job, never add an alert without first looking at the historical data for the metric. A month of historical data usually shows you the normal variability and helps you set a threshold that would have fired on past incidents but not on routine fluctuations.

### Senior @ FAANG: Alerting Metrics Engineering as an Organizational Practice

The metrics engineering governance process described above is the senior-level model for alert quality. The process treats new metrics and alerts with the same rigor as new APIs: review for correctness, review for cardinality, review for naming compliance, and review for operational impact before they reach production. An L6 engineer designs and operates this review process, not just participates in it.

The key insight from journeys like Etsy's is that better alerting means fewer alerts, not more. An organization that measures alerting quality by alert count rather than incident detection rate is optimizing the wrong metric. An L6 engineer defines "alerting effectiveness" as the percentage of real incidents that triggered an alert, and uses this metric alongside alert volume to drive improvement.

---
