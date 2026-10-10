## FAANG Interview Q&A: Engineering Metrics

These questions surface whether you can measure engineering effectiveness without falling into Goodhart's law and whether you treat metrics as instruments, not targets.

### 1. Tell me about a metric you introduced that changed team behavior.

Strong answers identify the specific metric, the baseline, the target, the behavior change, and the second-order effect you did not initially predict. Weak answers describe metrics that were displayed on a dashboard without producing a decision. Include how you retired or evolved the metric once its work was done.

### 2. Describe a metric that looked good but masked a real problem.

Goodhart's law shows up constantly: PR throughput that hides PR size inflation, deploy frequency that hides hotfix churn, test coverage that hides assertion-free tests. Identify the metric, the problem it masked, how you discovered the gap, and the compensating metric you introduced.

### 3. How do you measure developer productivity without punishing senior engineers?

A calibrated answer rejects the premise that individual developer productivity is directly measurable and instead focuses on team-level flow metrics: deployment frequency, lead time for changes, change failure rate, and MTTR (the DORA four). Discuss how you would handle the senior engineer whose output is mentorship and architecture rather than merged PRs.

### 4. Design the engineering-metrics dashboard for a 50-engineer Go services organization.

Cover the four DORA metrics, flow metrics (cycle time, WIP, throughput), quality metrics (escaped defect rate, test reliability), and developer experience metrics (build time, PR review turnaround, flaky-test rate). Discuss the cadence (weekly team-level, monthly org-level), the review ritual (who looks at the dashboard and when), and the anti-patterns to avoid (ranking teams by the metrics, tying metrics to compensation).

### 5. How would you implement DORA metric collection for a Go monorepo with 40 services deployed through GitHub Actions?

A technical answer covers: deployment frequency from GitHub deployments API, lead time for changes from PR merge-to-deploy timestamps, change failure rate from incident-linked deployments, and MTTR from incident resolution timestamps. Discuss the data model (a `DORAMetrics` aggregation struct per service per week), the storage backend (BigQuery or ClickHouse for analytical queries), and the performance-band classification thresholds (elite, high, medium, low) the 2025 DORA report publishes.
