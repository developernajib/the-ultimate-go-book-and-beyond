## 104.1 Prometheus Fundamentals

### Architecture Overview

Prometheus operates on a pull model: the server scrapes a `/metrics` HTTP endpoint exposed by each instrumented Go service at a configurable interval, and stores the resulting time-series samples in its embedded TSDB (Time Series Database), which stores samples in compressed per-series chunks optimized for range queries. Alert rules evaluated against the TSDB forward firing alerts to Alertmanager, which handles deduplication, grouping, and routing to receivers such as PagerDuty or Slack. The four core metric types, Counter, Gauge, Histogram, and Summary, map directly to the `prometheus/client_golang` registration API and correspond to distinct query patterns in PromQL.

```
┌──────────────────────────────────────────────────────────────────┐
│                   PROMETHEUS ARCHITECTURE                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    scrape     ┌─────────────────────┐           │
│  │  Go Service │◄──────────────│    Prometheus       │           │
│  │  /metrics   │               │    Server           │           │
│  └─────────────┘               │                     │           │
│                                │  ┌───────────────┐  │           │
│  ┌─────────────┐               │  │   TSDB        │  │           │
│  │  Go Service │◄──────────────│  │   (storage)   │  │           │
│  │  /metrics   │               │  └───────────────┘  │           │
│  └─────────────┘               │                     │           │
│                                │  ┌───────────────┐  │           │
│                                │  │ Alert Rules   │  │           │
│                                │  └───────────────┘  │           │
│                                └─────────┬───────────┘           │
│                                          │                       │
│                                          ▼                       │
│                                ┌─────────────────────┐           │
│                                │   Alertmanager      │           │
│                                │  (notifications)    │           │
│                                └─────────────────────┘           │
│                                                                  │
│  METRIC TYPES:                                                   │
│  • Counter: Cumulative value (requests, errors)                  │
│  • Gauge: Current value (temperature, connections)               │
│  • Histogram: Distribution (latency buckets)                     │
│  • Summary: Client-side quantiles                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Prometheus Metric Types and When to Use Each

The four metric types have specific use cases. Using the wrong type produces metrics that are technically correct but impossible to query usefully.

**Counter**: monotonically increasing, resets to zero on process restart. Use for "total number of X." Query with `rate()` to get per-second rate. Never use a counter for a value that can decrease (like queue depth).

**Gauge**: value that goes up and down. Use for "current number of X." Query directly or with `delta()` for change over time. Use for goroutine count, active connections, memory usage.

**Histogram**: observes values and places them in buckets. Use for latency and size distributions. Enables percentile calculation with `histogram_quantile()`. Requires careful bucket selection.

**Summary**: like a histogram but computes quantiles client-side. Avoid in new code: quantiles cannot be aggregated across instances, making it useless in horizontally scaled services. Use histograms instead.

Interview entry point: "Why is Summary generally not recommended for new services?" Because summary quantiles are computed per-instance and cannot be meaningfully aggregated. If you have 10 instances and want the p99 latency across all of them, a summary cannot provide it. A histogram can, using `histogram_quantile()` on the aggregated bucket counts.

### Senior @ FAANG: Native Histograms and Bucket Design at Scale

**Native histograms (Prometheus 2.40+).** Classic histograms require pre-defined bucket boundaries at instrumentation time. If you choose buckets [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] and your service starts serving requests that take 10 seconds, the slowest bucket captures everything above 5 seconds without distinction. Native histograms use an exponential bucketing scheme that automatically adapts to the observed distribution, reducing both the pre-planning burden and the number of time series per metric. An L6 engineer evaluates native histogram adoption as part of the platform's Prometheus upgrade roadmap.

**Bucket design as a performance governance concern.** Classic histogram buckets directly determine the number of time series. A histogram with 10 buckets, 5 label values, and 100 service instances creates 5,000 time series for that one metric. Multiply by 50 metrics and the cardinality is 250,000 time series for one service. The platform team establishes maximum bucket counts per histogram type (HTTP latency: 10 buckets, DB query latency: 8 buckets, payload size: 6 buckets) to keep total time series growth predictable.

---
