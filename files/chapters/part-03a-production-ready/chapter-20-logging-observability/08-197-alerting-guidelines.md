## 20.7 Alerting Guidelines

### RED Method (Request-driven)

The RED method focuses on the three signals that matter most for request-driven services: Rate, Errors, and Duration. These PromQL expressions compute each signal over a five-minute rolling window, a window short enough to detect incidents quickly but wide enough to smooth out momentary spikes. Alerting on a sustained error rate above a threshold or on p99 latency exceeding an SLO budget covers the vast majority of user-impacting incidents.

```promql
# Rate: requests per second across the service
sum(rate(http_requests_total[5m]))

# Errors: fraction of requests failing.
# Aggregate BOTH sides, or the division silently drops series.
sum(rate(http_requests_total{status=~"5.."}[5m]))
  /
sum(rate(http_requests_total[5m]))

# Duration: p99 latency.
# The "by (le)" is mandatory: histogram_quantile needs the le dimension
# and nothing else, or you get one p99 per label combination.
histogram_quantile(0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
)
```

Two details in those expressions are the difference between a working dashboard and a misleading one.

**`sum by (le)` around the bucket rate.** `histogram_quantile` reads the `le` (less-than-or-equal) label to reconstruct the distribution. Hand it the raw `rate(...bucket[5m])` and every other label your metric carries, `method`, `route`, `status`, survives, so you get a separate p99 for every single label combination rather than one number for the service. The panel renders, the numbers look like latencies, and none of them is the p99 you asked for. Summing by `le` collapses everything except the dimension the function needs.

**Aggregate both sides of the error-rate division.** Prometheus matches series on the left and right of a binary operator by their full label sets. The numerator only has series for label combinations that actually produced a 5xx. So `rate(errors) / rate(total)` computes a ratio only for routes that are currently failing, and silently returns nothing for the rest. Worse, the result keeps its labels, so the "error rate" you graph is per-route, not per-service. `sum(...) / sum(...)` reduces both sides to a single series and gives you the number you meant.

If you want the error rate broken down by route, be explicit about it and aggregate both sides the same way, so the label sets match:

```promql
sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
  /
sum by (route) (rate(http_requests_total[5m]))
```

### USE Method (Resource-driven)

Where RED is suited to services, the USE method is designed for the underlying infrastructure resources those services consume: Utilization, Saturation, and Errors. High utilization alone rarely causes problems, but when combined with rising saturation, work queuing up because the resource is fully occupied, it reliably predicts imminent degradation. Tracking these three dimensions together lets on-call engineers quickly distinguish between a service bug and a resource constraint.

```
# Utilization: % time resource is busy
rate(cpu_seconds_total[5m])

# Saturation: work queued
pending_requests

# Errors: error count
rate(errors_total[5m])
```

### Alert on Symptoms, Not Causes

An alert should fire on user-facing impact (high error rate, high latency), not on internal state (high CPU, high queue depth). Internal state can be high without impacting users. User-facing impact requires action regardless of internal cause.

The principle: every page should represent a real user impact. False pages teach engineers to ignore alerts. Real pages get investigated immediately.

### Staff Lens: SLO-Based Alerting

Define SLOs (e.g., 99.9% of requests succeed, 99% complete in 500ms). Alert when the error budget is burning faster than allowed. This reframes alerting from "something is wrong" to "we will miss our SLO if this continues". The former fires on every blip. The latter fires on user-impacting issues.

Google's SRE book covers this in detail. Teams that move from threshold-based to SLO-based alerting experience dramatically lower alert noise and higher alert actionability.

### Runbooks Per Alert

Every alert should link to a runbook. "High error rate" is not actionable. "High error rate: check downstream X, check deploy history, escalate to Y if not recovered in 15 minutes" is. Write the runbook when the alert is created, not during the incident.

---
