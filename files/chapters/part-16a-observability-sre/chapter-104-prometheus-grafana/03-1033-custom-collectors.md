## 104.3 Custom Collectors

### Implementing Custom Collector

Custom Prometheus collectors implement the `Collector` interface to expose metrics that cannot be instrumented inline, such as data from third-party processes or OS-level statistics. `DatabaseCollector` queries `sql.DB.Stats()` on every `Collect` call, pulling open connections, in-use, idle, wait count, and wait duration, and yields each as a `prometheus.MustNewConstMetric`, which means the values are always current at scrape time rather than being stale counters incremented in application code.

```go
package metrics

import (
    "database/sql"

    "github.com/prometheus/client_golang/prometheus"
)

// DatabaseCollector collects metrics from a database
type DatabaseCollector struct {
    db *sql.DB

    // Metric descriptors
    openConnections *prometheus.Desc
    inUse           *prometheus.Desc
    idle            *prometheus.Desc
    waitCount       *prometheus.Desc
    waitDuration    *prometheus.Desc
    maxOpenConns    *prometheus.Desc
    tableRows       *prometheus.Desc
}

func NewDatabaseCollector(db *sql.DB, dbName string) *DatabaseCollector {
    labels := prometheus.Labels{"database": dbName}

    return &DatabaseCollector{
        db: db,
        openConnections: prometheus.NewDesc(
            "db_connections_open",
            "Number of open connections",
            nil, labels,
        ),
        inUse: prometheus.NewDesc(
            "db_connections_in_use",
            "Number of connections in use",
            nil, labels,
        ),
        idle: prometheus.NewDesc(
            "db_connections_idle",
            "Number of idle connections",
            nil, labels,
        ),
        waitCount: prometheus.NewDesc(
            "db_connections_wait_total",
            "Total number of connections waited for",
            nil, labels,
        ),
        waitDuration: prometheus.NewDesc(
            "db_connections_wait_duration_seconds_total",
            "Total time waited for connections",
            nil, labels,
        ),
        maxOpenConns: prometheus.NewDesc(
            "db_connections_max_open",
            "Maximum number of open connections",
            nil, labels,
        ),
        tableRows: prometheus.NewDesc(
            "db_table_rows",
            "Approximate number of rows in table",
            []string{"table"}, labels,
        ),
    }
}

// Describe implements prometheus.Collector
func (c *DatabaseCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- c.openConnections
    ch <- c.inUse
    ch <- c.idle
    ch <- c.waitCount
    ch <- c.waitDuration
    ch <- c.maxOpenConns
    ch <- c.tableRows
}

// Collect implements prometheus.Collector
func (c *DatabaseCollector) Collect(ch chan<- prometheus.Metric) {
    stats := c.db.Stats()

    ch <- prometheus.MustNewConstMetric(c.openConnections, prometheus.GaugeValue, float64(stats.OpenConnections))
    ch <- prometheus.MustNewConstMetric(c.inUse, prometheus.GaugeValue, float64(stats.InUse))
    ch <- prometheus.MustNewConstMetric(c.idle, prometheus.GaugeValue, float64(stats.Idle))
    ch <- prometheus.MustNewConstMetric(c.waitCount, prometheus.CounterValue, float64(stats.WaitCount))
    ch <- prometheus.MustNewConstMetric(c.waitDuration, prometheus.CounterValue, stats.WaitDuration.Seconds())
    ch <- prometheus.MustNewConstMetric(c.maxOpenConns, prometheus.GaugeValue, float64(stats.MaxOpenConnections))

    // Collect table row counts
    c.collectTableRows(ch)
}

func (c *DatabaseCollector) collectTableRows(ch chan<- prometheus.Metric) {
    // Fixed allowlist of table names. Never build this list from user input:
    // identifiers cannot be parameterized, so concatenation is only safe
    // with hardcoded values.
    tables := []string{"users", "orders", "products"}

    for _, table := range tables {
        var count int64
        err := c.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count)
        if err != nil {
            continue
        }
        ch <- prometheus.MustNewConstMetric(c.tableRows, prometheus.GaugeValue, float64(count), table)
    }
}

// Register the collector
func RegisterDatabaseCollector(db *sql.DB, dbName string) {
    collector := NewDatabaseCollector(db, dbName)
    prometheus.MustRegister(collector)
}
```

### Pull-on-Scrape vs Push-on-Event: Asynchronous Queue Collectors

In high-throughput distributed workers, engineers often debate whether to update Prometheus metrics inline on every event (`push-on-event`) or compute them lazily when Prometheus scrapes (`pull-on-scrape`). As examined in production post-mortems (such as [Building a Custom Exporter for Prometheus in Go](https://medium.com/@author/building-a-custom-exporter-for-prometheus-in-go) by Erwin Hermanto), updating gauges inline on every queue push and pop introduces severe lock contention and network latency directly into the critical hot path.

#### Architectural Comparison

```
Push-on-Event (Anti-pattern for Queue Depths):
Worker Loop ──► Enqueue ──► Acquire Gauge Lock / Query Redis ──► Write Latency Inflated!

Pull-on-Scrape (Custom Collector):
Worker Loop ──► Enqueue (Zero Telemetry Overhead on Hot Path)
                             ▲
Prometheus Scrape (/metrics) ─┴─► Collect() lazily samples queue backend
```

When queue depth or worker backlog lives in an external broker (Redis, RabbitMQ, Kafka) or an in-memory priority queue, computing values lazily inside a custom `prometheus.Collector` decouples observability overhead from business execution:

```go
package worker

import (
	"context"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// QueueMetricsSource abstracts the underlying queue storage
type QueueMetricsSource interface {
	GetQueueDepths(ctx context.Context) (map[string]int64, error)
}

// QueueCollector exposes queue depths across priority tiers
type QueueCollector struct {
	source     QueueMetricsSource
	queueDepth *prometheus.Desc

	// Scrape cache to prevent thundering herd under Prometheus federation
	mu       sync.RWMutex
	cache    map[string]int64
	cachedAt time.Time
	cacheTTL time.Duration
}

func NewQueueCollector(source QueueMetricsSource, ttl time.Duration) *QueueCollector {
	return &QueueCollector{
		source: source,
		cacheTTL: ttl,
		queueDepth: prometheus.NewDesc(
			"worker_queue_pending_jobs",
			"Current number of pending unprocessed jobs per queue category.",
			[]string{"queue", "priority"}, // Bounded categorical labels
			nil,
		),
	}
}

func (c *QueueCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.queueDepth
}

func (c *QueueCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	if time.Since(c.cachedAt) < c.cacheTTL && c.cache != nil {
		for q, depth := range c.cache {
			ch <- prometheus.MustNewConstMetric(c.queueDepth, prometheus.GaugeValue, float64(depth), q, "normal")
		}
		c.mu.RUnlock()
		return
	}
	c.mu.RUnlock()

	// Refresh cache within bounded timeout
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	depths, err := c.source.GetQueueDepths(ctx)
	if err != nil {
		// On error, emit previously cached values or drop rather than stalling scrape
		return
	}

	c.mu.Lock()
	c.cache = depths
	c.cachedAt = time.Now()
	c.mu.Unlock()

	for q, depth := range depths {
		ch <- prometheus.MustNewConstMetric(c.queueDepth, prometheus.GaugeValue, float64(depth), q, "normal")
	}
}
```

#### The Cardinality Trap & Combinatorial Explosion Formula

The primary failure mode in custom Prometheus collectors is adding dynamic entity identifiers as labels. If an engineer adds `job_id`, `user_id`, or `order_id` to a metric descriptor under the assumption that it simplifies debugging stuck jobs:

```text
Total Series = Metric Count × (|L_1| × |L_2| × ... × |L_k|)
```

Where `|L_i|` represents the cardinality (number of distinct values) of label `i`.
- With bounded labels (`queue` = 4 values, `priority` = 3 values): `4 × 3 = 12` active time series.
- If `job_id` is introduced (500,000 jobs processed per day): `4 × 3 × 500,000 = 6,000,000` distinct time series written to the Prometheus TSDB.

In production, this cardinality explosion rapidly exhausts TSDB memory (head chunk allocations), triples Prometheus RAM consumption within days, and degrades PromQL evaluation latency from milliseconds to timeouts.

**The Golden Label Rule**: Labels define bounded categories (`queue`, `status`, `region`, `priority`). Unbounded identities (`job_id`, `trace_id`, `request_id`) belong strictly to structured logs and distributed trace spans.

### Junior → FAANG: When to Build a Custom Collector

Most metrics can be registered as `prometheus.Counter`, `prometheus.Gauge`, or `prometheus.Histogram` and updated inline in your code. Custom collectors are for metrics that can only be computed at scrape time, not continuously updated: database connection pool stats, Go runtime stats, OS-level resource usage, or any metric derived from an external query.

The `Collector` interface requires two methods: `Describe()` returns metric descriptors, and `Collect()` returns current metric values. The key constraint: `Collect()` is called on every Prometheus scrape, so it must be fast. If `Collect()` makes a slow database query, every scrape introduces latency into the Prometheus scrape pipeline and can cause scrape timeouts.

Interview entry point: "What is the difference between a Gauge and a custom Collector?" A Gauge is updated by your application code as events occur. A custom Collector computes the metric value at scrape time. Use a Gauge when the value changes frequently and you update it in your business logic. Use a custom Collector when the metric value must be freshly computed on demand.

### Senior @ FAANG: Custom Collector Design, Scrape Performance, and Caching

**Scrape latency budget.** Prometheus has a configurable scrape timeout (default 10 seconds). If your `/metrics` endpoint takes longer than this to respond, Prometheus marks the scrape as failed and the metric gap appears as a break in your graphs. A custom collector that queries a database must complete within the remaining scrape budget after other collectors have run. At scale, the platform team sets a scrape latency SLO of 1 second for the metrics endpoint, and any collector that regularly exceeds 100ms is investigated and optimized.

**Caching in custom collectors.** For collectors that derive metrics from expensive operations (database queries, external API calls), implement a TTL cache: store the last computed values in memory and return the cached values unless the cache is stale. The cache TTL should be shorter than the Prometheus scrape interval to ensure freshness, but long enough to avoid a database query on every scrape. A 15-second TTL with a 30-second scrape interval is a common configuration.

**Parallel collection and goroutine safety.** The `Collect()` method may be called concurrently if multiple Prometheus federating servers scrape the same endpoint simultaneously. All custom collectors must be goroutine-safe: use `sync.RWMutex` or `sync.Map` for shared state, and never modify slice or map values inside `Collect()` without holding a lock. The platform team's shared collector template includes a mutex and a caching layer as defaults, preventing race conditions in custom collector implementations.

---
