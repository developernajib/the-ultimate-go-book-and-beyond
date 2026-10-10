## 37B.10 Connection Pooling Internals

### Why Connection Overhead Is Expensive

In PostgreSQL, **each connection is a separate OS process** (not a thread). This has significant overhead:

```
Per-connection cost in PostgreSQL:
  - Fork: ~1-2ms to spawn process
  - Memory: ~5-10MB per backend process (shared_buffers overhead, local memory)
  - Authentication: TLS handshake + auth protocol
  - Startup: parameter loading, catalog cache initialization

For 1000 concurrent connections:
  - Process overhead: ~1,000 processes
  - Memory: ~5-10 GB just for connection overhead
  - OS scheduler: managing 1000 processes adds latency
```

**Recommended maximum connections**: `max_connections` should not exceed:
- `(number of CPU cores * 2) + effective_io_concurrency`
- Typical: 100-300 for OLTP, use a connection pooler for more

### PgBouncer: Transaction vs Session Pooling

PgBouncer maintains a small pool of actual PostgreSQL connections and multiplexes many client connections onto them:

```
PgBouncer Architecture:

Clients (thousands) --> PgBouncer (lightweight proxy) --> PostgreSQL (dozens of connections)
                         - holds pool of server connections
                         - assigns server conn to client conn as needed
```

**Session pooling**: A server connection is held for the entire client session.
- Client connects -> gets dedicated server connection -> client disconnects -> connection returned to pool
- Use when: client uses session-level state (SET, temporary tables, prepared statements)
- Concurrency gain: minimal (one server conn per client session)

**Transaction pooling** (recommended for web apps):
- Server connection is held only for the duration of a transaction
- Client can interleave with other clients between transactions
- Concurrency gain: 10-100x (1000 client connections -> 10-50 server connections)
- **Restriction**: Cannot use session-level features (prepared statements, advisory locks, SET)

```
# pgbouncer.ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction         # transaction pooling
max_client_conn = 10000         # clients PgBouncer accepts
default_pool_size = 25          # server connections per database/user pair
min_pool_size = 5               # keep this many idle server connections
reserve_pool_size = 5           # extra connections for emergencies
server_idle_timeout = 600       # close idle server connections after 10 min
client_idle_timeout = 0         # don't close idle clients
```

### Connection Pool Sizing Formula

A well-known formula from the HikariCP documentation:

```
pool_size = T_w / T_s

Where:
  T_w = total time waiting + executing per second across all threads
  T_s = average time a query holds a connection (seconds)

More practical formula:
  pool_size = (core_count * 2) + effective_disk_spindles

For a 4-core server with SSDs:
  pool_size = (4 * 2) + 1 = 9

For a 16-core server with SSDs:
  pool_size = (16 * 2) + 1 = 33

Rule of thumb: Start with N_cores * 2, adjust based on monitoring.
A small pool + fast queries beats a large pool + slow queries.
```

### Go: pgxpool and database/sql Pool Settings

The `pgxpool` package provides connection pooling out of the box. The key configuration decisions are pool size, connection lifetime, and idle timeout. Setting `MaxConns` too high wastes memory and increases contention on the PostgreSQL side. Setting it too low causes queries to queue at the pool layer. The `PgBouncerSafeDSN` helper shows how to configure pgx for compatibility with PgBouncer's transaction pooling mode, which requires disabling prepared statement caching.

```go
package pooling

import (
    "context"
    "fmt"
    "net/url"
    "runtime"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a properly configured pgxpool.
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(dsn)
    if err != nil {
        return nil, fmt.Errorf("parse dsn: %w", err)
    }

    // Pool size: start with 2x CPU cores
    poolSize := int32(runtime.NumCPU() * 2)
    if poolSize < 4 {
        poolSize = 4
    }

    config.MaxConns = poolSize
    config.MinConns = poolSize / 4 // keep 25% warm

    // Connection lifetime settings to prevent stale connections
    config.MaxConnLifetime = 30 * time.Minute  // recycle connections periodically
    config.MaxConnIdleTime = 5 * time.Minute   // close idle connections
    config.HealthCheckPeriod = 1 * time.Minute // background health check

    // Connection timeout: fail fast rather than queue indefinitely
    config.ConnConfig.ConnectTimeout = 5 * time.Second

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("create pool: %w", err)
    }

    // Verify pool works
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("ping pool: %w", err)
    }

    return pool, nil
}

// PgBouncerSafeDSN adds pgbouncer-compatible parameters to a DSN.
// In transaction pooling mode, prepared statements are disabled.
func PgBouncerSafeDSN(host, port, user, password, dbname string) string {
    params := url.Values{}
    params.Set("sslmode", "require")
    // Disable pgx prepared statement cache -- incompatible with PgBouncer transaction mode
    params.Set("default_query_exec_mode", "simple_protocol")

    return fmt.Sprintf(
        "postgres://%s:%s@%s:%s/%s?%s",
        url.QueryEscape(user),
        url.QueryEscape(password),
        host, port, dbname,
        params.Encode(),
    )
}
```

### Connection Pool Metrics to Monitor

Monitoring pool statistics tells you whether your pool is correctly sized. The `pgxpool.Stat()` method exposes the current state of the pool: how many connections are acquired, idle, or being constructed.

```go
// PoolMetrics returns key pool statistics for monitoring.
func PoolMetrics(pool *pgxpool.Pool) map[string]int32 {
    stats := pool.Stat()
    return map[string]int32{
        "total_connections":    stats.TotalConns(),
        "idle_connections":     stats.IdleConns(),
        "acquired_connections": stats.AcquiredConns(),
        "constructing":         stats.ConstructingConns(),
        "max_connections":      stats.MaxConns(),
        // Derived: utilization ratio = acquired / max
    }
}
```

**Key metrics to alert on**:
- Pool utilization > 80%: approaching saturation, queries will queue
- `AcquiredConns` == `MaxConns`: pool exhausted, queries blocked
- `ConstructingConns` > 0 frequently: pool is too small (creating connections under load)
- Connection wait time > 10ms: pool too small for the workload

### Junior to FAANG: Pooling Without Foot-Guns

The first misconception is that bigger pools equal more throughput. They do not. Postgres throughput tops out near 2x to 4x CPU cores under OLTP because each additional active backend adds lock contention, buffer pool pressure, and scheduler noise. A pool of 200 on a 16-core database will perform worse than a pool of 40. Your mental model should be: the pool is a queue in front of a bounded worker pool, and the optimal worker count depends on the machine, not on how many users you expect.

Worked example. Your service runs 10 pods, each with a pgx pool of MaxConns 50. That is 500 possible server connections against a 16-core database. Under load, p99 latency explodes even though CPU on the database is at 40 percent. The issue is not database CPU, it is LWLock contention and context switching from 500 processes competing. Reduce per-pod pool to 5 to 8, put PgBouncer in transaction pooling mode in front, and you now serve the same workload with 50 real backends and much lower latency.

Interview entry-points:
- Why does Postgres use one process per connection? Historical design choice (inherited from Berkeley Postgres) that trades memory efficiency for fault isolation and simpler memory management. Each backend crash does not take down the whole server.
- Why is transaction pooling incompatible with prepared statements by default? Because a PREPARE names a plan on a specific backend. If the next transaction lands on a different backend, the name is unknown.
- What happens if MaxConns exceeds the Postgres max_connections limit? Clients time out waiting for connections that the database will refuse.

### Senior at FAANG: PgBouncer Internals, Session State, and Advanced Poolers

PgBouncer process architecture. PgBouncer is a single-process, single-threaded event loop built on libevent. It cannot use more than one CPU core. This is fine for 99 percent of deployments because the proxy work per request is tiny. When you do need more, the answer is not "make PgBouncer multi-threaded" (the project has resisted that for 15 years), it is to run multiple PgBouncer processes behind a TCP load balancer, sharded by database or user, or to deploy PgBouncer as a sidecar per application pod. PgBouncer 1.22 added SO_REUSEPORT support that lets multiple processes share a port.

Transaction boundary detection. PgBouncer parses the frontend protocol looking for commits, rollbacks, and idle state. The canonical signal is ReadyForQuery with transaction-status byte 'I' (idle, outside transaction). At that moment the server connection is safe to return to the pool. The pitfall is that any session-level state set between transactions (SET search_path, SET LOCAL at transaction-level is fine, but session-level SETs leak) persists on the pooled server. PgBouncer mitigates this with server_reset_query = DISCARD ALL in session pooling mode, but in transaction pooling mode there is no reset point, so the application must avoid session-level state entirely.

Session state pinning. Certain operations force PgBouncer to pin a client to a specific server connection until the pin releases. These include LISTEN/NOTIFY, advisory locks (pg_advisory_lock), WITH HOLD cursors, and server-side prepared statements. Pinning collapses concurrency: if every client issues LISTEN, you are effectively back in session pooling. Detection: pgbouncer SHOW POOLS shows sv_used and cl_active, and if cl_active is high while sv_used is low and waiting, pinning is likely the cause. Mitigation: use PUB/SUB via dedicated listener connections, not pool connections.

Prepared statements in transaction pooling. Historically, enabling pgx prepared statement cache with PgBouncer transaction mode caused "prepared statement does not exist" errors because the statement was prepared on one backend and the next transaction landed on another. Two solutions emerged:
1. PgBouncer 1.21+ (October 2023) added server-side prepared statement tracking. The proxy caches the statement and re-issues PREPARE on any backend that has not seen it. Configure with max_prepared_statements = 100 (or higher). Most production PgBouncer deployments in 2026 run with this enabled.
2. Disable prepared statements client-side via pgx's default_query_exec_mode = simple_protocol. This loses protocol-level parameter binding (parameters are inlined as literals by pgx), which opens SQL injection risk if the driver's escaping has a bug. Prefer option 1.

Pipelining interaction. Pipelining (pgx's SendBatch, libpq's PQpipelineSync) sends multiple commands before reading any responses, amortizing RTT. PgBouncer passes pipelines through but measures transaction boundaries on ReadyForQuery. A pipelined batch that spans multiple transactions returns the server connection to the pool between each transaction, which can interleave with other clients' pipelines and produce subtle ordering surprises if the batch is not wrapped in a single explicit transaction.

Authentication and auth_query. With per-pod PgBouncer sidecars, the connection count on the primary is still governed by PgBouncer's pool size, but authentication must still happen. auth_type = scram-sha-256 and auth_query = "SELECT uname, phash FROM users WHERE uname = $1" let PgBouncer validate credentials against a shadow table without talking to pg_authid directly, which matters when the application role differs from the admin role.

Odyssey (Yandex's pooler) vs PgBouncer. Odyssey is multi-threaded and supports TLS termination per worker thread, aimed at very high connection counts (100K+). It is used in production at Yandex, Mail.ru, and others. It supports the same transaction and session pooling modes plus a "storage routing" mode that routes by logical database. For most teams PgBouncer is sufficient. Odyssey wins when the single-core PgBouncer ceiling is actually hit, which usually requires 50K+ concurrent clients.

PgCat. PgCat is a Rust-based pooler with features PgBouncer lacks: sharding based on query parsing, read/write split detection from query content, and multi-threaded TCP handling. Its query parser uses the pg_query.rs library (the Postgres grammar compiled as a library) to classify statements. A SELECT with FOR UPDATE goes to primary, and a plain SELECT can go to a replica based on configured shards. The sharding key can be extracted from the WHERE clause, so that SELECT ... WHERE tenant_id = $1 automatically routes to the shard holding that tenant. The limitation is that PgCat's routing is only as good as its parser understands your schema. Multi-statement transactions that cross shards are rejected, which forces application awareness.

Supavisor (Supabase). A newer Elixir/Erlang-based pooler designed for massive multitenancy. Built for cases where you have thousands of tenant databases and need per-tenant pooling. Different target than PgBouncer.

Pool sizing beyond (cores * 2 + 1). The HikariCP formula assumes disk-bound workloads where each connection spends most of its time waiting. For in-memory OLTP the constant is closer to cores, not 2x cores. For analytical queries that each use multiple workers (parallel seqscan), the constant shrinks further because each query already consumes multiple cores. Staff-level tuning instruments: pg_stat_statements + pg_wait_sampling extensions together tell you the mix of CPU, LWLock, Buffer, IO, and Client waits per query class, and the pool size that produces maximum throughput without excessive LWLock contention is the answer.

pgxpool quirks. MinConns is a soft target, and connections below MinConns are reopened lazily on demand rather than proactively. If your app needs warm connections for cold-start latency, call AcquireAllIdle on startup. HealthCheckPeriod defaults to 1 minute and runs a lightweight check on idle connections, and shorter periods mask network-blip failures but add load. MaxConnLifetime must be shorter than any upstream timeout (load balancer idle timeout, kernel TCP keepalive) to avoid surprise RST on dormant connections. Typical production setting: MaxConnLifetime = 30min, MaxConnIdleTime = 5min, HealthCheckPeriod = 30s.

Queue depth and circuit breaking. A healthy pool under sustained load queues some requests briefly. Unbounded queuing is a failure mode: if the database is slow, every goroutine waits, memory balloons, and the service OOMs before the database recovers. Wrap pool acquisitions in a context.WithTimeout (100ms to 500ms for OLTP) and shed load on timeout by returning 503. Pair with a circuit breaker per backend so that a degraded database triggers fast-fail rather than queue-of-death behavior.

Observability. Export pgxpool.Stat to Prometheus as gauges. Alert on (AcquiredConns / MaxConns) > 0.8 for more than one minute, on ConstructingConns > 0 sustained, and on acquire-wait p99 > 10ms. Cross-reference with pg_stat_activity state distribution: idle-in-transaction count is the single most predictive signal of pool exhaustion, because a single long-open transaction can pin one server connection per transaction and starve the pool.

---
