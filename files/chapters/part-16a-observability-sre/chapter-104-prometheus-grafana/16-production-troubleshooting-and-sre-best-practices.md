## Production Troubleshooting and SRE Incident Response

Operational monitoring systems themselves can experience degraded performance or data loss under load. Follow this structured diagnostics and remediation guide.

---

### Diagnosis


The first step in fixing alert fatigue is measuring the problem. Before changing any thresholds, audit the current alert landscape by answering these questions:

"First, I'd analyze the alert patterns:
- What percentage are actionable? (Target: >50% should require human action)
- Which alerts fire most frequently? (The top 5 noisiest alerts account for the majority of fatigue)
- What's the pattern of false positives? (Time-of-day, deploy windows, or specific services)"

### Junior → FAANG: Treating Alert Fatigue as a Measurement Problem

You cannot fix alert fatigue without measuring it. The metrics to track are: total alert volume per rotation, percentage of alerts that required human action, and mean time from alert to resolution. Without these numbers, any "fix" is guesswork.

The >50% actionability target is the practical threshold. Below it, engineers spend more time dismissing noise than fixing problems, which means the alerting system is actively harming operational efficiency.

### Senior @ FAANG: Alert Quality as an Engineering Health Metric

At L6, alert quality is tracked as a platform health metric reported to engineering leadership. A rotation with >30% false positive rate triggers a mandatory post-rotation review to identify and fix the noisiest alerts. This creates organizational accountability for alert quality, which is the only sustainable way to prevent fatigue from accumulating over time as new services and alerts are added.


---

### Root causes and fixes


Most alert fatigue traces back to four common configuration mistakes. Each has a straightforward fix.

### 1. Too Low Thresholds
"Alert firing at 1% error rate when normal is 0.5%."
Fix: Base thresholds on historical data and error budget burn rates rather than static values. A 1% error rate is only meaningful relative to your SLO.

### 2. No Duration Requirement
"Alerting on instantaneous spikes."
Fix: Add `for: 5m` to require the condition to persist before firing. Transient spikes during deploys or autoscaling are normal and should not page.

### 3. Alerting on Both Symptoms and Causes
"Getting paged for both 'high latency' and 'database slow'."
Fix: Page on symptoms (user-visible impact) only. Use Alertmanager inhibition rules to suppress cause-level alerts when the corresponding symptom alert is already firing.

### 4. Missing Alert Correlation
"5 alerts for one incident."
Fix: Use Alertmanager `group_by` to aggregate related alerts into a single notification, and inhibition rules to suppress redundant downstream alerts during a known upstream failure.

### Junior → FAANG: Knowing These Four Fixes Is Table Stakes

These four root causes and fixes are the first things an experienced SRE asks about when reviewing an alert configuration. Before presenting your alerting design in an interview, verify that each of your alerts has an appropriate `for` clause, that you alert on symptoms not causes, and that you have Alertmanager grouping configured to aggregate related alerts.

Interview tip: the inhibition rule fix is the most advanced and least commonly known. Being able to explain it (source alert fires, inhibition rule suppresses target alerts that match a specific set of labels) signals SRE maturity beyond the basics.

### Senior @ FAANG: Inhibition Rule Design as Dependency Map Implementation

Alertmanager inhibition rules are a machine-readable form of your service dependency map. If service B depends on database C, and database C has a "down" alert, then service B's "high error rate" alert should be inhibited when database C is down (because the root cause is known). Maintaining accurate inhibition rules requires keeping the dependency map up to date, which is an L6-level ongoing responsibility. An automated tool that generates inhibition rules from a service dependency graph (stored in a service catalog) is a platform-level investment that prevents inhibition rules from becoming stale.

At FAANG scale, stale inhibition rules are an operational risk: an inhibition rule that incorrectly suppresses a service alert because a different, unrelated database alert is active can hide a real incident. Each inhibition rule must be reviewed whenever the matching labels change, and tested in staging with alert firing simulations before deployment to production.


---

### Sre best practices


Burn-rate alerting, described in the Google SRE Workbook, replaces static threshold alerts with budget-aware alerts that fire based on how fast the error budget is being consumed. This approach naturally ignores minor fluctuations while catching sustained degradation.

"I'd implement burn-rate alerting from Google SRE:
- Fast burn (14.4x budget consumption rate): page immediately, because the budget would be exhausted in hours
- Slow burn (3x budget consumption rate): create a ticket but don't page, because there is time to investigate during business hours
- This ensures we catch issues before SLO breach without noise for minor fluctuations that self-resolve."

### Junior → FAANG: Burn-Rate Math You Need to Know

For a 99.9% availability SLO with a 30-day window, the monthly error budget is 0.1% of 30 days = 43.8 minutes. A 14.4x burn rate means the budget would be exhausted in 30 / 14.4 = 2.08 days if the burn rate sustained. This is the fast-burn threshold that requires immediate paging. A 3x burn rate would exhaust the budget in 10 days, which is slow-burn territory warranting a ticket but not a page.

Be able to derive these numbers from the SLO during an interview, rather than reciting them from memory. The math demonstrates you understand the model, not just the answer.

### Senior @ FAANG: Multi-SLO Systems and Budget Allocation

A service often has multiple SLOs (availability, latency, throughput). Each has its own error budget. When an incident affects multiple SLOs simultaneously, the burn rates for all affected SLOs must be tracked. An L6 engineer designs a "composite SLO health" dashboard that shows the burn rate of every SLO on one screen, with color coding (green: within budget, yellow: slow burn, red: fast burn) so the on-call engineer can assess overall service health in one view rather than checking each SLO dashboard separately.
