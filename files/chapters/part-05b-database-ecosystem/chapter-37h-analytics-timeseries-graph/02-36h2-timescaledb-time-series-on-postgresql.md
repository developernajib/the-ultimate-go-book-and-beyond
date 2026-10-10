## 37H.2 TimescaleDB: Time-Series on PostgreSQL

### Hypertable and Continuous Aggregates

TimescaleDB turns a regular PostgreSQL table into a **hypertable** by partitioning it into time-ordered chunks behind the scenes. Each chunk is a separate physical table, so queries with a `WHERE time >= ...` predicate skip irrelevant chunks entirely (a process Timescale calls *chunk exclusion*). On top of this, continuous aggregates pre-compute windowed statistics (hourly averages, daily counts) and refresh incrementally, only recomputing buckets that received new data - changes to the underlying hypertable are tracked so the aggregate stays consistent without a full recompute. Chunks older than a configurable threshold are converted into TimescaleDB's **columnstore** format (columnar compressed storage, often 90-98% size reduction on time-series data) while remaining queryable via the same SQL. The SQL below creates a metrics hypertable with compression, retention, and a continuous aggregate for hourly rollups.

```sql
-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Metrics hypertable: partitioned by time automatically
CREATE TABLE metrics (
    time        TIMESTAMPTZ NOT NULL,
    device_id   VARCHAR(64) NOT NULL,
    metric_name VARCHAR(64) NOT NULL,
    value       DOUBLE PRECISION NOT NULL,
    tags        JSONB DEFAULT '{}'
);

-- Convert to hypertable: auto-partitions into "chunks" by time
SELECT create_hypertable('metrics', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Composite index for device + time range queries
CREATE INDEX ON metrics (device_id, time DESC);
CREATE INDEX ON metrics USING GIN (tags);

-- Compression policy: compress chunks older than 7 days
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, metric_name'
);
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Retention policy: drop data older than 1 year
SELECT add_retention_policy('metrics', INTERVAL '1 year');

-- Continuous aggregate: pre-compute hourly stats
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    metric_name,
    avg(value) AS avg_val,
    min(value) AS min_val,
    max(value) AS max_val,
    count(*) AS sample_count,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
FROM metrics
GROUP BY bucket, device_id, metric_name
WITH NO DATA;

-- Refresh policy for continuous aggregate
SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
```

### Go TimescaleDB Client

Because TimescaleDB is a PostgreSQL extension, any Go PostgreSQL driver (`lib/pq`, `pgx`) works without modification. The repository below uses `unnest` for bulk inserts (10-50x faster than individual `INSERT` statements), queries pre-computed continuous aggregates for dashboard reads, and runs a z-score anomaly detection query that compares recent values against a historical baseline using window functions.

```go
package timescaledb

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/lib/pq"
)

// MetricRepository handles time-series metrics
type MetricRepository struct {
	db  *sql.DB
	log *slog.Logger
}

// Metric represents a time-series data point
type Metric struct {
	Time       time.Time              `db:"time"`
	DeviceID   string                 `db:"device_id"`
	MetricName string                 `db:"metric_name"`
	Value      float64                `db:"value"`
	Tags       map[string]string      `db:"tags"`
}

// BulkInsert inserts metrics using COPY protocol for maximum throughput
func (r *MetricRepository) BulkInsert(ctx context.Context, metrics []Metric) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Use unnest for bulk insert (10-50x faster than individual inserts)
	// Build arrays for unnest
	times := make([]time.Time, len(metrics))
	deviceIDs := make([]string, len(metrics))
	metricNames := make([]string, len(metrics))
	values := make([]float64, len(metrics))
	tags := make([][]byte, len(metrics))

	for i, m := range metrics {
		times[i] = m.Time
		deviceIDs[i] = m.DeviceID
		metricNames[i] = m.MetricName
		values[i] = m.Value
		tags[i] = marshalTags(m.Tags)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO metrics (time, device_id, metric_name, value, tags)
		SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::float8[], $5::jsonb[])
		ON CONFLICT DO NOTHING
	`, pq.Array(times), pq.Array(deviceIDs), pq.Array(metricNames),
		pq.Array(values), pq.Array(tags))

	if err != nil {
		return fmt.Errorf("bulk insert: %w", err)
	}

	return tx.Commit()
}

// QueryRange retrieves raw metrics for a device and time range
func (r *MetricRepository) QueryRange(ctx context.Context, deviceID, metricName string, from, to time.Time) ([]Metric, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT time, device_id, metric_name, value, tags
		FROM metrics
		WHERE device_id = $1
		  AND metric_name = $2
		  AND time BETWEEN $3 AND $4
		ORDER BY time ASC
	`, deviceID, metricName, from, to)
	if err != nil {
		return nil, fmt.Errorf("query range: %w", err)
	}
	defer rows.Close()

	var metrics []Metric
	for rows.Next() {
		var m Metric
		var tagsJSON []byte
		if err := rows.Scan(&m.Time, &m.DeviceID, &m.MetricName, &m.Value, &tagsJSON); err != nil {
			return nil, err
		}
		m.Tags = unmarshalTags(tagsJSON)
		metrics = append(metrics, m)
	}
	return metrics, rows.Err()
}

// QueryHourlyAggregates retrieves pre-computed hourly stats
func (r *MetricRepository) QueryHourlyAggregates(ctx context.Context, deviceID, metricName string, from, to time.Time) ([]HourlyStats, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT bucket, avg_val, min_val, max_val, p95, sample_count
		FROM metrics_hourly
		WHERE device_id = $1
		  AND metric_name = $2
		  AND bucket BETWEEN $3 AND $4
		ORDER BY bucket ASC
	`, deviceID, metricName, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []HourlyStats
	for rows.Next() {
		var s HourlyStats
		if err := rows.Scan(&s.Bucket, &s.AvgVal, &s.MinVal, &s.MaxVal, &s.P95, &s.Count); err != nil {
			return nil, err
		}
		stats = append(stats, s)
	}
	return stats, rows.Err()
}

// TimeseriesQuery runs an arbitrary time-bucketed query
func (r *MetricRepository) TimeseriesQuery(ctx context.Context, deviceID string, interval time.Duration, from, to time.Time) ([]BucketedMetric, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			time_bucket($1::interval, time) AS bucket,
			metric_name,
			avg(value) AS avg_value,
			max(value) AS max_value,
			min(value) AS min_value
		FROM metrics
		WHERE device_id = $2
		  AND time BETWEEN $3 AND $4
		GROUP BY bucket, metric_name
		ORDER BY bucket ASC, metric_name ASC
	`, fmt.Sprintf("%ds", int(interval.Seconds())), deviceID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []BucketedMetric
	for rows.Next() {
		var b BucketedMetric
		if err := rows.Scan(&b.Bucket, &b.MetricName, &b.AvgValue, &b.MaxValue, &b.MinValue); err != nil {
			return nil, err
		}
		results = append(results, b)
	}
	return results, rows.Err()
}

// AnomalyDetection uses window functions to detect anomalies
func (r *MetricRepository) DetectAnomalies(ctx context.Context, deviceID, metricName string, since time.Time, stddevThreshold float64) ([]Anomaly, error) {
	rows, err := r.db.QueryContext(ctx, `
		WITH stats AS (
			SELECT
				avg(value) AS mean,
				stddev(value) AS std
			FROM metrics
			WHERE device_id = $1 AND metric_name = $2
			  AND time >= $3 - INTERVAL '1 day'  -- use historical window for stats
			  AND time < $3
		),
		recent AS (
			SELECT time, value
			FROM metrics
			WHERE device_id = $1 AND metric_name = $2
			  AND time >= $3
		)
		SELECT
			r.time,
			r.value,
			s.mean,
			s.std,
			abs(r.value - s.mean) / NULLIF(s.std, 0) AS z_score
		FROM recent r, stats s
		WHERE abs(r.value - s.mean) / NULLIF(s.std, 0) > $4
		ORDER BY z_score DESC
		LIMIT 100
	`, deviceID, metricName, since, stddevThreshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var anomalies []Anomaly
	for rows.Next() {
		var a Anomaly
		if err := rows.Scan(&a.Time, &a.Value, &a.Mean, &a.StdDev, &a.ZScore); err != nil {
			return nil, err
		}
		anomalies = append(anomalies, a)
	}
	return anomalies, rows.Err()
}

type HourlyStats struct {
	Bucket  time.Time
	AvgVal  float64
	MinVal  float64
	MaxVal  float64
	P95     float64
	Count   int64
}

type BucketedMetric struct {
	Bucket     time.Time
	MetricName string
	AvgValue   float64
	MaxValue   float64
	MinValue   float64
}

type Anomaly struct {
	Time   time.Time
	Value  float64
	Mean   float64
	StdDev float64
	ZScore float64
}

func marshalTags(tags map[string]string) []byte {
	if len(tags) == 0 {
		return []byte("{}")
	}
	b, _ := json.Marshal(tags)
	return b
}

func unmarshalTags(data []byte) map[string]string {
	var tags map[string]string
	json.Unmarshal(data, &tags)
	return tags
}
```

### Junior → FAANG: the mental model for your first TimescaleDB project

TimescaleDB is a Postgres extension, not a separate database. That single fact is the entire pitch. Your existing Postgres driver works. Your existing connection pooler works. `pg_dump` works. Your ORM works (with caveats on partitioned tables). The trick is the `create_hypertable` call, which silently turns a regular table into a partitioned table where each partition (called a chunk) holds a time range of rows. When you `INSERT`, Timescale routes to the correct chunk. When you `SELECT` with a time predicate, the planner prunes unrelated chunks. That is the whole foundation.

The most common junior mistake is picking a chunk interval that is either too large or too small. Too large (say one year per chunk on a 10GB per day firehose) and chunks grow past the working set of RAM, which kills index performance because btree random access thrashes. Too small (one hour per chunk on a 10 rows per minute trickle) and you get thousands of empty chunks and the planner pays a tax on every query. The rule of thumb is that the most recent chunk should fit in 25 percent of `shared_buffers`. For a box with 32GB RAM and `shared_buffers=8GB`, target 2GB chunks. If your ingest rate is 200MB per day, that is a 10 day interval. `SELECT set_chunk_time_interval('metrics', INTERVAL '10 days')` adjusts future chunks. Existing chunks keep their old interval.

Worked example to internalize on day one. Create a hypertable `metrics(ts TIMESTAMPTZ, device_id INT, value DOUBLE PRECISION)`. Load a month of data at 1000 rows per second per device for 100 devices. Run `SELECT time_bucket('5 minutes', ts) AS b, device_id, avg(value) FROM metrics WHERE ts > now() - INTERVAL '1 day' GROUP BY b, device_id`. Time it. Now create a continuous aggregate on the same query with a refresh policy. Run the same query against the materialized view. It will be two orders of magnitude faster. Then enable compression on chunks older than seven days. Watch disk usage drop 10x. Those three commands (hypertable, continuous aggregate, compression policy) are 80 percent of what a junior Timescale engineer does.

For interviews at shops running TimescaleDB (observability platforms, IoT, fintech, Grafana users), expect questions like: what is the difference between a hypertable and a regular partitioned table, what is a continuous aggregate and when does it go stale, why is compression columnar even though Postgres is a row store, and when would you pick TimescaleDB over ClickHouse. The last one trips up many candidates. The honest answer is: pick TimescaleDB when you need SQL joins with relational metadata, full Postgres tooling, and sub terabyte scale. Pick ClickHouse when you need billions of rows scanned per second and you can live without joins and transactions.

### Senior @ FAANG: hypertables, continuous aggregates, compression internals, and the 2026 Timescale shape

The staff level conversation about TimescaleDB in 2026 is shaped by three recent shifts. First, distributed hypertables (the old multi node Timescale) were deprecated in favor of Timescale Cloud, which handles scale out behind a managed control plane. If you are on self hosted 2.14+ planning a new multi node deployment, stop. Either stay single node and scale vertically, or move to Timescale Cloud, or pick a different engine. Second, the OSS 2.14+ added data tiering to S3, which lets self hosted deployments keep hot chunks on local disk and cold chunks in object storage. This is closer to the ClickHouse shared storage model and is the direction the project is moving. Third, the hyperfunctions extension has matured enough that statistical aggregates (percentile_agg, counter_agg, time_weight, gapfill) cover most observability and finance use cases without custom UDFs.

Hypertable internals. A hypertable is a logical view over many chunks. Each chunk is a regular Postgres table with a CHECK constraint on the time column. Insert routing happens in a BEFORE INSERT trigger. Chunk exclusion at query time uses Postgres constraint exclusion, which means the planner must see a literal or stable expression in the WHERE clause to prune. `WHERE ts > now() - INTERVAL '1 day'` prunes correctly because `now()` is stable within a query. `WHERE ts > (SELECT max(ts) FROM other_table)` does not prune because the subquery is not stable. Knowing this saves hours of debugging slow queries that "should" be fast.

Space partitioning is the second dimension. You can create a hypertable with `create_hypertable('metrics', 'ts', 'device_id', number_partitions=>4)`, which hash partitions by device_id within each time chunk. This is useful when a single time chunk is too large for one disk or when you want parallel scans across devices. In 2026 the guidance is to avoid space partitioning unless you have a specific reason, because it complicates chunk management and rarely helps on a single node.

Continuous aggregates. The 2026 model distinguishes real time aggregates (the default) from materialized only aggregates. A real time aggregate returns a UNION of the materialized view plus a live query against the source for the unrefreshed tail. This gives you up to date answers at the cost of a small runtime query on the tail. A materialized only aggregate (`WITH (timescaledb.materialized_only = true)`) skips the live tail, which is faster but can lag by the refresh interval. Pick real time for dashboards that must show the last minute. Pick materialized only for reports where yesterday is good enough. Continuous aggregates can also be compressed and tiered to S3, just like regular chunks.

Compression internals are where TimescaleDB diverges most from stock Postgres. When a chunk is compressed, rows are reorganized into a columnar layout using segment by and order by columns. Rows with the same segment by value are grouped, and each column becomes a compressed array using gorilla for floats, delta of delta for timestamps, and LZ4 or zstd for generic payloads. Compression ratios of 10x to 20x are typical. The tradeoff is that compressed chunks are read mostly. Updates and deletes on compressed chunks are supported (since 2.11) but slower than on uncompressed chunks. The right pattern is to compress chunks after they fall out of the active write window, typically 7 or 14 days behind head.

Data tiering to S3 (OSS 2.14+) lets you attach a tiered storage policy that moves chunks to object storage once they pass an age threshold. Queries against tiered chunks pay a cold read cost but the data is still queryable through the same hypertable. This is the self hosted answer to the lakehouse pattern. Combine tiering with materialized continuous aggregates on local disk and you get a hot aggregate tier plus a cold raw tier, which is the exact shape observability platforms like Grafana Cloud use internally.

Comparison matrix for a 2026 design review. TimescaleDB versus InfluxDB v3: Timescale wins on SQL and relational joins, Influx v3 wins on ingest rate and Parquet native cold storage. Timescale versus Prometheus: different tools, Prometheus for ephemeral infra metrics with PromQL, Timescale for durable application and business metrics. Timescale versus VictoriaMetrics: VictoriaMetrics is a Prometheus compatible long term store with better compression and lower cost, Timescale is a richer query layer. Timescale versus ClickHouse: Timescale for joins and SQL ergonomics under 10TB, ClickHouse above. Timescale versus QuestDB: QuestDB is faster at raw ingest with a different SQL dialect, smaller ecosystem, pick it only if ingest rate is the bottleneck. Timescale versus Grafana Mimir and Thanos: Mimir and Thanos are horizontally scalable Prometheus backends, not general time series databases, pick them when you need a Prometheus compatible long term tier at million series scale.

Operational discipline at scale. Set `max_worker_processes` high enough for parallel chunk scans (at least `cpus * 2`). Tune `timescaledb.max_background_workers` separately for policy jobs (compression, refresh, retention). Monitor `timescaledb_information.job_stats` and alert on failed or slow jobs. Use `SELECT add_retention_policy` for data retention rather than manual DELETE, because the policy drops entire chunks which is O(1) versus O(rows) for DELETE. Never run `VACUUM FULL` on a large hypertable in production, run `SELECT reorder_chunk` per chunk instead. And always test upgrades on a restored backup first, because Timescale extension upgrades occasionally require catalog rewrites that can take hours on large hypertables.

---
