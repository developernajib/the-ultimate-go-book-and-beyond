## 104.4 PromQL Queries

### Essential PromQL Patterns

The queries below are the working vocabulary of production PromQL: request rates, error percentages, latency percentiles, runtime health, and SLO math. Each one builds on the metrics instrumented earlier in this chapter, and every dashboard and alert in the sections that follow is a variation on one of these patterns.
```promql
# Request rate (requests per second over 5 minutes)
rate(http_requests_total[5m])

# Request rate by endpoint
sum by (path) (rate(http_requests_total[5m]))

# Error rate percentage
sum(rate(http_requests_total{status=~"5.."}[5m])) /
sum(rate(http_requests_total[5m])) * 100

# 95th percentile latency
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# 99th percentile latency by endpoint
histogram_quantile(0.99, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m])))

# Average latency
sum(rate(http_request_duration_seconds_sum[5m])) /
sum(rate(http_request_duration_seconds_count[5m]))

# Active requests
http_active_requests

# Memory usage
go_memstats_alloc_bytes / 1024 / 1024  # In MB

# Goroutine count
go_goroutines

# GC duration (seconds)
sum(rate(go_gc_duration_seconds_sum[5m])) /
sum(rate(go_gc_duration_seconds_count[5m]))

# CPU usage (using node exporter)
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Disk usage percentage
100 - ((node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.*"} * 100) /
       node_filesystem_size_bytes{fstype!~"tmpfs|fuse.*"})

# Network traffic rate (bytes/sec)
rate(node_network_receive_bytes_total[5m])

# Top 5 endpoints by request rate
topk(5, sum by (path) (rate(http_requests_total[5m])))

# Services with high error rate
(sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) /
 sum by (service) (rate(http_requests_total[5m]))) > 0.01

# SLO: Percentage of requests under 250ms
# (le must match an actual bucket boundary, 0.25 in our instrumentation)
sum(rate(http_request_duration_seconds_bucket{le="0.25"}[5m])) /
sum(rate(http_request_duration_seconds_count[5m])) * 100

# Apdex score (target: 0.1s, tolerating: 0.5s, both real bucket boundaries)
(
  sum(rate(http_request_duration_seconds_bucket{le="0.1"}[5m])) +
  sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m]))
) / 2 / sum(rate(http_request_duration_seconds_count[5m]))
```

### Junior → FAANG: PromQL Core Operators That Appear in Every Interview

PromQL interviews test three categories of knowledge: understanding vector types, knowing when to use `rate()` vs. `irate()`, and being able to write multi-step aggregation queries.

**Instant vector vs. range vector.** `http_requests_total` is an instant vector: the current counter value for each label set. `http_requests_total[5m]` is a range vector: the last 5 minutes of counter values for each label set. `rate()` takes a range vector and returns the per-second rate of increase. You cannot call `rate()` on an instant vector.

**`rate()` vs. `irate()`.** `rate()` computes the average rate over the full range window, smoothing out spikes. `irate()` uses only the last two data points, making it more responsive to sudden spikes. For alerting, `rate()` is more stable. For real-time debugging during an incident, `irate()` shows changes faster. For SLO calculations, always use `rate()`.

**`histogram_quantile()` gotcha.** `histogram_quantile(0.99, rate(http_duration_bucket[5m]))` requires that the `le` label is present in the metric. If you use `without(le)` in a `sum()` before calling `histogram_quantile()`, you lose the bucket boundaries and the function returns `NaN`. Always aggregate `by(le, ...)`, never `without(le)`.

### Senior @ FAANG: PromQL at Scale, Recording Rules, and Query Performance Governance

**Recording rules as a query performance contract.** A PromQL query that scans 10 million time series on every dashboard load makes Grafana unusable at scale. Recording rules pre-compute expensive queries and store their results as new time series, so dashboard queries scan a small number of pre-computed series rather than the full raw dataset. An L6 engineer defines which queries must be implemented as recording rules (any query used in an alert or a dashboard that scans more than 100,000 series), and the platform team enforces this rule during query review.

**Query complexity budget.** Ad-hoc PromQL queries with unbounded label selectors (no service or namespace filter) can trigger full-scan queries that starve other Prometheus users. The platform team implements query complexity limits (max series returned, max time range for rate functions) enforced by a Thanos query frontend with per-tenant limits. Engineers who need to run high-cost queries for capacity planning use a separate analytics Prometheus instance that does not share resources with the production alerting pipeline.

**Multi-cluster federation queries.** In a multi-cluster environment, each cluster has its own Prometheus, and Thanos or Mimir provides a global query layer. PromQL queries that span clusters are much more expensive than single-cluster queries because they are executed against a remote store. An L6 engineer designs cross-cluster dashboards to use pre-federated recording rules rather than live cross-cluster queries, reducing the load on the global query layer.

---
