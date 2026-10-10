## 37.2 pgx Connection Pool

### Why pgxpool over database/sql for Postgres

For Postgres workloads in Go, `pgxpool` (from `github.com/jackc/pgx/v5/pgxpool`) is materially superior to `database/sql` + `lib/pq`. The differences compound in production:

- **Native Postgres wire protocol**: pgx speaks the extended query protocol directly, avoiding the generic `driver.Value` marshaling that `database/sql` forces. Benchmarks routinely show 30-50% lower latency on prepared-statement workloads.
- **Per-connection prepared-statement cache**: pgx caches prepared statements keyed by SQL text, so repeat queries skip the parse/bind overhead. `database/sql` caches at the `sql.Stmt` level, which is awkward to use correctly with connection churn.
- **First-class PostgreSQL types**: `jsonb`, arrays, `hstore`, `numeric`, composite types, `LISTEN/NOTIFY`, and `COPY FROM` are all native - no `sql.Scanner`/`driver.Valuer` boilerplate.
- **Lifecycle hooks**: `BeforeAcquire`, `AfterRelease`, `BeforeClose`, `AfterConnect` let you validate health, clean session state (`DISCARD ALL`), or install session GUCs (`SET statement_timeout`) exactly once per physical connection.
- **Rich pool statistics**: `pool.Stat()` exposes `AcquireCount`, `AcquireDuration`, `EmptyAcquireCount`, `CanceledAcquireCount`, `NewConnsCount`, and `MaxLifetimeDestroyCount` - the `database/sql` equivalent is much thinner.
- **Explicit health checking**: `HealthCheckPeriod` background-validates idle connections so stale TCP sessions are evicted before a user query fails.

Use `database/sql` only when you need driver portability (MySQL, SQLite, SQL Server in the same binary) or when an ecosystem tool (sqlc, some ORMs) requires it. Even then, pgx's `stdlib` adapter lets you get `database/sql` on top of pgx when you need both.

### pgxpool Configuration

The `pgxpool` package provides a connection pool purpose-built for PostgreSQL. The configuration struct below wraps these settings so they can be loaded from environment variables or config files in one place.

```go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// PgxPoolConfig extends pgxpool configuration
type PgxPoolConfig struct {
    DSN             string
    MaxConns        int32
    MinConns        int32
    MaxConnLifetime time.Duration
    MaxConnIdleTime time.Duration
    HealthCheckPeriod time.Duration
}

// NewPgxPool creates an optimized pgx connection pool
func NewPgxPool(ctx context.Context, cfg PgxPoolConfig) (*pgxpool.Pool, error) {
    poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
    if err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    // Connection pool settings
    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns
    poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
    poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Connection settings
    poolCfg.ConnConfig.ConnectTimeout = 5 * time.Second

    // Production tuning: Avoid executing Ping or DISCARD ALL on every acquire/release!
    // Pinging in BeforeAcquire adds an extra network round-trip to EVERY single query,
    // cutting maximum QPS in half under high concurrency.
    // Instead, rely on HealthCheckPeriod to periodically validate idle connections in the background.
    poolCfg.HealthCheckPeriod = 30 * time.Second

    // Cloud NAT / AWS NLB idle timeout protection:
    // Cloud firewalls silently drop idle TCP sockets after 350 seconds without sending a RST packet.
    // Setting MaxConnIdleTime strictly below 350s (e.g. 4 minutes) prevents the pool from handing
    // callers dead sockets that block until timeout.
    poolCfg.MaxConnIdleTime = 4 * time.Minute

    // Before close hook - runs before connection is destroyed
    poolCfg.BeforeClose = func(conn *pgx.Conn) {
        // Log connection closure for debugging
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    // Verify connection
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return pool, nil
}

// PoolStats returns current pool statistics
type PoolStats struct {
    TotalConns     int32
    IdleConns      int32
    AcquiredConns  int32
    MaxConns       int32
    AcquireCount   int64
    AcquireDuration time.Duration
}

func GetPoolStats(pool *pgxpool.Pool) PoolStats {
    stat := pool.Stat()
    return PoolStats{
        TotalConns:     stat.TotalConns(),
        IdleConns:      stat.IdleConns(),
        AcquiredConns:  stat.AcquiredConns(),
        MaxConns:       stat.MaxConns(),
        AcquireCount:   stat.AcquireCount(),
        AcquireDuration: stat.AcquireDuration(),
    }
}
```

### Connection Pool Monitoring

Knowing your pool's state at runtime is critical for diagnosing slow queries and preventing outages. The `pgxpool.Pool.Stat()` method exposes total, idle, and acquired connection counts along with cumulative acquire duration. Exporting these as Prometheus metrics lets you set alerts on pool saturation before it causes request failures. The collector below polls the pool on a timer and logs a warning when utilization exceeds 80%.

```go
package database

import (
    "context"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/prometheus/client_golang/prometheus"
)

// PoolMetrics collects connection pool metrics
type PoolMetrics struct {
    pool *pgxpool.Pool

    totalConns     prometheus.Gauge
    idleConns      prometheus.Gauge
    acquiredConns  prometheus.Gauge
    acquireTotal   prometheus.Counter
    acquireDuration prometheus.Histogram
}

func NewPoolMetrics(pool *pgxpool.Pool, reg prometheus.Registerer) *PoolMetrics {
    m := &PoolMetrics{
        pool: pool,
        totalConns: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: "db_pool_total_connections",
            Help: "Total number of connections in the pool",
        }),
        idleConns: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: "db_pool_idle_connections",
            Help: "Number of idle connections in the pool",
        }),
        acquiredConns: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: "db_pool_acquired_connections",
            Help: "Number of acquired connections",
        }),
        acquireTotal: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "db_pool_acquire_total",
            Help: "Total number of connection acquisitions",
        }),
        acquireDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
            Name:    "db_pool_acquire_duration_seconds",
            Help:    "Time to acquire a connection",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
        }),
    }

    reg.MustRegister(
        m.totalConns,
        m.idleConns,
        m.acquiredConns,
        m.acquireTotal,
        m.acquireDuration,
    )

    return m
}

func (m *PoolMetrics) Collect() {
    stat := m.pool.Stat()
    m.totalConns.Set(float64(stat.TotalConns()))
    m.idleConns.Set(float64(stat.IdleConns()))
    m.acquiredConns.Set(float64(stat.AcquiredConns()))
}

// MonitorPool starts background monitoring
func (m *PoolMetrics) MonitorPool(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.Collect()

            stat := m.pool.Stat()

            // Log warnings for pool exhaustion
            utilization := float64(stat.AcquiredConns()) / float64(stat.MaxConns())
            if utilization > 0.8 {
                slog.Warn("connection pool near capacity",
                    "acquired", stat.AcquiredConns(),
                    "max", stat.MaxConns(),
                    "utilization", utilization,
                )
            }
        }
    }
}
```

### Junior → FAANG: picking pgx and reading its knobs correctly

When you are new to Go, the temptation is to use `database/sql` because it is in the standard library and tutorials start there. For Postgres specifically, reach for `github.com/jackc/pgx/v5/pgxpool` instead. The practical reasons: pgx gives you native `jsonb` and array handling without `sql.Scanner` boilerplate, `COPY FROM` for fast bulk inserts, `LISTEN/NOTIFY` for pub/sub, and pool statistics that are actually useful. The learning cost is one afternoon of adjusting to `pgx.Rows` instead of `sql.Rows`.

Worked example on the five knobs. You are sizing a pool for a service handling 500 RPS with mean 10ms database time. Little's Law gives 5 active connections mean. Set `MaxConns=25` (5x headroom for p99 bursts), `MinConns=5` (keep baseline warm so cold-start does not hit connect latency), `MaxConnLifetime=30m` (rotate connections through load balancer reassignment and DNS changes), `MaxConnIdleTime=5m` (release surplus during quiet periods without flapping), `HealthCheckPeriod=1m` (background-validate idle connections so a dead TCP session is evicted before a user query hits it). If you only remember two defaults: never set `MaxConns` to unlimited, never leave `HealthCheckPeriod` at zero.

Interview entry-point. "What is the difference between `pgx.Conn`, `pgxpool.Pool`, and `pgxpool.Conn`?" `pgx.Conn` is a single raw connection, not safe for concurrent use. `pgxpool.Pool` is the goroutine-safe pool you inject into your repositories. `pgxpool.Conn` is what you get back from `pool.Acquire(ctx)`, and you MUST call `.Release()` in a defer or the connection leaks. If you need multiple statements on the same physical connection (for `SET LOCAL`, advisory locks, or temp tables), you acquire once and reuse. For one-shot queries, use `pool.Query` / `pool.QueryRow` / `pool.Exec` directly, which acquire-and-release atomically.

### Senior @ FAANG: pgx v5 tuning, PgBouncer compatibility, and pool lifecycle observability

The pgx v5 hook surface (`BeforeAcquire`, `AfterRelease`, `BeforeClose`, `AfterConnect`) is the right place to enforce session contracts. `AfterConnect` runs once per physical connection and is the correct place to `SET statement_timeout`, `SET idle_in_transaction_session_timeout`, `SET application_name` (so `pg_stat_activity` shows which service holds which backend), and install per-connection GUCs. `BeforeAcquire` should be cheap (a context check, never a network round trip) because it is on the hot path of every query. A naive `conn.Ping` in `BeforeAcquire` adds a full RTT to every acquire and will destroy your p99 latency. The right place for liveness is `HealthCheckPeriod`, which runs on idle connections off the hot path. `AfterRelease` should run `DISCARD ALL` only if your code path used session state, because `DISCARD ALL` is a server round trip and costs 0.5 to 1 ms per release. A better pattern is to set a context flag when session state is touched and conditionally discard.

The prepared-statement story with PgBouncer is the single most common production footgun with pgx plus pooler. pgx v5 defaults to `QueryExecModeCacheStatement`, which issues a protocol-level Parse for each unique SQL on first use and reuses the prepared statement on subsequent calls. PgBouncer in transaction mode may hand you a different backend connection for the next query, which has no knowledge of that prepared statement, yielding `ERROR: prepared statement "stmtcache_..." does not exist`. The three resolutions in 2026: (1) PgBouncer 1.21+ with `max_prepared_statements > 0` against Postgres 14+ tracks protocol-level prepared statements and routes them correctly, this is the recommended path, or (2) force `poolCfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec` to skip server-side preparation entirely, accepting the parse overhead on every query. (3) use `QueryExecModeSimpleProtocol` which sends parameters inline, losing the type-safety and binary-format benefits. Pick (1) if your infrastructure supports it, (2) if you must run older PgBouncer. PgCat 0.4 handles prepared statements transparently via its query router, which is one argument for evaluating it over PgBouncer if you are green-field.

`MaxConnLifetime` tuning requires coordination with your load balancer and DNS. AWS NLB silently drops idle TCP after 350s, so `MaxConnIdleTime` must be under 350s or you serve dead connections. `MaxConnLifetime` governs the hard rotation interval regardless of activity, and it should align with your failover RTO. If your Patroni or RDS failover promotes a replica in 30 seconds and updates DNS with TTL 60, a `MaxConnLifetime` of 30 minutes means your pool keeps pinning to the old primary's IP for up to 30 minutes after failover. Set it to 5 to 15 minutes, jittered (pgx adds jitter automatically) so rotation does not create thundering herds on the new primary. In RDS Proxy or PgBouncer deployments, `MaxConnLifetime` also controls how often your pool cycles through pooler-side load balancing, so shorter lifetimes give better load distribution across pooler instances.

Pool-lifecycle observability via OTEL. The `pgx-contrib/pgxotel` package (or hand-rolled equivalent) instruments queries with spans, but the spans you actually want are around `Acquire` and `Release`. A query span that shows 50ms total with 48ms in Acquire and 2ms in Execute tells you the pool is saturated, not the query slow. Wire the acquire span with attributes: `db.pool.total_conns`, `db.pool.acquired_conns`, `db.pool.idle_conns`, `db.pool.waiting` (synthesized from `EmptyAcquireCount` deltas). Export `AcquireDuration` as a histogram with buckets `[0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]` so you see sub-millisecond acquires (healthy) distinctly from tens-of-milliseconds (saturated). Alert on `histogram_quantile(0.99, db_pool_acquire_duration_seconds) > 0.05` for 5 minutes as a leading indicator of pool pressure, before timeouts fire.

Hedging and backpressure. At scale, one pattern that pays off is pool hedging, where a read query that has been waiting on acquire for longer than a threshold (say, 20ms) fires a duplicate against a replica pool and races the result. pgx does not ship this, you build it in your repository layer. The cost is 2x load in the hedged path, the benefit is that slow-pool tail latency collapses into replica-pool median latency. Google's "The Tail at Scale" paper documents this pattern, and Bigtable and Spanner clients implement it internally. Apply selectively to idempotent reads, never to writes.

Pool shutdown semantics matter during pod termination. `pool.Close()` waits for all in-flight queries to complete but does not cancel them. If a slow query is running when SIGTERM arrives, your pod's `terminationGracePeriodSeconds` must exceed the longest expected query, or Kubernetes SIGKILLs mid-query, leaving backend work orphaned. The correct pattern is: on SIGTERM, stop accepting new requests (drain the HTTP server), cancel in-flight request contexts (which propagate to pgx and abort queries), then `pool.Close()`. Set `terminationGracePeriodSeconds` to `max(statement_timeout) + 10s` for safety.

---
