## 105D.7 Common Mistakes and How to Avoid Them

| Mistake | Problem | Solution |
|---------|---------|----------|
| Alerting on CPU/memory | Too noisy, causes alert fatigue | Alert on user-facing symptoms: error rate, latency |
| Using mean for latency alerts | Hides tail latency issues | Alert on p99 or p999, mean masks outliers |
| No alert deduplication | Same issue generates hundreds of alerts | Use AlertManager grouping, implement correlation engine |
| Missing error budget alerts | Don't know when SLO will be breached | Implement multi-window burn rate alerting |
| Static thresholds | Different times need different thresholds | Use anomaly detection or seasonal baselines |
| No runbook link in alerts | On-call engineers don't know what to do | Always include runbook_url annotation |
| Alert on every deploy | False positives during normal changes | Use silence/inhibition during deployments |
| High-cardinality metric labels | Prometheus OOM from too many series | Limit label cardinality, normalize paths and IDs |
| No dead man's switch | Batch job silently fails with no alert | Implement heartbeat alerting for all scheduled jobs |
| Missing alert documentation | Alert meaning unclear to new engineers | Document all alerts with description and severity |

### Junior → FAANG: Two Mistakes That Are Invisible Until They Matter

The "no dead man's switch" mistake is particularly dangerous because the absence of an alert is not visible. A batch job that silently fails generates no alerts, no dashboard anomalies, and no on-call pages. The data it was supposed to process simply does not get processed, and the problem is only discovered when a user or data team notices the stale data. Every scheduled job must emit a heartbeat metric (a counter incremented on every successful run) with a corresponding alert that fires when the heartbeat has not been received within 1.5x the job's expected interval.

"Using mean for latency alerts" is invisible because the mean can look healthy while tail latency is terrible. A service where 99% of requests complete in 100ms and 1% take 10 seconds has a mean of 199ms, which looks fine. But one in every hundred requests takes 10 seconds, which is a disaster. Always alert on p99 (or p999 for payment-critical services) for latency SLOs.

### Senior @ FAANG: Mistake Prevention Through Platform Defaults

At L6, each mistake in this table is either prevented by a platform default or detected by an automated check. "No dead man's switch" is prevented by a platform requirement that every CronJob Kubernetes manifest must have a corresponding heartbeat alert, verified by a Kubernetes admission webhook. "High-cardinality metric labels" is prevented by the CI metric linter. "No runbook link" is prevented by the alert rule linter.

The goal is to make it harder to make these mistakes than to avoid them. When the platform enforces the right behavior by default, engineers can focus on business logic rather than observability discipline. This is the compounding return on platform investment.

---
