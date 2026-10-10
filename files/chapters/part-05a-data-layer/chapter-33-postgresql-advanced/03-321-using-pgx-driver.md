## 33.1 Using pgx Driver

### Why pgx?

The `pgx` driver is the recommended PostgreSQL driver for Go when you need access to PostgreSQL-specific features. Unlike `lib/pq`, which communicates over PostgreSQL's text protocol and maps everything through `database/sql` interfaces, `pgx` speaks the binary wire protocol natively. This means integers, timestamps, and UUIDs transfer as their binary representations rather than being serialized to text and parsed back. The result is lower CPU usage per query and direct access to PostgreSQL types like JSONB, arrays, inet, and hstore without manual serialization.

Key advantages over `lib/pq`:

- Native binary protocol reduces serialization overhead
- Built-in connection pooling via `pgxpool` with health checks and idle connection management
- Direct support for PostgreSQL-specific types (`pgtype.JSONB`, `pgtype.Inet`, arrays)
- Batch query execution to pipeline multiple statements over a single round trip
- COPY protocol support for bulk data loading
- LISTEN/NOTIFY support without workarounds

> **Senior track**: `pgx` v5 is the current stable line (v5.9+ as of 2026). Import the direct API (`github.com/jackc/pgx/v5` and `github.com/jackc/pgx/v5/pgxpool`) rather than wrapping through `database/sql` with the `pgx/stdlib` shim. The stdlib path re-encodes values through the text protocol and hides `pgx`-specific features like `Batch`, `CopyFrom`, and `WaitForNotification`. Reach for `pgx/stdlib` only when a third-party library (`sqlx`, a legacy DAO) hard-codes `*sql.DB`.

### Basic Setup

The following example shows a minimal `pgx` setup with connection pooling. The pool manages connections automatically: it creates new connections on demand up to the configured maximum, reuses idle connections, and runs periodic health checks. Each call to `pool.QueryRow` borrows a connection, executes the query, and returns it to the pool.

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/jackc/pgx/v5/pgxpool"
)

func main() {
    ctx := context.Background()

    // Connection pool
    pool, err := pgxpool.New(ctx, "postgres://user:pass@localhost:5432/mydb")
    if err != nil {
        log.Fatal(err)
    }
    defer pool.Close()

    // Query
    var name string
    err = pool.QueryRow(ctx, "SELECT name FROM users WHERE id = $1", 1).Scan(&name)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(name)
}
```

### Pool Configuration

Configuration is expressed as a struct to provide compile-time type safety and enable validation at startup. Grouping all parameters in one place makes it easy to inject them from environment variables, config files, or command-line flags through a single construction path.

```go
func setupPool(ctx context.Context) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig("postgres://user:pass@localhost:5432/mydb")
    if err != nil {
        return nil, err
    }

    // Pool settings
    config.MaxConns = 25
    config.MinConns = 5
    config.MaxConnLifetime = 1 * time.Hour
    config.MaxConnIdleTime = 30 * time.Minute
    config.HealthCheckPeriod = 1 * time.Minute

    // Connection settings
    config.ConnConfig.ConnectTimeout = 5 * time.Second

    // Query settings. Leave this at the default (cache_statement) for most
    // workloads. Override to QueryExecModeExec or SimpleProtocol only when
    // sitting behind PgBouncer in transaction pooling mode, which breaks
    // prepared-statement caching.
    // config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec

    // After connect hook
    config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
        // Set session variables
        _, err := conn.Exec(ctx, "SET timezone = 'UTC'")
        return err
    }

    return pgxpool.NewWithConfig(ctx, config)
}
```

### Junior → FAANG: From `pgx.Connect` to Production-Shaped Code

The prerequisite gap for most juniors is the distinction between `pgx.Conn`, `pgxpool.Pool`, and `pgxpool.Conn`. A `pgx.Conn` is a single physical connection. It is not safe to share across goroutines. A `pgxpool.Pool` is a concurrent-safe pool of `pgx.Conn` objects and is the correct default for any long-running service. A `pgxpool.Conn` is a handle on a single pooled connection that you acquire when you need connection-sticky operations (LISTEN, advisory session locks, `SET LOCAL` outside a transaction). If you see a new codebase using `pgx.Connect` directly in request handlers, that is a bug that will show up as connection exhaustion within days of production traffic.

Worked example. A junior is told to add a "get user by id" endpoint. The code that fails code review looks like:

```go
func GetUser(ctx context.Context, id int) (*User, error) {
    conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
    if err != nil { return nil, err }
    defer conn.Close(ctx)
    var u User
    err = conn.QueryRow(ctx, "SELECT id, name FROM users WHERE id=$1", id).Scan(&u.ID, &u.Name)
    return &u, err
}
```

The reviewer marks this as a blocker for three reasons. First, every call establishes a fresh TCP plus TLS plus auth handshake, which is 10 to 50ms of latency added to a 1ms query. Second, there is no connection limit, so a traffic spike creates a Postgres connection storm and brings the DB down. Third, there is no tracing, no metric, no deadline enforcement. The production-shaped version takes a `*pgxpool.Pool` as a dependency, threads `context.Context` with a deadline, uses `pgx.RowToStructByName` or `pgx.CollectOneRow` for scanning, and runs under an OTEL span. That is the baseline, not an optimization.

Your first-job interview entry point questions. What is `$1` in pgx and why not `?`. Why is `QueryRow` fine for a single row but `Query` plus `rows.Next` plus `rows.Close` needed for a multi-row result, and what happens if you forget `rows.Close`. What is `context.Context` doing here and what does the cancellation cascade look like when a client disconnects. Answer these fluently and you pass the bar for database-adjacent work.

One more trap. `pgxpool.New` accepts a DSN string with pool params as URL query args, such as `?pool_max_conns=25&pool_min_conns=5`. This is fine for quick scripts but loses the typed `AfterConnect`, tracing, and notice hooks. Use `ParseConfig` plus `NewWithConfig` in any real service.

### Senior @ FAANG: pgx v5 Native API, Pool Tuning, Binary COPY, and Middleware

The first staff-level decision is the API boundary choice. There are three Go entry points to Postgres: `database/sql` with `lib/pq`, `database/sql` with `pgx/stdlib`, and the native `pgx/v5` plus `pgxpool` API. In April 2026 the defensible choice for new code is native pgx v5. The two `database/sql` paths give up (a) the binary protocol for all scalar types, (b) `pgx.Batch` pipelining, (c) `CopyFrom` with binary COPY, (d) typed NOTIFY via `WaitForNotification`, (e) custom type registration via `pgtype.Map`, and (f) the v5 tracer interface. The claimed benefit of `database/sql` is portability to other databases, which in practice almost never materializes and is not worth the running perf tax.

Measured deltas to memorize. On a point-select workload of small rows (a `users` table with 5 columns) pgx native binary protocol is typically 20 to 40 percent faster than `database/sql` plus pgx in CPU-bound benchmarks, more on column-heavy workloads. `pgx.Batch` with 100 queries in a single pipeline is 10 to 30x faster than 100 sequential `QueryRow` calls because it eliminates 99 network round trips. `CopyFrom` on bulk inserts is 10 to 20x faster than multi-row INSERT and roughly 3x faster than the `unnest(array)` trick commonly seen in ORMs. These are not micro-benchmarks. They are the difference between one pod and ten pods.

```go
// pgx.Batch pipelining: N queries, one round trip
batch := &pgx.Batch{}
for _, id := range userIDs {
    batch.Queue("SELECT email FROM users WHERE id=$1", id)
}
br := pool.SendBatch(ctx, batch)
defer br.Close()
for range userIDs {
    var email string
    if err := br.QueryRow().Scan(&email); err != nil { return err }
}
```

```go
// CopyFrom binary protocol: bulk ingest at wire speed
rows := [][]any{
    {1, "alice@example.com", time.Now()},
    {2, "bob@example.com", time.Now()},
}
copyCount, err := pool.CopyFrom(ctx,
    pgx.Identifier{"users"},
    []string{"id", "email", "created_at"},
    pgx.CopyFromRows(rows),
)
```

Pool tuning reference for 2026 deployments. `MaxConns` should be set below the Postgres `max_connections` divided by the number of replicas of the service, with headroom for admin connections. A common FAANG default is `MaxConns = 25` per service pod with a Postgres primary tuned to 400 to 800 `max_connections`. `MinConns` is a warm pool floor, usually 2 to 5, and should never be zero for latency-sensitive services because a zero-min pool pays connection setup on the first request after idle. `MaxConnLifetime` should be roughly 30 to 60 minutes to force rotation through Postgres config reloads and TLS cert renewals. `MaxConnIdleTime` should be 5 to 15 minutes to release connections during quiet periods. `HealthCheckPeriod` should be 30 to 60 seconds. Set `MinIdleConns` equal to `MinConns` if you want the pool to proactively refill.

PgBouncer interaction. In transaction pooling mode (the default for PgBouncer at FAANG scale) server-side prepared statements are broken by default because a statement prepared on one pooled connection may not exist on the next one your client is handed. pgx v5 handles this with `QueryExecModeCacheDescribe` or `QueryExecModeSimpleProtocol`. The correct settings depend on which PgBouncer version you run. PgBouncer 1.21+ supports prepared statement tracking (`max_prepared_statements` server-side), and with that enabled the default `QueryExecModeCacheStatement` is safe. On older PgBouncer, switch to `QueryExecModeCacheDescribe` which caches parse descriptions but not on the server. Simple protocol loses all prepared statement benefits and should be the last resort.

Connection lifecycle middleware. A production pool needs four hooks: `BeforeConnect` to inject dynamic credentials (IAM auth on RDS, short-lived Vault creds), `AfterConnect` to set session GUCs (`application_name`, `statement_timeout`, `idle_in_transaction_session_timeout`, `jit` off if you have JIT regressions), `BeforeAcquire` to validate a connection is usable (return false to have the pool retire it), and `AfterRelease` to reset session state before returning to the pool. Skipping any of these is a production incident waiting to happen. The canonical `AfterConnect` at FAANG scale sets `statement_timeout = 30s`, `idle_in_transaction_session_timeout = 60s`, `lock_timeout = 5s`, and `application_name` to the pod identifier for pg_stat_activity attribution.

Tracing. Implement `pgx.QueryTracer` to emit OTEL spans with sanitized SQL (strip string literals, keep the parameterized form) and bind parameter hashes, not values, to avoid PII leakage. pgx v5's tracer interface replaces the v4 `Logger` interface and is strictly better. Attach to `config.ConnConfig.Tracer`.

Staff ADR item. Any service touching Postgres must ship with: (1) `statement_timeout` enforced at the connection level (not just at query context deadline), (2) a `pg_stat_statements`-compatible query fingerprint in logs, (3) connection pool metrics (`AcquiredConns`, `IdleConns`, `TotalConns`, `NewConnsCount`) exposed to the metric backend, (4) circuit breaker on the pool wrapping `Acquire` to fail fast rather than queue under connection exhaustion. Missing any of these is an ADR rejection.

---
