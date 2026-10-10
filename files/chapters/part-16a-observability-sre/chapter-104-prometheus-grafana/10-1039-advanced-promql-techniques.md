## 104.10 Advanced PromQL Techniques

### Recording Rules for Performance

Pre-compute expensive queries to improve dashboard performance:

```yaml
# prometheus/rules/recording_rules.yaml
groups:
  - name: api-performance
    interval: 30s
    rules:
      # Pre-compute request rate
      - record: api:http_requests:rate5m
        expr: sum by (service, endpoint) (rate(http_requests_total[5m]))

      # Pre-compute error rate
      - record: api:http_errors:rate5m
        expr: |
          sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) /
          sum by (service) (rate(http_requests_total[5m]))

      # Pre-compute p95 latency
      - record: api:http_latency_seconds:p95
        expr: |
          histogram_quantile(0.95, sum by (le, service) (
            rate(http_request_duration_seconds_bucket[5m])
          ))

      # Pre-compute p99 latency
      - record: api:http_latency_seconds:p99
        expr: |
          histogram_quantile(0.99, sum by (le, service) (
            rate(http_request_duration_seconds_bucket[5m])
          ))

  - name: slo-metrics
    interval: 1m
    rules:
      # SLI: Availability (1 hour window)
      - record: sli:availability:1h
        expr: |
          1 - (
            sum(increase(http_requests_total{status=~"5.."}[1h])) /
            sum(increase(http_requests_total[1h]))
          )

      # SLI: Latency (percentage under 500ms)
      - record: sli:latency:under500ms:1h
        expr: |
          sum(increase(http_request_duration_seconds_bucket{le="0.5"}[1h])) /
          sum(increase(http_request_duration_seconds_count[1h]))

      # Error budget remaining (monthly)
      - record: slo:error_budget_remaining
        expr: |
          1 - (
            sum(increase(http_requests_total{status=~"5.."}[30d])) /
            sum(increase(http_requests_total[30d]))
          ) / 0.001  # 99.9% SLO = 0.001 error budget
```

### Subqueries and Aggregation Over Time

PromQL subqueries evaluate an inner expression at a chosen resolution over a range, producing a range vector from a derived expression. This lets you apply `*_over_time` functions to computed values like rates and quantiles, not just raw series. The following examples demonstrate the subquery syntax and the aggregation-over-time functions that operate on the resulting range vector.

```promql
# Subquery: Max p99 latency over the last day
max_over_time(
  histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))[24h:5m]
)

# Subquery: Did the error rate exceed 1% at any point in the last day?
max_over_time(
  (sum(rate(http_requests_total{status=~"5.."}[5m])) /
   sum(rate(http_requests_total[5m])) > 0.01)[24h:5m]
)

# Moving average of request rate (smoothing)
avg_over_time(sum(rate(http_requests_total[5m]))[30m:5m])

# Standard deviation to detect anomalies
stddev_over_time(sum(rate(http_requests_total[5m]))[1h:5m])

# Coefficient of variation (for anomaly detection)
stddev_over_time(sum(rate(http_requests_total[5m]))[1h:5m]) /
avg_over_time(sum(rate(http_requests_total[5m]))[1h:5m])

# Week-over-week comparison
sum(rate(http_requests_total[5m])) /
sum(rate(http_requests_total[5m] offset 1w))

# Month-over-month growth
(sum(increase(http_requests_total[7d])) -
 sum(increase(http_requests_total[7d] offset 28d))) /
sum(increase(http_requests_total[7d] offset 28d)) * 100
```

### Label Manipulation

Label manipulation functions in PromQL, `label_replace` and `label_join`, transform label sets at query time, enabling federation of metrics from services with inconsistent labeling conventions. The following examples demonstrate the most common transformations used to normalize labels across heterogeneous service fleets.

```promql
# Rename labels using label_replace
label_replace(http_requests_total, "status_code", "$1", "status", "(.*)")

# Join metrics using label_join
label_join(http_requests_total, "combined", "_", "method", "path")

# Enrich metrics with info-metric labels using group_left
# Attach the node label from kube_pod_info to per-pod request rates
sum by (namespace, pod) (rate(http_requests_total[5m]))
* on (namespace, pod) group_left (node)
  kube_pod_info

# Derive a new label with label_replace, then aggregate by it
sum by (cluster) (
  label_replace(http_requests_total, "cluster", "prod", "instance", "prod-.*")
)
```

### Junior → FAANG: When Advanced PromQL Actually Matters

Advanced PromQL techniques (subqueries, `label_replace`, `topk`, `bottomk`, offset) appear in interviews for SRE and platform engineering roles. The most commonly tested pattern is computing an error rate over a long window to detect slow burns: `rate(errors_total[1h]) / rate(requests_total[1h])` compared to an SLO threshold.

For most application engineers, basic PromQL (`rate()`, `sum by()`, `histogram_quantile()`) is sufficient. Advanced techniques are primarily needed when writing alerting rules for SLO burn rates or when building complex dashboard templates. Focus on understanding these patterns conceptually before being asked to write them from memory.

Interview entry point: "What is a subquery in PromQL and when would you use one?" A subquery evaluates a range query on an instant vector expression, enabling range-over-range calculations. You use it when you need to compute the maximum of a 1-minute rate over the past hour: `max_over_time(rate(requests_total[1m])[1h:1m])`.

### Senior @ FAANG: Advanced PromQL in SLO Engineering and Capacity Planning

**Multi-window burn rate alerts using advanced PromQL.** The canonical multi-window SLO alert combines two burn rate calculations: `(rate(errors[1h]) / rate(requests[1h]) > 14.4 * error_budget_ratio) AND (rate(errors[5m]) / rate(requests[5m]) > 14.4 * error_budget_ratio)`. The 1-hour window establishes that the burn is significant, while the 5-minute window confirms the problem is still happening, preventing pages for spikes that already resolved. Writing this query correctly, with proper label matching and without accidentally aggregating away necessary dimensions, is an L6-level PromQL skill.

**Capacity planning queries.** Predicting when a resource (CPU, memory, disk, active connections) will be exhausted requires trend analysis. `predict_linear(node_filesystem_avail_bytes[6h], 4 * 3600)` predicts the disk availability 4 hours from now based on the last 6 hours of trend. This query runs as a recording rule updated every 5 minutes, and an alert fires when the predicted value goes negative. An L6 engineer designs the full set of capacity prediction recording rules and alerts for all critical infrastructure resources.

**`label_replace` for cross-service correlation.** In environments where metric labels use different naming conventions across systems (Kubernetes uses `pod`, Prometheus uses `instance`, APM uses `host`), `label_replace` normalizes labels before joining vectors. An L6 engineer who writes cross-system correlation queries using `label_replace` and `on()` / `ignoring()` joins demonstrates deep PromQL knowledge that distinguishes them in bar-raiser interviews.

---
