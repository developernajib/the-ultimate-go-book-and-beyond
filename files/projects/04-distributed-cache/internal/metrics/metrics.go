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
