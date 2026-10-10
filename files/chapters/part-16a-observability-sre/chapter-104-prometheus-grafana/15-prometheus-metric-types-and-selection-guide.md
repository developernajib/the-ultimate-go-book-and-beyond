## Prometheus Metric Types and Selection Guide

Prometheus defines four core metric primitives. Selecting the correct metric type is foundational for calculating accurate quantiles, aggregations, and rate derivatives.

---

### Counter


A counter is a cumulative metric that only increases over its lifetime (or resets to zero on process restart). Counters track how many times something has happened: requests served, errors encountered, bytes transmitted. Because a counter's raw value is meaningless in isolation (it grows forever), you always query it with `rate()` or `increase()` to compute the per-second velocity or the total change over a time window.

- **What**: Monotonically increasing value
- **Use for**: Requests, errors, bytes sent
- **Query with**: `rate()` for per-second velocity, `increase()` for total change over a window
- **Example**: `http_requests_total`
- **Anti-pattern**: Never use a counter for a value that can decrease (use a gauge instead)

### Junior → FAANG: Counter Gotchas in Interviews

Two counter behaviors trip up junior engineers in interviews. First: `rate()` handles counter resets automatically (when a counter drops due to a process restart, `rate()` detects the decrease and treats it as a reset). `increase()` also handles resets. Raw subtraction does not. Never compute a rate by subtracting two counter samples.

Second: a counter that has never been incremented does not appear in the metrics output. If your alerting rule uses `rate(errors_total[5m]) > 0`, and the counter has never been incremented, Prometheus returns no data rather than zero, and the alert silently never evaluates. Initialize counters with zero-increment calls at startup to ensure they always appear in the scrape.

### Senior @ FAANG: Counter Semantics in Multi-Instance Environments

In a horizontally scaled service with 20 pods, each pod has its own counter. `sum(rate(http_requests_total[5m]))` aggregates across all pods to get the fleet-wide request rate. This aggregation is the correct default for capacity planning. However, for tail latency analysis, aggregation masks per-instance outliers. An L6 engineer designs dashboards with both aggregate panels (for SLO tracking) and per-instance breakdown panels (for diagnosing noisy neighbor scenarios and imbalanced load distribution).


---

### Gauge


A gauge represents a single numerical value that can increase or decrease over time. Gauges capture point-in-time snapshots of a quantity: the number of active connections right now, the current queue depth, the amount of free memory. Unlike counters, gauges are queried directly for their current value or with `deriv()` to compute the rate of change. Gauges are the correct choice whenever the metric reflects a current state rather than an accumulated total.

- **What**: Value that can go up and down
- **Use for**: Temperature, active connections, queue depth, memory usage
- **Query with**: Direct value, `deriv()` for rate of change, `min_over_time()` / `max_over_time()` for bounds
- **Example**: `go_goroutines`, `memory_usage_bytes`
- **Anti-pattern**: Never use a gauge for something that should be a counter (e.g., total requests served)

### Junior → FAANG: Gauge Staleness and Its Effect on Alerts

A gauge whose updater goroutine is stuck keeps reporting its last value on every scrape, looking healthy while frozen. And if the service crashes entirely, Prometheus marks the target's series stale and they return no data at all, so an alert that checks `go_goroutines < 10` never fires: there is no sample to compare, not a low one. Use `absent()` or the `up` metric to detect missing targets, not gauge thresholds, for health-check purposes.

### Senior @ FAANG: Gauge Aggregation Semantics

Unlike counters (which aggregate by summing), gauge semantics depend on what the gauge measures. `sum(go_goroutines)` across pods gives total goroutines (useful for fleet capacity). `avg(go_goroutines)` gives the average per pod (useful for detecting imbalance). `max(go_goroutines)` gives the worst-case pod (useful for capacity planning). An L6 engineer documents the intended aggregation for each gauge in the metrics documentation, preventing future engineers from choosing the wrong aggregation in dashboards.


---

### Histogram


A histogram samples observations (typically request durations or response sizes) and counts them in configurable buckets. Each bucket is a counter tracking how many observations fell at or below that boundary. This structure allows Prometheus to compute approximate percentiles server-side using `histogram_quantile()`, and critically, histogram buckets can be aggregated across multiple instances before computing the percentile. Choose bucket boundaries that align with your SLO thresholds so the quantile estimate is most accurate at the values that matter.

- **What**: Samples observations into configurable buckets
- **Use for**: Latency distributions, response size distributions
- **Query with**: `histogram_quantile()` for percentiles, `_count` and `_sum` for averages
- **Example**: `http_request_duration_seconds`
- **Key advantage**: Aggregatable across instances (unlike summaries)
- **Note**: Accuracy depends on bucket boundaries. Place them at your SLO thresholds

### Junior → FAANG: Histogram Bucket Boundaries Are a Design Decision

Choosing `prometheus.DefBuckets` (the default) for a service with a 500ms SLO is wrong. The default buckets are [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] seconds. The 0.5 boundary happens to align with 500ms, but the default buckets allocate too many buckets below 100ms for most web services and too few above 1 second. Custom buckets that place boundaries at SLO thresholds (P50 target, P99 target, 2x P99) give the most accurate percentile estimates where they matter.

### Senior @ FAANG: Histogram Cardinality Budget and Native Histograms

A histogram with N buckets, L label values, and P pods creates `N * L * P` time series. With 12 buckets, 6 label combinations (3 methods x 2 status classes), and 50 pods, that is 3,600 series for one metric. At scale, native histograms (Prometheus 2.40+) eliminate the bucket configuration burden and reduce series count by encoding the full distribution in a single series using an exponential bucketing scheme. An L6 engineer evaluates native histogram adoption as part of the platform's cardinality reduction roadmap.


---

### Summary


A summary computes streaming quantiles (e.g., p50, p90, p99) on the client side before exposing them. Each quantile has a configurable error bound (the `Objectives` map), giving tight per-instance estimates, but the pre-computed quantiles cannot be meaningfully aggregated across multiple pods, you cannot average p99 values to get a fleet-wide p99. For this reason, histograms are the preferred choice in most production deployments where you run more than one replica.

- **What**: Client-side calculated quantiles with configurable error bounds
- **Use for**: Cases where tight per-instance quantiles are needed and cross-instance aggregation is not required
- **Limitation**: Cannot aggregate across instances. Quantile calculation has a memory cost proportional to the observation window
- **Recommendation**: Prefer histograms for most production use cases, especially multi-instance services

### Junior → FAANG: Summary vs. Histogram in Interviews

The summary vs. histogram distinction is a standard interview question. The answer that signals understanding (not just memorization) is: "Summary quantiles are computed per instance and cannot be aggregated. If I have 10 pods and I take the average of their p99 values, that average is not the p99 of the combined distribution. A histogram aggregates the raw bucket counts and then computes the quantile, which gives the correct fleet-wide p99." That reasoning demonstrates you understand the math, not just the recommendation.

### Senior @ FAANG: Summary Use Cases That Still Exist

Summaries remain useful in two specific scenarios that classic histograms handle poorly: when you need per-instance quantiles with tight, known error bounds for a single-instance service, and when the distribution spans such a wide range that pre-defined histogram buckets cannot cover it. A queue processing service that handles both sub-millisecond and multi-minute tasks has a 6-order-of-magnitude range that no static bucket set covers well. In this case, a summary on the per-worker processing time, alongside a histogram for the user-facing end-to-end latency, gives accurate per-instance diagnostics without the bucket configuration problem. Document this choice explicitly: "summary used here because the distribution range prevents meaningful histogram buckets."


---

### When to choose


The metric type decision follows directly from the question you need to answer about your data:

- **"How many?".** Counter. Total requests, errors, bytes. Always use `rate()` to query.
- **"What is it now?".** Gauge. Current connections, queue depth, temperature. Query the raw value.
- **"How is it distributed?".** Histogram. Latency percentiles, response size distributions. Aggregatable across instances.
- **"Need tight per-instance quantiles?".** Summary. Only when cross-instance aggregation is not needed.

When in doubt, prefer histograms over summaries. Histograms allow server-side percentile computation and cross-instance aggregation, which summaries cannot provide.

### Junior → FAANG: Making the Decision Under Interview Pressure

When an interviewer asks "what metric type would you use for X," apply the decision tree above in order. The most common trap is the "current queue depth" question: some engineers reach for a counter ("it goes up as items are added"), but a gauge is correct because the queue depth can decrease as items are consumed. Counter = only goes up. Gauge = can go up or down.

### Senior @ FAANG: Metric Type Decisions in ADRs

At L6, metric type decisions for new services are documented in the service's observability ADR. The ADR specifies each metric, its type with justification, its labels with cardinality estimate, and the PromQL queries used for the associated SLO. This documentation ensures that when the service is handed to a new team or a new engineer joins, the observability design rationale is recoverable without reading the instrumentation code.

---

### Question 3: "You're getting alert fatigue with too many pages. How would you fix it?"

**Strong Answer Framework:** work the problem in four stages, developed across the next four sections: diagnose (measure the noise before touching anything), fix root causes, apply SRE alerting best practices, and measure the improvement.
