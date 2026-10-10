## 37.8 Connection Pooling with PgBouncer

### Pool Modes: The Compatibility Trade-off

PgBouncer offers three pool modes, and the choice dictates which Postgres features you can use:

| Mode | How it works | Backend conn reuse | Breaks |
|------|--------------|-------------------|--------|
| **session** | Backend bound to client for entire session | Only when client disconnects | Nothing - full Postgres semantics |
| **transaction** | Backend bound per transaction (`BEGIN`/`COMMIT`) | Every transaction | See below |
| **statement** | Backend released per statement | Every statement | Multi-statement transactions entirely |

**Transaction mode is the default for good reason** - it delivers the real 100x connection multiplication. But historically it broke:
- `LISTEN/NOTIFY` - the subscription is bound to a backend connection that gets reassigned.
- Session-scope advisory locks (`pg_advisory_lock`) - use transaction-scope (`pg_advisory_xact_lock`) instead.
- `SET` / `SET LOCAL` that leaks across transactions.
- Temporary tables that persist across transactions.
- **Prepared statements** - the historic showstopper for ORMs and pgx applications.

**The prepared-statement breakthrough (PgBouncer 1.21+, current stable 1.23+):** PgBouncer now tracks prepared-statement names per client and transparently maps them to unique server-side names, preparing them on the backend on first use. Enable with `max_prepared_statements = 100` (or more). pgcat shipped with this support from day one. Benchmarks show 15-30% throughput improvement over the simple protocol because the parse/plan step is cached on the backend. In 2026 there is finally little reason to disable prepared statements with transaction pooling.

### pgcat: The Rust-Based Modern Alternative

pgcat, maintained by the PostgresML team, is a Rust-based Postgres proxy that extends PgBouncer's model with features PgBouncer lacks:

- **Built-in sharding**: configure shards in `pgcat.toml` with a sharding function (consistent hash or custom), and pgcat routes queries by extracting the shard key from a comment hint or a prepared parameter. No application-level routing needed.
- **Automatic read/write splitting**: route `SELECT`s to replicas, writes to primary, with replica health checks and failover.
- **Load balancing across replicas**: random, round-robin, least-outstanding-queries.
- **Mirrored traffic**: send a percentage of queries to a shadow cluster for capacity testing.
- **Prepared statements in transaction mode**: native from v1.
- **TLS 1.3, auth passthrough, prometheus metrics**: modern operational defaults.

When to pick which: **PgBouncer** for maximum maturity, tiny memory footprint, and decades of production mileage. **pgcat** when you need sharding or replica-aware routing without building it yourself, or when you're already a Rust shop. Supabase built its own Elixir-based multi-tenant pooler, Supavisor. Fly.io ships pgcat-style proxies alongside managed Postgres.

### PgBouncer Configuration

PgBouncer is a lightweight connection pooler that sits between the application and PostgreSQL. In transaction pooling mode, it multiplexes thousands of client connections onto a small number of backend connections by reassigning the backend after each transaction completes. The INI file below configures PgBouncer with separate entries for a read-write primary and a read-only replica, along with pool sizing and timeout settings.

```ini
; pgbouncer.ini

[databases]
mydb = host=primary.db.local port=5432 dbname=mydb
mydb_ro = host=replica.db.local port=5432 dbname=mydb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

; Pool mode:
; session - connection assigned for entire session (full Postgres semantics)
; transaction - connection assigned for transaction only (default, best multiplexing)
; statement - connection assigned per statement (breaks multi-statement txns)
pool_mode = transaction

; Pool sizing
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

; Connection limits
max_client_conn = 1000
max_db_connections = 50

; Prepared statements in transaction mode (PgBouncer 1.21+)
; Set to 0 to disable, or a positive number (100-500 typical)
max_prepared_statements = 200

; Timeouts
server_connect_timeout = 15
server_login_retry = 15
query_timeout = 300
query_wait_timeout = 120

; Server health
server_idle_timeout = 60
server_lifetime = 3600

; TLS (always use in production)
server_tls_sslmode = verify-full
server_tls_ca_file = /etc/pgbouncer/ca.crt

; Application name
application_name_add_host = 1
```

### Go Client for PgBouncer

PgBouncer sits between the application and PostgreSQL, multiplexing many application connections onto a small number of actual PostgreSQL backend connections in transaction pooling mode, where the backend connection is returned to the pool after each transaction, not each query. Transaction pooling mode prevents the use of session-level features (prepared statements, `SET` statements, advisory locks) because different transactions from the same application connection may land on different backend connections. Applications using these features must use session pooling mode or manage them explicitly. The Go application connects to PgBouncer as if it were PostgreSQL, with the pool size configured in `pgbouncer.ini` rather than in the application's `sql.DB` settings. Application-level pool settings should be set high enough not to limit PgBouncer's multiplexing.

```go
package database

import (
    "context"
    "database/sql"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/stdlib"
)

// PgBouncerConfig for connecting through PgBouncer
type PgBouncerConfig struct {
    Host     string
    Port     int
    Database string
    User     string
    Password string

    // Pool settings (managed by PgBouncer, not Go)
    MaxConns int
}

// NewPgBouncerDB creates a database connection for PgBouncer
func NewPgBouncerDB(cfg PgBouncerConfig) (*sql.DB, error) {
    connConfig, err := pgx.ParseConfig(fmt.Sprintf(
        "postgres://%s:%s@%s:%d/%s",
        cfg.User, cfg.Password, cfg.Host, cfg.Port, cfg.Database,
    ))
    if err != nil {
        return nil, err
    }

    // Query exec mode - pick ONE based on your PgBouncer version and pool mode:
    //
    //   PgBouncer >= 1.21 with max_prepared_statements > 0, transaction mode:
    //     Leave default (QueryExecModeCacheStatement) - prepared statements work.
    //
    //   Older PgBouncer or max_prepared_statements = 0, transaction mode:
    //     Use QueryExecModeExec (protocol-level, no prepared statements) or
    //     QueryExecModeDescribeExec (describes then executes, no cache).
    //
    //   Session mode:
    //     Leave default. Full Postgres semantics.
    //
    // QueryExecModeSimpleProtocol is almost never the right choice - it disables
    // parameter binding and forces you to escape SQL yourself (injection risk).
    connConfig.DefaultQueryExecMode = pgx.QueryExecModeExec

    connStr := stdlib.RegisterConnConfig(connConfig)
    db, err := sql.Open("pgx", connStr)
    if err != nil {
        return nil, err
    }

    // Let PgBouncer manage pooling, keep Go's pool minimal
    db.SetMaxOpenConns(cfg.MaxConns)
    db.SetMaxIdleConns(cfg.MaxConns / 2)

    return db, nil
}

// PgBouncerHealthCheck checks PgBouncer health
func PgBouncerHealthCheck(ctx context.Context, db *sql.DB) error {
    // Simple query that doesn't require server connection
    _, err := db.ExecContext(ctx, "SELECT 1")
    return err
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Every junior engineer eventually learns the same lesson the hard way. Postgres uses a process per connection model, each connection costs about 10 MB of RAM, and a single Postgres primary starts to degrade badly past 200 to 500 concurrent connections regardless of how much RAM you throw at it. Your Go service scales to 50 pods, each pod has a `sql.DB` pool of 25 connections, and suddenly you have 1250 connections hammering Postgres and pg_stat_activity shows half of them idle. That is why pgBouncer exists.

A worked example. Without pgBouncer: 50 Go pods, 25 connections each, 1250 Postgres backends, 12 GB of RAM consumed just by idle connections, and Postgres contention on `ProcArrayLock` starts to dominate. With pgBouncer in transaction mode: 50 Go pods still think they have 25 connections each, pgBouncer presents itself as Postgres, but pgBouncer holds only 50 actual backend connections to Postgres and multiplexes the 1250 client connections onto them by grabbing a backend at `BEGIN` and releasing it at `COMMIT`. Postgres sees 50 backends. RAM usage drops by a factor of 25. Throughput often goes up because there is no longer contention on Postgres internal locks.

Entry level interview questions. Why is transaction pooling mode the default. Because it delivers the real connection multiplication while breaking fewer features than statement mode. Why did prepared statements traditionally break. Because a prepared statement is bound to a specific backend connection, and transaction pooling reassigns backends after every COMMIT, so the next transaction lands on a different backend that has never seen the PREPARE. What changed in pgBouncer 1.21. It now tracks prepared statement names per client and silently re prepares on whichever backend it hands you, solving the problem that forced every Go shop to disable prepared statements for a decade. What is `server_reset_query` and why is it important. It is the SQL pgBouncer runs when releasing a backend back to the pool (typically `DISCARD ALL`) to wipe session state, prepared statements, temp tables, and SET variables so the next client gets a clean backend.

If you are setting up pgBouncer for the first time, the two knobs that matter most are `pool_mode = transaction` and `default_pool_size` sized to roughly equal to the number of Postgres CPUs plus some headroom. Everything else is defaults until something breaks.

### Senior @ FAANG: pgBouncer Operational Patterns and Modern Alternatives

pgBouncer is the most deployed piece of Postgres infrastructure in production and also the most operationally quiet piece most senior engineers have never actually tuned. That is a problem because its failure modes are subtle and its operational commands are essential for zero downtime database work.

The admin console is the unsung hero. Connect as `psql -p 6432 pgbouncer` as the admin user and you get a set of commands that are how you run a Postgres cluster in production. `SHOW POOLS` tells you how many client connections, active backends, waiting clients, and idle backends each database and user pair has right now, and if the `cl_waiting` column is non zero you have either undersized your pool or have long running transactions holding backends. `SHOW SERVERS` shows the state of every backend connection and its current client. `SHOW STATS` gives you total queries, total query time, and average query time per database, which is often the cleanest latency signal you have because it is at the pooler rather than inside the app. `SHOW MEM` tells you how much memory pgBouncer itself is using, important at large scale because pgBouncer is single threaded and its memory must fit in one core's L3 if you care about jitter.

`PAUSE` and `RESUME` are how you do zero downtime failover. The sequence for promoting a replica. First, `PAUSE dbname` at pgBouncer, which waits for in flight transactions to complete and then holds new queries at the pooler (clients see latency but not errors). Second, promote the replica at the Postgres level with `pg_ctl promote` or your managed service API. Third, update pgBouncer's database target (reload the config with `RELOAD` after editing `pgbouncer.ini`, or use the admin command to change the target). Fourth, `RESUME dbname`. Clients never saw a connection error, only a brief latency spike. This is how Instagram, Notion, Figma, and essentially everyone running sharded Postgres does failover. Without pgBouncer, every failover is a connection error storm and every client library's retry logic gets stressed.

`query_wait_timeout` deserves careful attention. It is how long a client will wait in the pgBouncer queue for a backend before pgBouncer returns an error. The default of 120 seconds is insane for a web tier and should be lowered aggressively to something like 5 to 10 seconds. Otherwise, during a pool exhaustion event, requests pile up at pgBouncer, your service worker pool fills with waiting requests, and the whole application stack goes into a retry storm that makes the original problem worse. Combine with `server_connect_timeout` at 5 seconds and `server_login_retry` at 2 seconds to bound worst case latency of establishing a new backend connection. Observability wise, `cl_waiting` from `SHOW POOLS` must be a dashboard panel and a PagerDuty alert.

`server_reset_query` is `DISCARD ALL` by default, which resets prepared statements, temp tables, SET state, session advisory locks, cursors, and sequences. Removing it is a footgun that leaks state across tenants. Changing it to something lighter (like `RESET ALL`) is occasionally advocated for latency but rarely worth the complexity. The only case where you want to tune it is if you have a session level GUC that you want to persist across pool checkouts, and even then the right answer is usually to set it per transaction.

pgBouncer plus PITR is where database restore operations get interesting. Point in time recovery targets a specific LSN or timestamp, but pgBouncer has been routing writes through at arbitrary times and your application has no idea which write landed at which LSN. The operational pattern is to pause pgBouncer before initiating PITR, drain all in flight transactions, take the PITR snapshot, then point pgBouncer at the restored cluster and resume. Never PITR a live cluster without coordinating with the pooler, or you will see phantom writes that the application thinks committed but PITR rolled back.

PgCat (the Rust rewrite and extension, maintained by PostgresML) is the 2024 to 2026 evolution and is where sophisticated Postgres shops are moving. Its differentiators over pgBouncer. First, built in sharding by consistent hash with shard key extracted from SQL comments like `/* shard_id: 42 */` or from bind parameters. Second, automatic primary and replica routing with `SET SERVER ROLE` hints, which lets the application explicitly say "this query can go to a replica". Third, native prepared statements from day one with no `max_prepared_statements` limit headaches. Fourth, load balancing algorithms beyond round robin including least outstanding queries, which is critical for tail latency. Fifth, mirrored traffic for shadow deployment and capacity testing. Sixth, Prometheus metrics native, not via a sidecar. Seventh, it is multi threaded, so a single PgCat instance can saturate more than one core, unlike pgBouncer which tops out at whatever one core can do. The trade off is that PgCat is younger and has a smaller operational track record than PgBouncer, though it has real adopters among sharded-Postgres shops.

pgbouncer scaling patterns at FAANG. One pgBouncer per database primary, sized for the primary's `max_connections`. One pgBouncer per application pod (sidecar) to reduce network hops but lose cross pod multiplexing, used by some teams. Two tier pooling where each pod has a local pgBouncer in session mode pointing at a central pgBouncer in transaction mode, useful for LISTEN/NOTIFY workloads that cannot use transaction mode end to end. Sharded pgBouncer where each shard has its own pgBouncer and a higher level router (PgCat, Vitess) picks the shard. Instagram runs a flavor of the last pattern at scale. Notion runs 480 logical Postgres shards across dozens of physical instances (published in 2021 and 2023), fronted by a PgBouncer tier.

Failure modes that cause incidents. First, long running transactions in transaction mode. A transaction that holds a backend for 30 seconds starves every other client of that backend for 30 seconds. Set `idle_in_transaction_session_timeout` on Postgres to 30 to 60 seconds and `idle_transaction_timeout` on pgBouncer to match. Second, client authentication storms when a new deployment starts 50 pods simultaneously and each one opens 25 connections. pgBouncer handles this fine but Postgres auth has surprisingly high cost, use `auth_type = scram-sha-256` and `auth_query` pointing at a cached user table. Third, TLS renegotiation cost. Use `server_tls_sslmode = verify-full` with session tickets enabled. Fourth, pgBouncer itself being single threaded and becoming the bottleneck at around 50k to 100k queries per second on a single instance. Scale horizontally by running multiple pgBouncer instances behind a TCP load balancer like HAProxy or AWS NLB with consistent hash stickiness. Fifth, the `unix_socket_dir` is shared between pgBouncer processes but each one has its own pool, so you do not get cross process multiplexing inside a single host without external coordination.

Monitoring that matters. Export `pgbouncer_exporter` to Prometheus. Alert on `cl_waiting` greater than zero for more than 30 seconds. Alert on `sv_active` equal to `pool_size` for more than 30 seconds (pool exhaustion). Alert on `avg_query_time` doubling versus 1 hour baseline. Track `total_xact_count` and `total_query_count` to detect transaction inflation (someone wrapping single queries in explicit transactions unnecessarily, which halves effective throughput in transaction mode).

---
