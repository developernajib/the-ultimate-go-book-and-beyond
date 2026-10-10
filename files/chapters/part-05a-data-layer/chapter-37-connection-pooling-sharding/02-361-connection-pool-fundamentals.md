## 37.1 Connection Pool Fundamentals

### Connection Pool Architecture

The diagram illustrates how a connection pool manages a fixed set of database connections that are leased to goroutines on demand and returned after use. Pool sizing, idle timeout, and max lifetime settings prevent both connection starvation under load and stale connections after network events.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONNECTION POOLING ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                    APPLICATION LAYER                               │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │     │
│  │  │ Goroutine│ │ Goroutine│ │ Goroutine│ │ Goroutine│   ...         │     │
│  │  │   (100s) │ │          │ │          │ │          │               │     │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘               │     │
│  └───────┼────────────┼────────────┼────────────┼─────────────────────┘     │
│          │            │            │            │                           │
│          ▼            ▼            ▼            ▼                           │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │               CONNECTION POOL (database/sql or pgxpool)            │     │
│  │  ┌─────────────────────────────────────────────────────────────┐   │     │
│  │  │                    POOL MANAGER                             │   │     │
│  │  │  • MaxOpenConns: 25 (limit total connections)               │   │     │
│  │  │  • MaxIdleConns: 10 (keep ready for reuse)                  │   │     │
│  │  │  • ConnMaxLifetime: 5m (prevent stale connections)          │   │     │
│  │  │  • ConnMaxIdleTime: 1m (release idle resources)             │   │     │
│  │  └─────────────────────────────────────────────────────────────┘   │     │
│  │                              │                                     │     │
│  │  ┌───────────────────────────┼────────────────────────────────┐    │     │
│  │  │        CONNECTION STATES  │                                │    │     │
│  │  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │    │     │
│  │  │  │ Idle │  │ Idle │  │In Use│  │In Use│  │ Idle │          │    │     │
│  │  │  │  #1  │  │  #2  │  │  #3  │  │  #4  │  │  #5  │          │    │     │
│  │  │  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘          │    │     │
│  │  │     │          │          │          │          │          │    │     │
│  │  └─────┼──────────┼──────────┼──────────┼──────────┼──────────┘    │     │
│  └────────┼──────────┼──────────┼──────────┼──────────┼───────────────┘     │
│           │          │          │          │          │                     │
│           ▼          ▼          ▼          ▼          ▼                     │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │              NETWORK / PGBOUNCER (Optional)                        │     │
│  │  • Connection multiplexing (1000s clients → 50 DB connections)     │     │
│  │  • Transaction pooling mode                                        │     │
│  │  • Query queueing during saturation                                │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                      │                                      │
│                                      ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                       DATABASE SERVER                              │     │
│  │  ┌─────────────────────────────────────────────────────────────┐   │     │
│  │  │  PostgreSQL (max_connections = 100)                         │   │     │
│  │  │  • Each connection: ~10MB RAM                               │   │     │
│  │  │  • Connection establishment: ~20-100ms                      │   │     │
│  │  │  • TLS handshake: +5-20ms                                   │   │     │
│  │  └─────────────────────────────────────────────────────────────┘   │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                     POOL SIZING CONSIDERATIONS                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Pool Size = (DB_max_connections - reserved) / app_instances                │
│                                                                             │
│  Example: PostgreSQL max_connections=100, 5 app pods, 10 reserved           │
│           Pool per pod = (100 - 10) / 5 = 18 connections                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  OPTIMAL FORMULA (HikariCP research):                               │    │
│  │                                                                     │    │
│  │  connections = ((core_count * 2) + effective_spindle_count)         │    │
│  │                                                                     │    │
│  │  For SSD: connections ≈ core_count * 2                              │    │
│  │  For HDD: connections ≈ core_count * 2 + spindle_count              │    │
│  │                                                                     │    │
│  │  Example: 4-core server with SSD = 8-12 connections optimal         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Understanding Database Connections

Every database connection carries a cost: a TCP handshake, optional TLS 1.3 negotiation, authentication, and memory allocation on both the client and the server. Postgres forks a backend process per connection (typically 5-10 MB RSS each), and MySQL allocates a thread. Opening a fresh connection per query works for toy programs, but under concurrent load the overhead compounds fast. The following example measures the difference between opening a new connection for each of 100 queries versus reusing connections from a pool.

**The connection chain math (non-negotiable):**

```
app_pool_per_pod * num_pods  ≤  pgbouncer_max_db_connections  ≤  postgres_max_connections - reserved_slots
```

A concrete production example: Postgres `max_connections=500`, reserve 20 for admin/migrations/replication, leaving 480. PgBouncer `max_db_connections=400` (room for a second pooler or direct connections). 40 app pods each with `MaxConns=8` = 320 client-side slots, well under PgBouncer's 400. Violate this chain and the failure mode is catastrophic: Postgres rejects new connections with `FATAL: sorry, too many clients already`, health checks fail, the load balancer removes pods, surviving pods take the full load, and the cascade continues until the whole cluster is down.

```go
package main

import (
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

// Connection represents the lifecycle of a database connection
type ConnectionLifecycle struct {
    // TCP handshake
    // TLS negotiation (if enabled)
    // Authentication
    // Connection initialization
    // Query execution
    // Connection cleanup
}

func demonstrateConnectionCost() {
    // Each new connection is expensive:
    // - Network round trips (3-way handshake)
    // - TLS handshake (if using SSL)
    // - Database authentication
    // - Session initialization
    // - Memory allocation on both client and server

    start := time.Now()

    // Bad: Opening new connection for each query
    for i := 0; i < 100; i++ {
        db, _ := sql.Open("postgres", "postgres://user:pass@localhost/db")
        db.QueryRow("SELECT 1")
        db.Close()
    }
    fmt.Printf("Without pooling: %v\n", time.Since(start))

    // Good: Reusing connections from pool
    db, _ := sql.Open("postgres", "postgres://user:pass@localhost/db")
    defer db.Close()

    start = time.Now()
    for i := 0; i < 100; i++ {
        db.QueryRow("SELECT 1")
    }
    fmt.Printf("With pooling: %v\n", time.Since(start))
}
```

### database/sql Pool Configuration

Configuration is expressed as a struct to provide compile-time type safety and enable validation at startup. Grouping all parameters in one place makes it easy to inject them from environment variables, config files, or command-line flags through a single construction path.

```go
package database

import (
    "database/sql"
    "time"
)

// PoolConfig defines connection pool settings
type PoolConfig struct {
    // Maximum number of open connections
    MaxOpenConns int

    // Maximum number of idle connections
    MaxIdleConns int

    // Maximum lifetime of a connection
    ConnMaxLifetime time.Duration

    // Maximum idle time before connection is closed
    ConnMaxIdleTime time.Duration
}

// DefaultPoolConfig returns sensible defaults
func DefaultPoolConfig() PoolConfig {
    return PoolConfig{
        MaxOpenConns:    25,
        MaxIdleConns:    10,
        ConnMaxLifetime: 5 * time.Minute,
        ConnMaxIdleTime: 1 * time.Minute,
    }
}

// ConfigurePool applies pool settings to a database
func ConfigurePool(db *sql.DB, cfg PoolConfig) {
    // MaxOpenConns limits total connections
    // Set based on: database max_connections / number of app instances
    // Leave headroom for admin connections and other services
    db.SetMaxOpenConns(cfg.MaxOpenConns)

    // MaxIdleConns keeps connections ready for reuse
    // Should be <= MaxOpenConns
    // Higher value = faster response, more memory
    // Lower value = slower response, less memory
    db.SetMaxIdleConns(cfg.MaxIdleConns)

    // ConnMaxLifetime prevents using stale connections
    // Should be less than database wait_timeout
    // Helps with load balancer connection cycling
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

    // ConnMaxIdleTime closes idle connections
    // Helps release resources during low traffic
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)
}

// CalculatePoolSize helps determine optimal pool size
func CalculatePoolSize(
    dbMaxConnections int,
    appInstances int,
    reservedConnections int, // for admin, migrations, etc.
) int {
    available := dbMaxConnections - reservedConnections
    perInstance := available / appInstances

    // Leave some buffer
    return int(float64(perInstance) * 0.8)
}
```

### Junior → FAANG: making pool fundamentals concrete

The three numbers that matter are `MaxOpenConns`, wait time at the pool, and Postgres `max_connections`. Everything else is downstream of those. A worked example. Your local dev machine runs one Go service with `MaxOpenConns=25` against a Postgres on Docker with `max_connections=100`. Works fine. You deploy 8 pods to staging with the same config. Now you have `8 * 25 = 200` potential connections chasing 100 slots, minus replication, admin, and whatever else lives on that database. The first symptom is not slowness. It is that your first deploy after a traffic increase causes every pod to fight for connections and one pod's requests time out while another pod's requests succeed.

The interview framing. You will be asked "how do you size a connection pool" at every backend interview that reaches system design. The HikariCP-derived answer ("cores times 2 plus spindles") is a starting heuristic but it assumes CPU-bound queries on a single host. The real answer is Little's Law: measure your p50 service time for a database-touching request, multiply by target throughput, add 20 percent headroom, cap at whatever `max_connections` budget the platform team allocated your service. If a query averages 5ms and you want 500 RPS, you need 2.5 active connections on average. A pool of 10 is generous. A pool of 100 is malpractice.

First-job context on `ConnMaxLifetime`. This setting exists because load balancers (AWS NLB, GCP L4, HAProxy) will silently kill idle TCP connections after a threshold, often 350 seconds. If your `ConnMaxLifetime` is longer than that threshold, the pool hands out a dead connection, the next query fails with `connection reset`, and your retry layer (which you should have) masks the bug for months. Set `ConnMaxLifetime` to something shorter than your LB idle timeout, typically 5 minutes. Also set it shorter than any DNS TTL for database hostname changes, so failover promotion takes effect within a bounded window.

### Senior @ FAANG: pool math, prepared statements, and the incident taxonomy

The pool-math formula you want in your head and in runbooks is `active_connections = concurrent_requests / (1 / (query_latency + network_roundtrip))`, which simplifies to `active = throughput * latency`. For a service at 2000 RPS with mean 8ms database time, active is 16. You then ask three questions. First, what is the p99? If p99 is 80ms and p99 throughput is 2000 RPS, the p99 active connections is 160, which is ten times the mean. Your pool size must serve the p99, not the mean, otherwise long-tail queries cause waiter queue buildup and every request regresses. Second, what is the blast radius when one query gets slow? A single unindexed `OR` query that hits a table scan at 2 seconds will occupy a pool slot for 2 seconds. With 16 slots and 8 slow queries per second, your pool is fully consumed by the slow tail and healthy traffic waits. This is pool starvation, and the mitigation is `statement_timeout` at the database (Postgres) and `context.WithTimeout` at Go, with the statement timeout set below the context timeout so the database kills the query before Go gives up (avoids orphaned work on the backend). Third, what is the noisy-neighbor model? If a single tenant can consume half your pool, you need per-tenant pool quotas, either via separate pools keyed by tenant or via a semaphore layered in front of `db.Conn`.

The Postgres `max_connections` ceiling deserves its own treatment. On PG17/18 with modern hardware, the practical ceiling is 500 to 1000 before lock-manager contention (ProcArrayLock, snapshot acquisition) starts to dominate query latency. AWS Aurora Postgres quietly caps this lower on smaller instances. When you hit the ceiling, your options in priority order are: (1) add a pooler (PgBouncer, PgCat, RDS Proxy, Supavisor), (2) reduce per-service pool sizes through platform governance, (3) move read traffic to replicas, (4) shard. Raising `max_connections` is rarely the right answer past a few hundred because Postgres per-backend memory cost is 5 to 15 MB depending on `work_mem` and extensions, and snapshot computation scales with backend count.

Pooler selection is the most consequential ADR in this space. PgBouncer 1.23 in transaction mode is the industry default, multiplexing thousands of client connections onto dozens of backend connections per database. Session mode preserves session state but gives you no multiplexing benefit. Transaction mode is the sweet spot and, critically, PgBouncer 1.21+ supports protocol-level prepared statements in transaction mode against Postgres 14+ (using the `PREPARE`/`EXECUTE` protocol messages rather than SQL-level prepared statements), which unblocks pgx v5 applications that previously had to disable prepared-statement caching via `default_query_exec_mode=exec`. Statement mode is almost never correct for Go applications because it breaks transactions entirely. PgCat 0.4 is a Rust rewrite that adds query routing (read versus write detection via SQL parsing), sharding awareness, and per-shard load balancing, with a cleaner auth layer than PgBouncer's userlist.txt. Supavisor is the Elixir pooler Supabase wrote for multi-tenant serverless, optimized for connection fan-in from thousands of Edge functions. AWS RDS Proxy solves the Lambda cold-start connection storm at the cost of opinionated IAM auth and limited observability. For a typical FAANG-scale Go service against self-managed Postgres, the answer is native pgx pool plus PgBouncer transaction mode, with PgCat worth evaluating if you need query routing or are already sharded.

The incident taxonomy every senior should recognize. Incident type one: connection saturation cascade. Pool fills up during traffic spike, goroutines queue on `db.Conn` acquisition, context timeouts fire, retry storms amplify load, Postgres backend process count hits `max_connections`, health checks fail, load balancer removes pods, survivors take full load, cluster dies. Detection is `pool_wait_duration_seconds` p99 rising before saturation. Mitigation is per-service connection budgets at the pooler and per-endpoint rate limiting in Go. Incident type two: slow-query tail starvation. One bad query plan causes a subset of queries to run 100x slower, pool fills with slow waiters, healthy queries starve. Detection is rising pool-acquire latency with flat query latency p50. Mitigation is `statement_timeout` plus separate pools for OLTP versus analytics workloads. Incident type three: stale connection storm. Primary fails over, load balancer drops old connections, all pods reconnect simultaneously, new primary sees a connection storm, authentication becomes CPU-bound, connections fail, retry storm. Mitigation is jittered reconnect backoff in the driver (pgx v5 `HealthCheckPeriod` plus application-layer exponential backoff) and pre-warming replica promotions via connection draining.

Observability contract. Every production pool must export: `pool_connections_total{state}` (idle, in_use, waiting), `pool_acquire_duration_seconds` (histogram), `pool_acquire_errors_total{reason}` (timeout, closed, canceled), `pool_connection_lifetime_seconds` (histogram on close), and OTEL spans for `db.pool.acquire` that wrap every query. Alert thresholds: warn at 70 percent pool utilization sustained for 5 minutes, page at 90 percent or any acquire timeout. Dashboard panels: pool utilization as a percentage of `MaxOpenConns`, waiter count, acquire p99 latency, connection churn (close rate), and per-query slot occupancy if you can instrument it via context tags.

---
