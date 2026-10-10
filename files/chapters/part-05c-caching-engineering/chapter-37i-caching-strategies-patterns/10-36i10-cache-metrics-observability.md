## 37I.10 Cache Metrics & Observability

### Hit Rate Tracking

`CacheMetricsCollector` registers four Prometheus instruments (hit counter, miss counter, latency histogram, and error counter) labeled by cache layer so dashboards can compare L1 in-process versus L2 Redis performance side-by-side. The `atomic.Int64` hit and miss fields allow lock-free reads for computing the instantaneous hit ratio without querying Prometheus, which is useful for adaptive TTL logic that needs the ratio on the hot path.

```go
package cache

import (
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// CacheMetricsCollector tracks cache performance
type CacheMetricsCollector struct {
	hits    prometheus.Counter
	misses  prometheus.Counter
	latency prometheus.Histogram
	errors  prometheus.Counter
	// atomic counters for fast access
	hitCount  atomic.Int64
	missCount atomic.Int64
}

// NewCacheMetricsCollector creates Prometheus metrics for a cache layer
func NewCacheMetricsCollector(layer string) *CacheMetricsCollector {
	return &CacheMetricsCollector{
		hits: promauto.NewCounter(prometheus.CounterOpts{
			Name: "cache_hits_total",
			Help: "Total cache hits",
			ConstLabels: prometheus.Labels{"layer": layer},
		}),
		misses: promauto.NewCounter(prometheus.CounterOpts{
			Name: "cache_misses_total",
			Help: "Total cache misses",
			ConstLabels: prometheus.Labels{"layer": layer},
		}),
		latency: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "cache_operation_duration_seconds",
			Help:    "Cache operation latency",
			Buckets: []float64{0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1},
			ConstLabels: prometheus.Labels{"layer": layer},
		}),
		errors: promauto.NewCounter(prometheus.CounterOpts{
			Name: "cache_errors_total",
			Help: "Total cache errors",
			ConstLabels: prometheus.Labels{"layer": layer},
		}),
	}
}

func (m *CacheMetricsCollector) RecordHit(key string) {
	m.hits.Inc()
	m.hitCount.Add(1)
}

func (m *CacheMetricsCollector) RecordMiss(key string) {
	m.misses.Inc()
	m.missCount.Add(1)
}

func (m *CacheMetricsCollector) RecordLatency(start time.Time) {
	m.latency.Observe(time.Since(start).Seconds())
}

func (m *CacheMetricsCollector) HitRate() float64 {
	hits := m.hitCount.Load()
	total := hits + m.missCount.Load()
	if total == 0 {
		return 0
	}
	return float64(hits) / float64(total)
}
```

### Junior to FAANG: Cache Observability Entry Point

Before you learn dashboards, learn the four numbers every cache operator memorizes. Hit rate tells you whether the cache is earning its keep. Miss rate alone is not enough because misses have taxonomy. A miss is either `absent` (first lookup ever), `expired` (TTL elapsed), `evicted` (LRU or LFU pushed it out under memory pressure), or `invalidated` (app explicitly deleted it). If you cannot separate these on a dashboard, you cannot diagnose a hit-rate drop. A stampede from TTL expiry looks identical to eviction pressure on a scalar miss counter, and the remediation is opposite. TTL jitter fixes expiry storms. More memory fixes eviction storms.

Worked example for your first on-call page. Alert fires: `cache_hit_rate` dropped from 0.94 to 0.71 over ten minutes on the `user_profile` namespace. Junior reflex is to restart Redis. Correct reflex is to pull up the miss reason histogram. If `evicted` spiked, check `redis_memory_used_bytes` against `maxmemory`. A deploy may have inflated payload size or a new caller wrote a hot range of keys. If `expired` spiked, check whether upstream added a cron that invalidates at the top of the hour, synchronizing TTLs across a million keys. If `absent` spiked, something upstream is generating new cache keys, probably a bad cache-key function that now includes a timestamp or request ID.

First-job context. Your team owns a service. The cache is either in-process (freecache, ristretto, bigcache) or shared (Redis, Memcached). For in-process caches, export hit rate, size in bytes, entry count, and eviction rate to Prometheus. For shared caches, also export operation latency per command (GET p50, p99, p999), connection-pool saturation, and circuit-breaker state. Do not emit per-key labels. That is the classic cardinality explosion that kills Prometheus. Label by namespace and operation, never by key. High-cardinality histograms belong in a separate system such as ClickHouse or Honeycomb.

Interview entry point. Expect: "How would you instrument a cache layer?" Score well by walking the four RED signals (Rate, Errors, Duration) plus cache-specific signals (Hit Rate, Eviction Rate, Memory). Mention OTEL spans wrapping `Get` and `Set` so cache misses show up in distributed traces, not just in isolated counters. A miss that triggers a 200ms database query should appear as a child span of the request, which is how you prove the cache is actually the bottleneck.

### Senior at FAANG: Observability as a Governance Surface

At staff level, cache observability is not a dashboard. It is a contract between platform and product teams, enforced through a maturity model and an ADR trail. Below is the model we deploy for a multi-tenant cache platform at FAANG scale.

Maturity model L1 to L5. L1 teams export only hit rate and call it done. L2 teams add miss-reason taxonomy (`absent`, `expired`, `evicted`, `invalidated`) and per-namespace labels, so a noisy tenant cannot mask a quiet one. L3 teams add RED per operation (GET, SET, DEL, MGET, SCAN) with p50, p95, p99, p999 histograms, plus connection-pool saturation and circuit-breaker state. They correlate cache spans with upstream request traces via OTEL. L4 teams instrument big-key detection (histogram of value sizes per namespace, alerting when p99 crosses 100 KB) and hot-key detection (count-min sketch over keys in a sliding window, alerting when top-K concentration exceeds a threshold). L5 teams close the loop: observability feeds admission-control. If `eviction_rate` crosses a threshold, the platform rejects low-priority writes. If a big-key is detected, the platform auto-shards or rejects further writes with a structured error that the owning team sees in their service dashboard within 60 seconds.

ADR template for new cache namespaces. Every namespace onboarded to the shared Redis or Memcached pool files an ADR that answers: owning team, SLO for hit rate, expected p99 GET latency, expected value-size p99, TTL policy and jitter strategy, invalidation pattern, eviction policy on memory pressure, runbook link for hit-rate drops, and blast radius if this namespace evicts everything else. Without this ADR, the namespace cannot be created. This is how you prevent one team's `session_debug` cache from pushing another team's `feature_flag` cache out of memory at 3 a.m.

OTEL instrumentation details. Wrap every cache call in a span with semantic attributes: `cache.system` (redis, memcached, ristretto), `cache.namespace`, `cache.operation`, `cache.hit` (bool), `cache.miss_reason` (enum), `cache.key_hash` (never the raw key, use xxhash). Export spans at 1 percent sampling on hits and 100 percent on misses, so your trace store is not drowning in cheap hits but you still capture every expensive miss. Link spans to the parent HTTP or gRPC span so a request-level flamegraph shows the cache miss as a visible wedge. The Datadog and Prometheus exporters both consume OTEL natively in the 2025+ stack, which means you write instrumentation once and switch backends without touching code.

Big-key and hot-key governance. Big keys (values over 100 KB) burn network and block Redis on serialize. Hot keys (single keys taking >10 percent of GET traffic) break sharding because one shard cannot be scaled. Detection is a platform concern, not a team concern. Run a sidecar that samples 1 percent of keys, maintains a count-min sketch, and emits `cache_hotkey_detected{namespace, key_hash}` when concentration crosses threshold. Pair with automated remediation playbooks: replicate to follower replicas, fan out via L1 ristretto mirrors, or notify the owning team through a ticket that includes the offending key hash and traffic profile.

Dashboards that staff engineers actually build. Tier-1 dashboard: aggregate hit rate, memory utilization, and eviction rate across all namespaces, with a heatmap of namespace-level hit rate sorted by traffic. Tier-2 dashboard per namespace: RED per operation, miss-reason breakdown, value-size distribution, top-K keys by request rate, TTL distribution. Tier-3 dashboard: correlation view. Overlay cache miss rate against upstream p99, database QPS, and error rate. This is the view an incident commander uses at 2 a.m. to prove that a cache miss storm (not a database regression) is driving latency.

Governance anti-patterns to refuse. Do not accept new namespaces without TTL. Do not accept cache-as-source-of-truth designs. Do not accept unbounded key-space designs. Do not accept label cardinality greater than 1000 per metric. These are the hills on which staff engineers die, because fixing them after launch costs 10x more than refusing them at review.

---
