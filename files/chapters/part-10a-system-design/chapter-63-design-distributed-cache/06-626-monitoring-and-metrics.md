## 63.6 Monitoring and Metrics

Cache metrics are the primary signal for diagnosing performance issues and rightsizing cache capacity. Hit rate is the most important metric: a hit rate below 80% indicates the cache is not providing meaningful latency reduction and warrants investigation into key design, TTL configuration, or capacity. Tracking eviction rates alongside hit rates reveals whether capacity is the bottleneck, while latency percentiles on cache operations catch cases where network or serialization overhead is negating the cache benefit.

```go
// metrics/metrics.go
package metrics

import (
    "sync/atomic"
    "time"
)

// CacheMetrics tracks cache performance metrics
type CacheMetrics struct {
    hits        uint64
    misses      uint64
    sets        uint64
    deletes     uint64
    evictions   uint64
    bytesRead   uint64
    bytesWritten uint64
    errors      uint64

    latencySum   uint64
    latencyCount uint64
}

// RecordHit records a cache hit
func (m *CacheMetrics) RecordHit(latency time.Duration) {
    atomic.AddUint64(&m.hits, 1)
    atomic.AddUint64(&m.latencySum, uint64(latency.Microseconds()))
    atomic.AddUint64(&m.latencyCount, 1)
}

// RecordMiss records a cache miss
func (m *CacheMetrics) RecordMiss(latency time.Duration) {
    atomic.AddUint64(&m.misses, 1)
    atomic.AddUint64(&m.latencySum, uint64(latency.Microseconds()))
    atomic.AddUint64(&m.latencyCount, 1)
}

// RecordSet records a set operation
func (m *CacheMetrics) RecordSet(bytes int64) {
    atomic.AddUint64(&m.sets, 1)
    atomic.AddUint64(&m.bytesWritten, uint64(bytes))
}

// RecordEviction records an eviction
func (m *CacheMetrics) RecordEviction() {
    atomic.AddUint64(&m.evictions, 1)
}

// GetStats returns current statistics
func (m *CacheMetrics) GetStats() Stats {
    hits := atomic.LoadUint64(&m.hits)
    misses := atomic.LoadUint64(&m.misses)
    total := hits + misses

    var hitRate float64
    if total > 0 {
        hitRate = float64(hits) / float64(total)
    }

    var avgLatency time.Duration
    count := atomic.LoadUint64(&m.latencyCount)
    if count > 0 {
        avgLatency = time.Duration(atomic.LoadUint64(&m.latencySum)/count) * time.Microsecond
    }

    return Stats{
        Hits:          hits,
        Misses:        misses,
        HitRate:       hitRate,
        Sets:          atomic.LoadUint64(&m.sets),
        Deletes:       atomic.LoadUint64(&m.deletes),
        Evictions:     atomic.LoadUint64(&m.evictions),
        BytesRead:     atomic.LoadUint64(&m.bytesRead),
        BytesWritten:  atomic.LoadUint64(&m.bytesWritten),
        AvgLatency:    avgLatency,
        Errors:        atomic.LoadUint64(&m.errors),
    }
}

// Stats contains cache statistics
type Stats struct {
    Hits         uint64
    Misses       uint64
    HitRate      float64
    Sets         uint64
    Deletes      uint64
    Evictions    uint64
    BytesRead    uint64
    BytesWritten uint64
    AvgLatency   time.Duration
    Errors       uint64
}

// Reset resets all metrics
func (m *CacheMetrics) Reset() {
    atomic.StoreUint64(&m.hits, 0)
    atomic.StoreUint64(&m.misses, 0)
    atomic.StoreUint64(&m.sets, 0)
    atomic.StoreUint64(&m.deletes, 0)
    atomic.StoreUint64(&m.evictions, 0)
    atomic.StoreUint64(&m.bytesRead, 0)
    atomic.StoreUint64(&m.bytesWritten, 0)
    atomic.StoreUint64(&m.latencySum, 0)
    atomic.StoreUint64(&m.latencyCount, 0)
    atomic.StoreUint64(&m.errors, 0)
}
```

### Junior -> FAANG: Building Observability Habits from Day One

Many junior engineers treat metrics as an afterthought added after a production incident. FAANG interviewers probe whether you instrument code before shipping it, not after something breaks.

The most important metric for a cache is hit rate, not latency. A cache with 99.9% hit rate and 2ms latency is almost always better than a cache with 95% hit rate and 0.5ms latency, because the cost of a miss is not just the cache latency but the full database round trip plus the cache latency. Interviewers who ask "how do you know your cache is working?" expect you to cite hit rate as the primary health signal.

The `CacheMetrics` struct above uses `atomic` operations for all counters, which is the correct approach for high-throughput paths. A first-job habit: never use a mutex-protected map for metrics that are written on every cache operation. The contention cost negates the cache benefit. `sync/atomic` is the right tool for hot-path counters.

Average latency (`AvgLatency`) is a weak metric for cache operations. Practice saying "I would use p50, p99, and p999 latencies rather than averages, because a cache node serving 100K ops/sec with a 50ms p999 latency is causing 100 cache requests per second to be slow, and averages hide this." FAANG interviewers reward candidates who know why averages are misleading.

For interview entry-point: when asked "how do you monitor a cache," name hit rate, eviction rate, latency percentiles, and memory utilization. Then explain what anomaly in each metric would cause you to page on-call.

### Senior @ FAANG: Metrics Architecture as a Platform Concern

The `CacheMetrics` struct in this file tracks single-node counters. At FAANG scale, the metrics architecture is itself a distributed systems problem.

**ADR: Per-operation atomic counters vs Prometheus histogram buckets**

The implementation above stores raw sums and counts and computes averages at read time. This is appropriate for in-process reporting but inadequate for production observability. The correct choice at FAANG is to emit metrics to a time-series system (Prometheus, Datadog, or an internal equivalent) using histogram buckets that preserve latency distribution without storing every sample. The ADR choice: atomic counters are cheap and correct for internal health checks, but the canonical observability path is histogram export to a scrape target. Candidates who propose storing per-request latency samples in a ring buffer are solving the wrong problem.

**What eviction rate tells you about capacity planning**

An eviction rate above 5% of the set rate is a signal that the cache is undersized for the working set. At FAANG, this is a capacity planning trigger, not just an alert. A principal engineer looks at eviction rate trends over 7 days, correlates them with traffic growth, and submits a capacity request before the eviction rate climbs high enough to affect hit rate. Reactive capacity planning (adding nodes after hit rate drops) causes an incident. Predictive capacity planning (adding nodes when eviction trends upward) prevents one.

**Multi-tenant cache metrics and attribution**

When multiple services share a Redis cluster, per-service hit rate and eviction attribution are required for cost accounting and SLA enforcement. A platform approach adds a `namespace` label to every metric, so that the search service's hit rate can be graphed independently from the recommendations service's hit rate. Without namespace attribution, a cache poisoning or key-space explosion in one tenant degrades all tenants and the on-call engineer cannot identify the source. The observability design must anticipate multi-tenancy from the start.

**The metrics hierarchy for a cache: what to alert on vs what to dashboard**

Not all metrics justify an alert. The right hierarchy:

1. Alert immediately: hit rate drops below 70% for more than 5 minutes (P0 equivalent, cache is failing to provide value)
2. Alert within 15 minutes: eviction rate exceeds 10% of set rate for more than 10 minutes (capacity pressure)
3. Dashboard only: average latency, bytes read/written (informational, no direct action)
4. Weekly review: hit rate by key prefix (identifies keys that should be TTL-tuned or evicted from cache entirely)

A staff engineer defines this hierarchy in the SLO document for the cache platform and enforces it in the alerting configuration. An L4 engineer adds an alert on everything and creates alert fatigue.

---
