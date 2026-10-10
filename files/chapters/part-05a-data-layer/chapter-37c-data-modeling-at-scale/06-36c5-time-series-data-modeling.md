## 37C.5 Time-Series Data Modeling

### Why Regular Tables Are Bad for Time-Series

A naive metrics table:

```sql
CREATE TABLE metrics (
    id         bigserial PRIMARY KEY,
    name       text NOT NULL,
    value      float8 NOT NULL,
    timestamp  timestamptz NOT NULL,
    labels     jsonb
);
```

Problems at scale:
- Table grows unboundedly (Prometheus writes millions of data points per day)
- `DELETE FROM metrics WHERE timestamp < now() - interval '30 days'` is slow and creates dead tuples
- Time-range queries do full index scans because old and new data intermingle
- No efficient downsampling (rolling up per-minute data to per-hour)

### TimescaleDB Hypertables

TimescaleDB extends PostgreSQL with automatic time-based partitioning (chunks):

```sql
-- Create a regular table first
CREATE TABLE cpu_metrics (
    time       timestamptz NOT NULL,
    host       text NOT NULL,
    cpu_pct    float8 NOT NULL,
    mem_pct    float8 NOT NULL
);

-- Convert to hypertable (partition by time, 1-week chunks)
SELECT create_hypertable('cpu_metrics', 'time', chunk_time_interval => INTERVAL '1 week');

-- Index on (host, time) for per-host queries
CREATE INDEX idx_cpu_host_time ON cpu_metrics (host, time DESC);

-- Compression policy: compress chunks older than 1 month
ALTER TABLE cpu_metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'host'
);

SELECT add_compression_policy('cpu_metrics', INTERVAL '1 month');

-- Retention policy: drop data older than 1 year
SELECT add_retention_policy('cpu_metrics', INTERVAL '1 year');
```

With the hypertable configured, time-range queries become efficient because TimescaleDB scans only the chunks that overlap the requested interval. The `time_bucket` function groups data into fixed-width time windows, which is the most common aggregation pattern for dashboards and alerting.

```sql

-- Average CPU per host over last 24 hours, 5-minute buckets
SELECT
    time_bucket('5 minutes', time) AS bucket,
    host,
    avg(cpu_pct) AS avg_cpu,
    max(cpu_pct) AS max_cpu
FROM cpu_metrics
WHERE time > now() - INTERVAL '24 hours'
GROUP BY bucket, host
ORDER BY host, bucket;
```

### ClickHouse Columnar Storage

ClickHouse is purpose-built for analytical time-series queries on large datasets:

```sql
-- ClickHouse table
CREATE TABLE events (
    timestamp   DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    properties  String,  -- JSON
    date        Date MATERIALIZED toDate(timestamp)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (event_type, user_id, timestamp);

-- Aggregated materialized view (updated on insert)
CREATE MATERIALIZED VIEW event_counts_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (event_type, hour)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    event_type,
    count() AS count
FROM events
GROUP BY hour, event_type;
```

ClickHouse query performance for analytical workloads is typically 10-100x faster than PostgreSQL for the same data at scale.

### Native PostgreSQL Time-Series Partitioning

Without TimescaleDB, use declarative table partitioning:

```sql
-- Partitioned table
CREATE TABLE events (
    id         bigserial,
    event_type text NOT NULL,
    payload    jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE events_2024_01
    PARTITION OF events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE events_2024_02
    PARTITION OF events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Automate partition creation
CREATE OR REPLACE PROCEDURE create_monthly_partition(year int, month int)
LANGUAGE plpgsql AS $$
DECLARE
    start_date date := make_date(year, month, 1);
    end_date   date := start_date + INTERVAL '1 month';
    table_name text := format('events_%s_%s', year, lpad(month::text, 2, '0'));
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
        table_name, start_date, end_date
    );
END;
$$;

-- Drop old partitions for retention (instant, no vacuum needed)
DROP TABLE events_2023_01;
```

### Go: Writing Time-Series Data Efficiently

Batch inserts are critical for time-series write performance:

```go
package timeseries

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type MetricPoint struct {
    Time    time.Time
    Host    string
    CPUPct  float64
    MemPct  float64
}

type MetricsWriter struct {
    db        *pgxpool.Pool
    buffer    []MetricPoint
    bufSize   int
    flushCh   chan struct{}
    writeCh   chan MetricPoint
}

func NewMetricsWriter(db *pgxpool.Pool, bufSize int) *MetricsWriter {
    w := &MetricsWriter{
        db:      db,
        bufSize: bufSize,
        flushCh: make(chan struct{}),
        writeCh: make(chan MetricPoint, bufSize*2),
    }
    go w.runBatchWriter()
    return w
}

func (w *MetricsWriter) Write(ctx context.Context, m MetricPoint) {
    select {
    case w.writeCh <- m:
    case <-ctx.Done():
    }
}

func (w *MetricsWriter) runBatchWriter() {
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    var batch []MetricPoint

    flush := func() {
        if len(batch) == 0 {
            return
        }
        if err := w.batchInsert(context.Background(), batch); err != nil {
            // handle error: push to dead letter queue, alert, etc.
        }
        batch = batch[:0]
    }

    for {
        select {
        case m := <-w.writeCh:
            batch = append(batch, m)
            if len(batch) >= w.bufSize {
                flush()
            }
        case <-ticker.C:
            flush()
        case <-w.flushCh:
            flush()
            return
        }
    }
}

func (w *MetricsWriter) batchInsert(ctx context.Context, points []MetricPoint) error {
    // pgx CopyFrom is the fastest bulk insert method for PostgreSQL
    _, err := w.db.CopyFrom(
        ctx,
        pgx.Identifier{"cpu_metrics"},
        []string{"time", "host", "cpu_pct", "mem_pct"},
        pgx.CopyFromSlice(len(points), func(i int) ([]any, error) {
            p := points[i]
            return []any{p.Time, p.Host, p.CPUPct, p.MemPct}, nil
        }),
    )
    return err
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

If the only database you have used is a regular OLTP Postgres, the first thing to internalize is that time-series data has a dominant access pattern: write once, read in time ranges, drop in bulk. Rows are never updated. Deletes are always "everything older than X." Once you accept that, the optimizations stop looking exotic. Partitioning by time is just "put each week in its own table so dropping old data is a `DROP TABLE` instead of a `DELETE` that bloats the heap." Compression of old chunks is just "I know I will never update this week's data after next week, so pack it tightly." Materialized continuous aggregates are just "I know I will always query by hour-buckets, so precompute them."

Worked example for a first job. You are asked to build a dashboard that shows the last 24 hours of API latency per endpoint, 1-minute resolution. The junior trap is `SELECT endpoint, date_trunc('minute', ts), avg(latency_ms) FROM requests WHERE ts > now() - interval '24 hours' GROUP BY 1, 2`. This works at 10k rows per day. At 10M rows per day it times out. The correct approach is a TimescaleDB hypertable on `requests` and a continuous aggregate that maintains per-minute rollups automatically as data arrives. The dashboard query hits the aggregate table, not the raw table, and returns in milliseconds regardless of retention window. Continuous aggregates with `WITH NO DATA` and `refresh_continuous_aggregate` policies are the pattern to learn on day one.

Interview entry-point question. "You have a metrics system ingesting 1M points per second. Design the storage." A junior names Postgres. A FAANG-ready answer first asks the questions: cardinality of labels (how many unique series), query pattern (range scans or point lookups), retention (hot, warm, cold tiers), consistency requirements (can we lose a second of data on crash). Then proposes a layered answer: Prometheus or VictoriaMetrics for the 2-hour hot window with in-memory indexes, remote write to a long-term store (Thanos on S3, Mimir, or VictoriaMetrics cluster) for 13-month retention, downsampled rollups for data older than 30 days. Mention that 1M points/sec with naive row-per-point in Postgres will cost about 80 MB/s of WAL and is not viable. Mention that columnar storage with delta-of-delta timestamp encoding and Gorilla float compression gets you 1-2 bytes per point instead of 16+.

One more prerequisite worth learning early. Cardinality is the enemy of time-series databases. A metric with 10 hosts and 5 endpoints is 50 series. A metric that includes `user_id` in the labels is millions of series, and most TSDBs will fall over. The rule is: labels are for things you want to aggregate across, not for high-cardinality identifiers. `user_id` goes in an events store (ClickHouse, Elasticsearch), not in Prometheus labels. Getting this wrong on a production rollout is the single most common time-series incident in the industry.

### Senior @ FAANG: Staff and Principal Material

The storage engine choice is the architectural decision, and it follows from the workload. TimescaleDB is the right answer when you need SQL, joins against relational data, and transactional guarantees on writes. It is built on Postgres, so operational knowledge transfers. Hypertables with 1-day to 1-week chunks, native compression (10x to 20x typical), continuous aggregates with real-time view of the last partial bucket, and tiered storage to S3 via `tiered_storage` in Timescale 2.14+ covers most product-facing time-series workloads. The failure mode is write throughput above roughly 500k rows/sec per node, at which point you are fighting Postgres WAL and want a purpose-built TSDB.

InfluxDB IOx (the 3.x rewrite on Arrow/Parquet/DataFusion) changed the tradeoffs in 2024. It writes Parquet files to object storage, uses DataFusion for query, and achieves unlimited cardinality, which the old TSM engine could not. It is the right answer for high-cardinality observability workloads where you need SQL and do not want to run ClickHouse. The tradeoff is that query latency on very recent data is higher than TSM because it is reading Parquet, not memory-mapped TSM files. For dashboards that hit the last 5 minutes hard, latency matters.

ClickHouse MergeTree is the default for events and analytical workloads above a billion rows per day. The schema design rules are load-bearing. `ORDER BY` is the primary sort key and determines which queries will be fast. Put the most selective, most-filtered-on low-cardinality columns first. `PARTITION BY toYYYYMM(timestamp)` for monthly partitions, or `toYYYYMMDD` if retention is short, because partitions are the unit of `ALTER TABLE DROP PARTITION` (instant retention). `LowCardinality(String)` for any string column with fewer than roughly 10k distinct values, which dictionary-encodes and cuts storage 5x to 10x. `MATERIALIZED` columns compute at insert time and cost nothing to query. Materialized views with `SummingMergeTree`, `AggregatingMergeTree`, and `ReplacingMergeTree` give you pre-aggregated rollups that update on insert, not on a schedule. Compression: `CODEC(DoubleDelta, ZSTD(1))` for timestamps, `CODEC(Gorilla, ZSTD(1))` for floats, `CODEC(T64, ZSTD(1))` for integers. Typical compression ratio is 10x to 30x versus raw. Sharding key must be chosen with care because you cannot change it without rebuilding the table. A hash of a high-cardinality column (user_id, trace_id) distributes evenly. Timestamp as shard key creates hotspots.

Prometheus TSDB internals worth knowing. Head block in memory, 2-hour chunks written to disk, WAL for crash recovery, inverted index from label pairs to series IDs, stored as a Roaring Bitmap-style postings list. The query engine does label matching by set operations on postings lists, then fetches chunks and streams through them. Two architectural limits: (1) active series count is bounded by memory (a good rule is 4 to 8 GB per million active series), (2) ingestion rate is bounded by WAL fsync throughput. For anything above 10M active series or 5M samples/sec per instance, you shard by label hash using Mimir or Cortex, or switch to VictoriaMetrics which has a more efficient on-disk format and handles 50M+ active series per node. Thanos gives you long-term storage on S3 with a sidecar that uploads blocks and a store gateway that queries them, with downsampling at 5-minute and 1-hour resolution. VictoriaMetrics cluster edition does the same with a simpler operational model and better resource usage in most benchmarks as of 2026.

QuestDB is the niche right answer for financial tick data and high-frequency trading workloads where you need sub-microsecond ingest latency and SAMPLE BY / LATEST BY semantics. It uses columnar storage with out-of-order writes via a commit log and O1 time-series indexes. For IoT telemetry with strict latency SLAs on ingest, it beats TimescaleDB on raw throughput per core. The ecosystem is smaller, so factor that into the decision.

Downsampling strategies. The wrong approach is cron jobs that aggregate and delete. The right approach is tiered retention with automatic rollup. Raw data at 1-second resolution retained for 7 days, 1-minute rollups retained for 90 days, 1-hour rollups retained for 2 years. Each tier is computed from the previous, stored in a separate table or continuous aggregate, and the query layer routes to the appropriate tier based on the time range and resolution requested. Prometheus does this via recording rules plus Thanos downsampling. TimescaleDB does it via continuous aggregates with `refresh_continuous_aggregate` policies. ClickHouse does it via chained materialized views. In all cases, make sure the rollup is deterministic and replayable, because you will need to backfill when you add a new metric or fix a bug in the aggregation.

Compression ratios you should know. Float64 metrics with timestamps at 1-second cadence: Gorilla encoding plus ZSTD gets you about 1.3 bytes per point on well-correlated data, versus 16 bytes raw. That is a 12x ratio before ZSTD, closer to 20x after. TimescaleDB native compression reports 10x to 20x in production. ClickHouse on wide event rows with many LowCardinality columns reports 10x to 30x. Prometheus TSDB chunks are about 1.3 bytes per point. VictoriaMetrics claims 0.4 to 0.8 bytes per point on typical workloads due to better integer packing. If your vendor is promising 100x compression, ask what the baseline is. It is probably compressed against an unoptimized schema.

Cardinality management at scale. The cardinality explosion incident is a rite of passage. Someone adds `user_id` or `request_id` to a metric label, active series goes from 2M to 200M overnight, Prometheus OOMs, alerts fire, on-call wakes up. Mitigations: (1) CI check that rejects high-cardinality labels via a static analysis of recording rules, (2) relabeling rules that drop offending labels at scrape time, (3) per-team cardinality budgets enforced by Mimir/Cortex limits, (4) convert high-cardinality metrics to exemplars or traces, which have different storage semantics. For logs and events, use Loki or ClickHouse. For traces, use Tempo or Jaeger with ClickHouse or Cassandra backend. Do not put high-cardinality data in metrics.

Write path at FAANG scale. The Go batch writer pattern above is correct for 10k to 100k writes/sec per service. Above that, you need a dedicated ingestion tier. Kafka or Kinesis in front of the TSDB, consumers that do the batching, and the TSDB writers running as stateless services. Backpressure: if the TSDB is slow, Kafka buffers. If Kafka is saturated, drop non-critical metrics at the source via sampling. Critical metrics (SLO-defining latencies, error rates) are never sampled. Lower-value metrics (verbose histograms, debug counters) can be sampled at 1/10 or 1/100 with no loss of statistical signal if the aggregation window is wide enough. Use exponential histograms (OpenTelemetry) instead of fixed-bucket histograms to get good percentile fidelity without exploding cardinality.

What to push back on. If someone proposes a single Postgres table for "all events from all services with a JSONB payload and we will add indexes as needed," the answer is no. That is a design that works until it does not, and the transition to a real analytical store under load is a project measured in quarters. Pick the right storage engine for the write pattern and query pattern at the start. If someone proposes "we will keep raw high-resolution data forever because storage is cheap," the answer is that query performance on 10 years of 1-second data is not cheap, and nobody ever queries 2019 data at 1-second resolution. Design the retention tiers on day one.

---
