## 32.1 The database/sql Package

### Basic Connection

The `database/sql` package does not talk to any database on its own. It provides a generic interface that concrete drivers implement. Importing a driver with a blank identifier registers it against the `sql` package's internal registry, and calling `db.Ping()` after `sql.Open` is the canonical way to confirm the connection string is valid and the server is reachable before the application begins serving traffic.

> **Senior track**: In 2026 the dominant Postgres driver is `github.com/jackc/pgx/v5`. Use `pgx/stdlib` when you want to keep the `database/sql` interface (shown below), or use pgx's native API (`pgxpool.Pool`) directly when you want binary protocol performance, `COPY`, `LISTEN/NOTIFY`, or first-class numeric/array types. The older `github.com/lib/pq` is in maintenance mode and should not be used for new code. For MySQL use `github.com/go-sql-driver/mysql`. For SQLite choose `modernc.org/sqlite` (pure Go, no cgo) or `github.com/mattn/go-sqlite3` (cgo, faster).

```go
package main

import (
    "context"
    "database/sql"
    "log"
    "time"

    _ "github.com/jackc/pgx/v5/stdlib" // PostgreSQL driver (pgx, preferred in 2026)
)

func main() {
    // Connection string
    dsn := "host=localhost port=5432 user=postgres password=secret dbname=myapp sslmode=disable"

    // Open connection pool (driver name is "pgx" for pgx/stdlib)
    db, err := sql.Open("pgx", dsn)
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    // Verify connection with a bounded context - db.Ping() alone can block
    // forever if the network silently drops packets.
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        log.Fatal(err)
    }

    log.Println("Connected to database")
}
```

### Connection Pool Configuration

`sql.DB` manages an internal connection pool, so tuning its parameters is one of the most impactful performance levers available. **The defaults are not production-safe**: `MaxOpenConns` defaults to unlimited (your app can trivially exhaust Postgres's `max_connections` of ~100 and take the database down), `MaxIdleConns` defaults to just 2 (every burst of traffic reopens TCP connections), and `ConnMaxLifetime` defaults to zero (connections live forever and die silently when a firewall/load balancer expires them). Always configure all four explicitly.

Setting `MaxOpenConns` prevents your application from overwhelming the database server, `MaxIdleConns` controls how many idle connections are kept warm for reuse, and the lifetime/idle-time limits ensure stale connections behind load balancers or NAT devices are replaced before they produce cryptic errors.

> **Senior track**: Size `MaxOpenConns` to `min(P95_concurrent_requests, db_max_connections / num_app_replicas)`. If your DB allows 100 connections and you run 10 replicas, a per-pod cap of 25 is already oversubscribed - prefer 8, 10 with room to spare. Keep `MaxIdleConns <= MaxOpenConns` and usually equal to it under steady load (cheap to hold idle, expensive to reopen). Set `ConnMaxLifetime` shorter than the shortest idle timeout in your network path (AWS NLB: 350s, most firewalls: 300s - so 5 minutes is already too close to the edge, prefer 2-4 minutes). `ConnMaxIdleTime` is the newer knob (Go 1.15+) and matters most for bursty workloads: hold connections for reuse, but return them before the server reaps them.

```go
func setupDatabase() (*sql.DB, error) {
    db, err := sql.Open("pgx", dsn)
    if err != nil {
        return nil, err
    }

    // Connection pool settings - tune for your workload and DB capacity.
    db.SetMaxOpenConns(25)                  // Hard ceiling on total connections
    db.SetMaxIdleConns(25)                  // Match MaxOpenConns to avoid churn
    db.SetConnMaxLifetime(30 * time.Minute) // Recycle before DB/network idle timeouts
    db.SetConnMaxIdleTime(5 * time.Minute)  // Drop idle conns during quiet periods

    return db, nil
}
```

### Driver Registration

Each database driver registers itself under a string name when its `init` function runs, which is why a blank import is sufficient to make it available. The import path alone determines which driver is registered, so you can swap database backends by changing a single import line without touching any query code.

```go
import (
    _ "github.com/jackc/pgx/v5/stdlib" // PostgreSQL (preferred, driver name "pgx")
    _ "github.com/go-sql-driver/mysql" // MySQL/MariaDB (driver name "mysql")
    _ "modernc.org/sqlite"             // SQLite pure-Go (driver name "sqlite")
)
```

> **Senior track**: If you want compile-time-checked queries, pair `database/sql` with [`sqlc`](https://sqlc.dev). You write plain SQL in `.sql` files annotated with query names. `sqlc generate` produces strongly typed Go functions and result structs. Type mismatches, renamed columns, and bad parameter counts fail at code-gen time, not in production. It has become the default "type-safe SQL" choice in the Go ecosystem in 2026, and pairs naturally with either `database/sql` or the pgx driver. For teams that want a query builder rather than code-gen, [`Bun`](https://bun.uptrace.dev) and [`squirrel`](https://github.com/Masterminds/squirrel) are common. Avoid full ORMs (GORM, Ent) for performance-critical paths - the abstractions hide N+1s.

### Junior to FAANG: connecting, pinging, and the blank import

Before you touch anything else, make sure you understand why `_ "github.com/jackc/pgx/v5/stdlib"` has an underscore. Go requires every imported package to be used. The blank identifier tells the compiler "I am importing this package only for its side effects." The side effect is the package's `init()` function, which calls `sql.Register("pgx", &Driver{})`. After that registration, `sql.Open("pgx", dsn)` can find the driver. If you remove the underscore, the compiler demands you use the package, and you have no reason to.

The second junior trap is believing `sql.Open` opens a connection. It does not. It validates the driver name and returns a `*sql.DB` handle with zero live connections. The first real connection is opened lazily on the first `Query`, `Exec`, or explicit `Ping`. That is why every production startup sequence calls `db.PingContext(ctx)` before declaring the service ready. Without it your readiness probe will pass on a service that cannot actually reach Postgres.

Worked example for your first job: write a `NewDB(ctx, dsn) (*sql.DB, error)` constructor that opens, sets pool knobs (`MaxOpenConns=25`, `MaxIdleConns=25`, `ConnMaxLifetime=30m`, `ConnMaxIdleTime=5m`), and pings with a 5-second timeout. Return the `*sql.DB` or an error. Write a unit test that fails if the DSN is malformed. That is a reviewable artifact you can bring to an interview.

First-job interview entry-point: "what happens when you call `sql.Open`" and "what do each of the four pool knobs do." Nail these two answers and you have already outperformed most juniors.

### Senior at FAANG: pool math, pgx native, and prepared statement lifetime

The pool configuration example above (`MaxOpenConns=25`) is the starting point, not the answer. The senior-level formula for a Postgres service is this. Let `M` be the database `max_connections` (default 100 in Postgres, typically 200 to 500 in managed offerings), let `A` be the admin reserve (10 connections for `psql`, monitoring, replication), let `R` be the number of application replicas at peak, and let `P` be the per-pod pool size. The invariant is `R * P <= M - A`. In practice you multiply this by 0.8 to leave headroom for failovers and deploys when replica count transiently doubles. With `M=200`, `A=10`, `R=30`, you get `P <= (200-10)*0.8/30 = 5`. Five connections per pod. If your workload needs more, you put pgBouncer in front and size the pgBouncer pool at 150 with application pools sized at 50 per pod against pgBouncer's virtual pool.

`ConnMaxLifetime` is not only about idle firewalls. It is about cached query plan staleness. Postgres caches plans per prepared statement per connection. When you run `ALTER TABLE ... ADD COLUMN` or change an index, plans referencing the affected relations must be regenerated. pgx handles this at the protocol level, but lib/pq and older drivers will fail with `cached plan must not change result type` until the connection cycles. A 30-minute `ConnMaxLifetime` bounds the window of stale plans after DDL to 30 minutes. During an emergency schema change, temporarily drop it to 1 minute with `db.SetConnMaxLifetime(1 * time.Minute)`.

**pgx native versus database/sql.** The chapter example uses pgx through `database/sql`. At staff level the decision to migrate to `pgxpool.Pool` directly is an ADR. The wins: binary protocol eliminates text-mode integer and timestamp parsing (measured 5 to 15% CPU reduction in hot paths), `Batch` sends multiple queries in a single round trip (useful for dashboards that load 10 widgets per render), `CopyFrom` ingests data 10 to 100 times faster than `INSERT` (important for ETL and bulk import), and native types for `jsonb`, `uuid`, arrays, and ranges avoid lossy string conversion. The costs: you lose `*sql.DB` abstractions, so `sqlmock` tests must be rewritten against `pgxmock`, and cross-database portability is gone. For a Postgres-only shop, the ADR is straightforward: pgx native for new services, database/sql for legacy until it is worth migrating.

**Prepared statement cache.** pgx maintains a per-connection named-prepared-statement cache with LRU eviction (default 512 entries). The first execution of a query sends `Parse` and `Bind`, subsequent executions send only `Bind`. In transaction pooling mode with pgBouncer, session-scoped named statements are not portable across transactions, so pgx uses unnamed prepared statements (`DescribePortal` protocol) that live for one execution but still benefit from the binary format. This is why pgx works under pgBouncer and lib/pq does not. Document this in the ADR when you choose your driver.

**sqlc versus GORM versus ent.** The 2026 consensus at FAANG-tier Go shops: sqlc for new services, ent when the domain is graph-shaped (social graph, org hierarchy, permissioning), GORM essentially never. sqlc's advantage is transparency. The generated code is reviewable Go. You can `git diff` the generated output when you change a query and see exactly what will execute. GORM generates SQL at runtime through reflection, and the only way to know what hits the database is enabling `Logger.LogMode(logger.Info)` in staging and reading the log. That is not an acceptable debugging story for a service handling money. ent sits between the two: it generates code like sqlc but from a schema DSL rather than raw SQL, and it is genuinely good at traversal-heavy workloads. For a typical CRUD service with joins and aggregations, sqlc is the default.

**Driver selection for non-Postgres.** For MySQL 8.4 or 9.x, `go-sql-driver/mysql` is the only serious choice. For SQLite, `modernc.org/sqlite` (pure Go, slower but CGO-free) for portable builds, `mattn/go-sqlite3` (CGO, faster) when you already have a CGO toolchain. For ClickHouse, `clickhouse-go/v2`. For distributed SQL (CockroachDB, YugabyteDB, Spanner), use their PG-wire compatible endpoint with pgx, except for Spanner where the native `cloud.google.com/go/spanner` client is required for correct exponential backoff on `ABORTED` transactions.

---
