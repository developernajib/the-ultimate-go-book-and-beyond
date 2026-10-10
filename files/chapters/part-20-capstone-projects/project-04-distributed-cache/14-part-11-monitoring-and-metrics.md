## Part 11: Monitoring and Metrics

### Prometheus Metrics

Monitoring is non-negotiable for any production cache. Without metrics, you are flying blind and will not know when your cache is running out of memory, experiencing high eviction rates, or suffering from poor hit ratios. The metrics package below defines Prometheus counters, histograms, and gauges that track every important aspect of cache behavior. Once these metrics are exported, you can build Grafana dashboards to visualize cache performance in real time and set up alerts for anomalies like sudden drops in hit rate or spikes in eviction count.

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    OpsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "gocache_ops_total",
            Help: "Total number of operations",
        },
        []string{"operation", "status"},
    )

    OpsDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "gocache_ops_duration_seconds",
            Help:    "Operation duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"operation"},
    )

    CacheHits = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "gocache_hits_total",
            Help: "Total number of cache hits",
        },
    )

    CacheMisses = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "gocache_misses_total",
            Help: "Total number of cache misses",
        },
    )

    MemoryUsage = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "gocache_memory_bytes",
            Help: "Current memory usage in bytes",
        },
    )

    KeysTotal = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "gocache_keys_total",
            Help: "Total number of keys",
        },
    )

    EvictionsTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "gocache_evictions_total",
            Help: "Total number of evictions",
        },
    )
)
```

---

### Junior → FAANG: Cache Metrics as the Diagnostic Foundation

The three most important cache metrics are hit rate, eviction rate, and memory usage. Hit rate (hits / (hits + misses)) tells you how effective the cache is. An 80% hit rate means 80% of requests are served from memory. If hit rate drops, either the cache is too small, the TTL is too short, or the workload distribution has changed. Eviction rate tells you how aggressively the LRU is removing entries. A high eviction rate combined with a low hit rate suggests the cache is undersized for its workload.

For interviews, describe your monitoring strategy before describing your implementation. "I expose hit rate, eviction rate, and memory utilization as Prometheus metrics, and I alert when hit rate drops below 70% or when memory utilization exceeds 90%" shows you think about operations, not just code.

Connection pool utilization is the fourth critical metric: if the pool is fully utilized (all connections checked out), new requests queue. If the queue grows, request latency increases. Monitoring pool utilization and alerting when it approaches 100% gives you early warning before users notice degraded performance.

### Senior @ FAANG: Cache Observability as an SLO Foundation

At senior level, cache observability is the foundation for SLO definition and enforcement. The cache SLO might be: "p99 latency below 2ms for GET operations, hit rate above 80% measured over a 5-minute window, and availability above 99.9% measured over a rolling 30-day window." Each metric in the monitoring system maps to one of these SLO dimensions.

Alert design for a cache must distinguish between transient spikes and sustained degradation. A single second of high miss rate (because a deploy flushed the cache) is not an SLO violation. A sustained 5-minute period of high miss rate is. Using burn rate alerting (how fast are you consuming your error budget for the month?) rather than point-in-time threshold alerting reduces false positive alert fatigue.

Capacity planning from metrics is the long-term payoff of good monitoring. With 90 days of memory utilization and hit rate data, you can predict when the cache will need to be expanded based on traffic growth trends. Presenting this forecast in a quarterly capacity planning review is a senior engineering contribution that prevents reactive scaling (expanding capacity only after service degradation).

---
