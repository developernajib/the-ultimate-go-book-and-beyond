## 37H.1 ClickHouse: Columnar Analytics

### Architecture and Storage Model

ClickHouse stores each column in a separate compressed file on disk, so aggregate queries that touch only a few columns of a billion-row table read a tiny fraction of the data. The MergeTree engine family adds sorted primary keys and background merge passes, enabling sub-second `COUNT`/`SUM`/`AVG` analytics workloads that would take minutes in a row-oriented database.

```
ClickHouse Architecture
═══════════════════════════════════════════════════════════════════

  Columnar Storage (vs Row Storage):
  ┌──────────────────────────────────────────────────────────┐
  │  Row Store (PostgreSQL):                                 │
  │  Row1: [id=1, user="Alice", amount=100, date="2026-01"]  │
  │  Row2: [id=2, user="Bob",   amount=200, date="2026-01"]  │
  │  → Good for: point lookups, OLTP                         │
  │  → Bad for: "SUM(amount) for all users" (reads all cols) │
  │                                                          │
  │  Column Store (ClickHouse):                              │
  │  id:     [1, 2, 3, 4, 5, ...]                            │
  │  user:   [Alice, Bob, Carol, ...]                        │
  │  amount: [100, 200, 150, 300, ...]                       │
  │  date:   [2026-01, 2026-01, 2026-02, ...]                │
  │  → SUM(amount): reads only "amount" column               │
  │  → 10-100x better compression (similar values adjacent)  │
  │  → SIMD vectorized operations                            │
  └──────────────────────────────────────────────────────────┘

  MergeTree Engine:
  ┌──────────────────────────────────────────────────────────┐
  │  INSERT → buffer → sorted parts on disk                  │
  │  Background merge → larger parts (like Cassandra STCS)   │
  │  Primary index → sparse (1 entry per 8192 rows)          │
  │  Partition: physical separation by partition key         │
  │  Granule: unit of I/O (default 8192 rows)                │
  │                                                          │
  │  MergeTree family:                                       │
  │  - MergeTree: base, manual deduplication                 │
  │  - ReplacingMergeTree: dedup on merge (last write wins)  │
  │  - AggregatingMergeTree: pre-aggregate on merge          │
  │  - SummingMergeTree: sum numeric columns on merge        │
  │  - CollapsingMergeTree: mark rows for deletion           │
  │  - ReplicatedMergeTree: HA replication via ZooKeeper     │
  └──────────────────────────────────────────────────────────┘
```

### ClickHouse Schema Design

A well-designed ClickHouse schema selects the right MergeTree variant, defines an `ORDER BY` key that matches your most common filter patterns, and uses `LowCardinality` for columns with a bounded set of distinct values. The schema below shows two tables: a high-write events table partitioned monthly, and a denormalized orders table with a materialized view that pre-aggregates daily revenue so dashboard queries never touch raw rows.

```sql
-- Events table: high-write, query by time range + filter
CREATE TABLE events (
    event_id    UUID        DEFAULT generateUUIDv4(),
    event_type  LowCardinality(String),  -- LowCardinality: dict encoding
    user_id     UInt64,
    session_id  String,
    properties  Map(String, String),
    ip_address  IPv4,
    created_at  DateTime64(3, 'UTC'),    -- millisecond precision
    date        Date MATERIALIZED toDate(created_at)  -- partition key
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)       -- monthly partitions for drop efficiency
ORDER BY (event_type, user_id, created_at)  -- sorting key = primary index
SETTINGS index_granularity = 8192;

-- Orders for analytics (denormalized for query performance)
CREATE TABLE orders_analytics (
    order_id         UUID,
    user_id          UInt64,
    user_email       String,                   -- denormalized
    user_country     LowCardinality(String),  -- for filtering
    product_id       UInt64,
    product_name     String,
    category         LowCardinality(String),
    quantity         UInt16,
    unit_price_cents Int64,
    total_price_cents Int64,
    discount_cents   Int64 DEFAULT 0,
    status           LowCardinality(String),
    created_at       DateTime64(3, 'UTC'),
    date             Date MATERIALIZED toDate(created_at)
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/orders', '{replica}')
PARTITION BY toYYYYMM(date)
ORDER BY (user_country, category, date, order_id)
TTL date + INTERVAL 2 YEAR DELETE;  -- auto-delete after 2 years

-- Materialized view: pre-aggregate daily revenue
CREATE MATERIALIZED VIEW daily_revenue_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (date, category, user_country)
AS SELECT
    toDate(created_at) AS date,
    category,
    user_country,
    sum(total_price_cents) AS revenue_cents,
    count() AS order_count,
    uniqExact(user_id) AS unique_customers,
    avg(total_price_cents) AS avg_order_value_cents
FROM orders_analytics
GROUP BY date, category, user_country;
```

### Projections for Pre-Aggregation

Projections are ClickHouse's built-in way to keep a secondary physical layout of the same table - an alternative sort order, a pre-aggregation, or a subset of columns - that the query planner transparently picks when it matches. Unlike materialized views, projections are owned by the table and stay consistent with it automatically (no manual `POPULATE`, no drift). They are the first thing to reach for when a single hot query pattern dominates a table.

```sql
ALTER TABLE orders_analytics
  ADD PROJECTION daily_country_revenue (
    SELECT
      date,
      user_country,
      category,
      sum(total_price_cents),
      count()
    GROUP BY date, user_country, category
  );
ALTER TABLE orders_analytics MATERIALIZE PROJECTION daily_country_revenue;
```

### Go ClickHouse Client

The `clickhouse-go/v2` driver (module path `github.com/ClickHouse/clickhouse-go/v2`) speaks ClickHouse's native TCP protocol, which is faster than the HTTP interface for batch inserts and large result sets. The client below configures LZ4 compression, per-query memory limits, and connection pooling. `PrepareBatch` accumulates rows in memory and sends them in a single network round-trip, which is how ClickHouse expects to receive data. Many small inserts degrade performance because each one creates a new data part that the background merge process must consolidate - for high-fan-in ingest paths where client-side batching is impractical, enable server-side **async inserts** (see `Async Inserts` below) so ClickHouse itself coalesces small writes into fewer parts.

```go
package clickhouse

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Config for ClickHouse connection
type Config struct {
	Hosts        []string
	Database     string
	Username     string
	Password     string
	MaxOpenConns int
	MaxIdleConns int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
}

// NewConnection creates a production ClickHouse connection
func NewConnection(cfg Config, log *slog.Logger) (driver.Conn, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: cfg.Hosts,
		Auth: clickhouse.Auth{
			Database: cfg.Database,
			Username: cfg.Username,
			Password: cfg.Password,
		},
		MaxOpenConns: cfg.MaxOpenConns,
		MaxIdleConns: cfg.MaxIdleConns,
		DialTimeout:  cfg.DialTimeout,
		ReadTimeout:  cfg.ReadTimeout,
		Settings: clickhouse.Settings{
			"max_execution_time": 60,
			"max_memory_usage":   1073741824, // 1GB per query
		},
		Compression: &clickhouse.Compression{
			Method: clickhouse.CompressionLZ4,
		},
		Debug: false,
	})
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}

	log.Info("clickhouse connected", "hosts", cfg.Hosts)
	return conn, nil
}

// Event represents an analytics event
type Event struct {
	EventID    string            `ch:"event_id"`
	EventType  string            `ch:"event_type"`
	UserID     uint64            `ch:"user_id"`
	SessionID  string            `ch:"session_id"`
	Properties map[string]string `ch:"properties"`
	IPAddress  string            `ch:"ip_address"`
	CreatedAt  time.Time         `ch:"created_at"`
}

// EventRepository handles event analytics
type EventRepository struct {
	conn driver.Conn
	log  *slog.Logger
}

// BatchInsert inserts events using ClickHouse's native batch protocol
func (r *EventRepository) BatchInsert(ctx context.Context, events []Event) error {
	batch, err := r.conn.PrepareBatch(ctx, "INSERT INTO events")
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}

	for _, e := range events {
		if err := batch.Append(
			e.EventID,
			e.EventType,
			e.UserID,
			e.SessionID,
			e.Properties,
			e.IPAddress,
			e.CreatedAt,
		); err != nil {
			return fmt.Errorf("append event: %w", err)
		}
	}

	if err := batch.Send(); err != nil {
		return fmt.Errorf("send batch: %w", err)
	}
	return nil
}

// DailyRevenue returns revenue aggregates by day and category
func (r *EventRepository) DailyRevenue(ctx context.Context, from, to time.Time) ([]DailyRevenue, error) {
	rows, err := r.conn.Query(ctx, `
		SELECT
			date,
			category,
			user_country,
			sumMerge(revenue_cents) AS revenue_cents,
			countMerge(order_count) AS order_count,
			uniqMerge(unique_customers) AS unique_customers
		FROM daily_revenue_mv
		WHERE date >= ? AND date <= ?
		GROUP BY date, category, user_country
		ORDER BY date ASC, revenue_cents DESC
	`, toDate(from), toDate(to))
	if err != nil {
		return nil, fmt.Errorf("daily revenue query: %w", err)
	}
	defer rows.Close()

	var results []DailyRevenue
	for rows.Next() {
		var d DailyRevenue
		if err := rows.Scan(&d.Date, &d.Category, &d.Country,
			&d.RevenueCents, &d.OrderCount, &d.UniqueCustomers); err != nil {
			return nil, err
		}
		results = append(results, d)
	}
	return results, rows.Err()
}

// FunnelAnalysis calculates conversion funnel
func (r *EventRepository) FunnelAnalysis(ctx context.Context, steps []string, window time.Duration, from, to time.Time) ([]FunnelStep, error) {
	// ClickHouse funnel functions: windowFunnel, retention, sequenceMatch
	query := fmt.Sprintf(`
		SELECT
			level,
			count() AS users
		FROM (
			SELECT user_id,
				windowFunnel(%d)(
					created_at,
					%s
				) AS level
			FROM events
			WHERE created_at BETWEEN ? AND ?
			GROUP BY user_id
		)
		GROUP BY level
		ORDER BY level ASC
	`,
		int64(window.Seconds()),
		buildFunnelConditions(steps),
	)

	rows, err := r.conn.Query(ctx, query, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []FunnelStep
	for rows.Next() {
		var f FunnelStep
		if err := rows.Scan(&f.Level, &f.Users); err != nil {
			return nil, err
		}
		if f.Level > 0 && f.Level <= len(steps) {
			f.Name = steps[f.Level-1]
		}
		results = append(results, f)
	}
	return results, rows.Err()
}

func buildFunnelConditions(steps []string) string {
	var conditions []string
	for _, step := range steps {
		conditions = append(conditions, fmt.Sprintf("event_type = '%s'", step))
	}
	return strings.Join(conditions, ", ")
}

// RealtimeStats queries last 5 minutes using materialized data
func (r *EventRepository) RealtimeStats(ctx context.Context) (*RealtimeStats, error) {
	var stats RealtimeStats
	err := r.conn.QueryRow(ctx, `
		SELECT
			count() AS events_last_5min,
			uniqExact(user_id) AS active_users,
			countIf(event_type = 'purchase') AS purchases,
			sumIf(toInt64OrDefault(properties['revenue_cents'], 0), event_type = 'purchase') AS revenue_cents
		FROM events
		WHERE created_at >= now() - INTERVAL 5 MINUTE
	`).Scan(&stats.Events, &stats.ActiveUsers, &stats.Purchases, &stats.RevenueCents)

	return &stats, err
}

type DailyRevenue struct {
	Date            time.Time
	Category        string
	Country         string
	RevenueCents    int64
	OrderCount      uint64
	UniqueCustomers uint64
}

type FunnelStep struct {
	Level int
	Name  string
	Users uint64
}

type RealtimeStats struct {
	Events       uint64
	ActiveUsers  uint64
	Purchases    uint64
	RevenueCents int64
}

func toDate(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}
```

### Async Inserts for High-Fan-In Ingestion

ClickHouse prefers large batches because each insert creates an on-disk part that the background merge scheduler must later consolidate. When many producers each send small inserts (typical for microservices, edge devices, or HTTP ingest endpoints), server-side async inserts let the server buffer writes in memory and flush them as one part per buffer window. Enable it per query via the `async_insert=1` setting. The driver exposes this through context settings.

```go
// EnqueueAsync appends rows with server-side batching.
// Many producers can call this concurrently - ClickHouse coalesces the parts.
func (r *EventRepository) EnqueueAsync(ctx context.Context, events []Event) error {
    ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
        "async_insert":          1,
        "wait_for_async_insert": 1, // 0 = fire-and-forget, 1 = wait for ack
    }))
    return r.BatchInsert(ctx, events)
}
```

Trade-off: async inserts accept higher per-row latency (rows are not durable until the flush interval elapses, default 200 ms) in exchange for vastly fewer parts and far less merge pressure. Use `wait_for_async_insert=0` only if your upstream has an independent durability path (Kafka, write-ahead outbox) that can replay on crash.

### Parquet Input and Output

ClickHouse reads and writes Apache Parquet natively, which makes it a practical bridge between an operational warehouse and the broader data-lake ecosystem (Iceberg, Delta, DuckDB, Spark, Arrow-based Go consumers). Two common uses:

```sql
-- Bulk-load a Parquet file from S3 into a MergeTree table
INSERT INTO orders_analytics
SELECT * FROM s3(
    'https://bucket.s3.amazonaws.com/orders/2026/*.parquet',
    'AWS_KEY', 'AWS_SECRET',
    'Parquet'
);

-- Export a query result as Parquet for downstream Arrow/DataFusion jobs
SELECT date, category, sum(total_price_cents) AS revenue_cents
FROM orders_analytics
WHERE date >= today() - 30
GROUP BY date, category
INTO OUTFILE 's3://bucket/exports/last30d.parquet'
FORMAT Parquet;
```

From Go, the same driver can stream result rows into a Parquet writer (via `parquet-go` or Apache Arrow Go) without paying the JSON serialization tax of the HTTP interface - the native protocol delivers typed column chunks directly.

### Junior → FAANG: the ClickHouse on-ramp for a new engineer

The hardest conceptual jump from Postgres to ClickHouse is that the primary key is not unique. In Postgres, `PRIMARY KEY` means a btree plus a uniqueness constraint. In ClickHouse, the `ORDER BY` clause of a MergeTree table defines both the sort order on disk and a sparse index. The index has one entry per granule (8192 rows by default), not one entry per row. That is why scans start at a granule boundary and read forward. A junior engineer who expects `SELECT * FROM events WHERE user_id = 42` to be a fast point lookup will be disappointed. To filter cheaply on `user_id`, you either put it early in the `ORDER BY` tuple or add a skip index such as `INDEX user_id_idx user_id TYPE bloom_filter GRANULARITY 4`. A skip index does not point at rows, it lets the query planner skip whole granules that cannot match.

A worked example that clicks for most new engineers. Create a table `ORDER BY (toYYYYMM(ts), site_id, ts)`. Insert 100 million rows spanning two years. Run three queries. First, `WHERE ts >= today() - 7 AND site_id = 1`. Observe that ClickHouse reads only the granules for the last week on site 1. Second, `WHERE site_id = 1` with no time filter. Observe that it reads every partition, because the partition key is the month and you did not filter on month. Third, the same without `site_id` in the sort key. Observe that it scans every row. This one experiment teaches sparse indexing, partition pruning, and sort key design better than any blog post.

For a first job interview at a data platform team, expect to be asked: what is a granule, what is a part, what is the difference between partition key and sort key, what is a merge, why does `OPTIMIZE FINAL` exist and why should you not run it in production, and what breaks if you `INSERT` one row at a time. The last one is the canonical ClickHouse gotcha. Every insert creates a new part. The background merger has to catch up. A thousand single row inserts per second will overwhelm it and you will see `Too many parts` errors. The fix is client side batching to at least 10k rows or 1 second, or use an async insert with `async_insert=1, wait_for_async_insert=0`. Mention async inserts in the interview and you will sound current.

Your first ticket on a ClickHouse team will typically be to add a materialized view that precomputes a dashboard aggregate. Get comfortable with the pattern: a `CREATE MATERIALIZED VIEW ... TO target_table AS SELECT ...` runs the SELECT on every insert and pushes the result into the target. The target is almost always a `SummingMergeTree` or `AggregatingMergeTree` so rows collapse on merge. Read the Altinity knowledge base on materialized views before your second week.

### Senior @ FAANG: ClickHouse architecture, engine selection, and the 2026 competitive landscape

At staff level the interesting ClickHouse questions are about engine selection and the shared storage rewrite. MergeTree is the base engine. The variants encode different update semantics, and picking the wrong one is the single most common architectural mistake on ClickHouse at scale.

`ReplacingMergeTree` keeps the last row per sort key after merge, with an optional version column. It is eventually deduplicating. It does not guarantee uniqueness at query time unless you add `FINAL` (slow) or filter with a window function. It is correct for slowly changing dimensions and for idempotent upserts where readers can tolerate a small lag. `AggregatingMergeTree` stores partial aggregation state (AggregateFunction columns) and merges states together. It is the right target for materialized views that roll up to quantiles, uniq, or any non associative aggregate. `SummingMergeTree` collapses rows with the same sort key by summing numeric columns. Use it for counters and sums only, never for averages (store sum and count separately and divide at query time). `CollapsingMergeTree` and `VersionedCollapsingMergeTree` implement the sign column pattern for proper deletes and corrections. They require the writer to emit a cancel row with sign=-1 followed by the corrected row with sign=+1. This is how you implement CDC from Postgres into ClickHouse correctly. `GraphiteMergeTree` is for Graphite style metrics retention rollups, rarely the right pick in 2026 with better options available.

Projections are the feature that separates intermediate from senior users. A projection is an alternative physical layout of the same data, stored as a hidden part inside the main table. You can add a projection `ORDER BY user_id` to a table whose main `ORDER BY` is `ts`. The query planner picks the best projection for each query. This gives you multiple sort orders on the same data without running two tables and two inserts. The cost is disk space and insert throughput. Use projections instead of duplicate tables whenever the query patterns are known but diverse.

Skip indices beyond bloom filter matter. `minmax` is free (one min and one max per granule) and prunes well on monotonic columns. `set(N)` stores up to N distinct values per granule, great for low cardinality enums. `ngrambf_v1` and `tokenbf_v1` enable substring and full text search with bloom filters on n-grams or tokens. `inverted` indexes landed as experimental in 23.x and are production ready in 25.x for text search workloads, giving you a real alternative to Elasticsearch for log analytics when combined with the `String` codec improvements.

TTL is a per part operation, not per row. A `TTL ts + INTERVAL 90 DAY` drops entire parts once every row in the part is older than 90 days. This means if you mix recent and old rows in a single insert, the TTL will not fire until the newest row expires. The fix is to partition by a time unit that matches the TTL granularity (month for 90 day retention, day for 7 day retention). TTL can also move parts to cold storage (`TTL ts + INTERVAL 30 DAY TO DISK 'cold'`) or to S3 (`TO VOLUME 's3_cold'`). In ClickHouse 25.x the tiered storage story has matured enough that hot NVMe plus cold S3 is the default production shape.

The shared nothing to shared storage transition is the biggest architectural shift in ClickHouse history. Classic ClickHouse ran the `Distributed` engine over `ReplicatedMergeTree` shards, each shard holding a slice of the data with replicas for HA. Sharding was a static choice at table creation and rebalancing was manual and painful. ClickHouse Cloud (and the open source `SharedMergeTree` in 24.x and 25.x) stores parts in object storage (S3, GCS, Azure Blob), with compute nodes stateless and caching hot parts on local NVMe. Replication becomes a property of the object store, not the compute layer. You can scale compute and storage independently. The `s3_plain_rewritable` and `web` disk types in 25.x make it possible to read external Parquet datasets as native tables without ingestion. The `S3Queue` engine consumes new objects from S3 as a Kafka style source, which replaces a lot of custom ETL.

The competitive matrix a staff engineer should hold in their head in 2026. ClickHouse versus DuckDB: ClickHouse wins above a terabyte and for concurrent users, DuckDB wins below and for embedded analytics or notebooks. ClickHouse versus Databricks Photon: Photon wins on joins, Delta Lake integration, and ML pipeline fit, ClickHouse wins on sub second dashboards and cost per query. ClickHouse versus Snowflake: Snowflake wins on zero ops, governance, and ad hoc analyst SQL, ClickHouse wins on cost at high query volume and on latency sensitive workloads. ClickHouse versus BigQuery: BigQuery wins on serverless ergonomics and Google ecosystem, ClickHouse wins on cost predictability (slot pricing is brutal at scale) and on sub 100ms latency. ClickHouse versus Redshift: ClickHouse wins on almost every axis in 2026, Redshift is in maintenance mode. ClickHouse versus Trino or Presto: Trino wins on federation across heterogeneous sources, ClickHouse wins on single system latency. ClickHouse versus StarRocks and Apache Doris: the closest competitors, StarRocks has better joins and real time primary key updates, Doris has strong MPP semantics, ClickHouse has a larger community and better single node efficiency. A senior engineer who walks into a design review and can articulate the tradeoffs above without looking them up will win the ADR.

Operational gotchas that bite at scale. Mutations (`ALTER TABLE ... UPDATE` or `DELETE`) rewrite entire parts. They are asynchronous and can backlog. Use the `lightweight_deletes` feature in 23.3+ for deletes, which marks rows instead of rewriting. ZooKeeper is the weak link in classic `ReplicatedMergeTree`, replaced by ClickHouse Keeper (a Raft implementation bundled with the server) in 22.x and default in 25.x. Always run Keeper, never external ZooKeeper in a greenfield cluster. Memory limits per query (`max_memory_usage`) and per user (`max_memory_usage_for_user`) are non negotiable in multi tenant clusters. Query complexity limits (`max_rows_to_read`, `max_execution_time`) save you from runaway analyst queries. Quotas per user enforce fair sharing. And finally, monitor `system.part_log` and `system.query_log` from day one, because by the time you realize you need them you have already lost the evidence.

---
