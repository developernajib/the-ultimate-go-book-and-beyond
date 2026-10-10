## Database Architecture Overview

The diagram below maps the layers between the application and the database: connection pooling, query building, result scanning, and error handling. Each layer is responsible for a distinct concern, making the stack easier to test, debug, and evolve.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Go Application Database Layer                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                        Application Code                              │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │    │
│  │  │   Handler   │  │   Service   │  │  Repository │  │    Model    │  │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘  │    │
│  │         │                │                │                          │    │
│  │         └────────────────┴────────────────┘                          │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
│  ┌──────────────────────────────┴───────────────────────────────────────┐    │
│  │                      database/sql Package                            │    │
│  │  ┌────────────────────────────────────────────────────────────────┐  │    │
│  │  │                     *sql.DB (Connection Pool)                  │  │    │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │  │    │
│  │  │  │  Conn 1  │ │  Conn 2  │ │  Conn 3  │ │  Conn N  │  ...      │  │    │
│  │  │  │  (idle)  │ │  (busy)  │ │  (idle)  │ │  (busy)  │           │  │    │
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │  │    │
│  │  └────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                      │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │    │
│  │  │  Query/Exec     │  │  Transactions   │  │  Prepared Stmt  │       │    │
│  │  │  QueryRow       │  │  BeginTx        │  │  Prepare        │       │    │
│  │  │  QueryContext   │  │  Commit/Rollback│  │  Statement Pool │       │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
│  ┌──────────────────────────────┴───────────────────────────────────────┐    │
│  │                       Database Driver                                │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                │    │
│  │  │   lib/pq     │  │  pgx/v5      │  │  go-mysql    │  ...           │    │
│  │  │  (postgres)  │  │  (postgres)  │  │  (mysql)     │                │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │ TCP/Unix Socket
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Database Server                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                        │
│  │  PostgreSQL  │  │    MySQL     │  │   SQLite     │  ...                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                        │
└──────────────────────────────────────────────────────────────────────────────┘

Connection Pool Lifecycle:
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   Application Request                                                      │
│          │                                                                 │
│          ▼                                                                 │
│   ┌─────────────┐    No idle     ┌─────────────┐    Pool full              │
│   │ Get Conn    │───connection──►│ Create New  │───────────────► Wait      │
│   └─────────────┘                └─────────────┘                           │
│          │                              │                                  │
│          │ Idle conn available          │ New conn created                 │
│          ▼                              ▼                                  │
│   ┌─────────────────────────────────────────────────┐                      │
│   │              Execute Query/Transaction          │                      │
│   └─────────────────────────────────────────────────┘                      │
│                         │                                                  │
│                         ▼                                                  │
│   ┌─────────────────────────────────────────────────┐                      │
│   │              Return Conn to Pool                │                      │
│   │  (or close if MaxLifetime/MaxIdleTime exceeded) │                      │
│   └─────────────────────────────────────────────────┘                      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Query Execution Flow:
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   1. Query("SELECT * FROM users WHERE id = $1", id)                        │
│      │                                                                     │
│      ▼                                                                     │
│   2. Acquire connection from pool                                          │
│      │                                                                     │
│      ▼                                                                     │
│   3. Send query to database                                                │
│      │                                                                     │
│      ▼                                                                     │
│   4. Database parses, plans, executes                                      │
│      │                                                                     │
│      ▼                                                                     │
│   5. Stream results back                                                   │
│      │                                                                     │
│      ▼                                                                     │
│   6. *sql.Rows created (connection held)                                   │
│      │                                                                     │
│      ▼                                                                     │
│   7. rows.Next() / rows.Scan() - iterate results                           │
│      │                                                                     │
│      ▼                                                                     │
│   8. rows.Close() - release connection to pool                             │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Junior to FAANG: reading the layer diagram

If this is your first serious look at a database stack, walk the diagram from the bottom up. TCP carries bytes. The driver (lib/pq, pgx, go-mysql) speaks the wire protocol and turns a Go call into frames on the socket. The `database/sql` package sits above the driver and manages the connection pool, statement cache, and transaction semantics. Your repository sits above that, translating SQL into domain types.

The critical junior insight is that `*sql.Rows` holds the connection. If you write a handler that returns `*sql.Rows` to the caller and the caller forgets to `Close`, that pool slot is gone until the process dies or `ConnMaxLifetime` expires. Always iterate and close inside the repository, never leak `*sql.Rows` across layer boundaries.

A worked example to lock in the model: write a function that selects 10 rows, iterates with `rows.Next()`, and calls `rows.Scan(&a, &b)` into typed locals. Wrap the iteration with `defer rows.Close()`. Add a `return rows.Err()` after the loop to surface iteration errors that do not come from `Scan`. This 20-line pattern is the muscle memory you need before touching anything harder.

First-job interview entry-point on architecture: expect "draw the data access path from HTTP handler to database." Draw the four-layer stack (handler, service, repository, driver), name pgx or pq, identify the pool as the shared resource, and note that prepared statements live on a connection. That answer separates candidates who read about Go from candidates who have built something.

### Senior at FAANG: the diagram is incomplete and that matters

The diagram above captures a single-process single-database view. At scale the real architecture has three extra layers the diagram does not show, and a staff engineer's job is to know what lives in each.

**Layer between driver and database: the connection pooler.** In every serious Postgres deployment at FAANG scale there is a pgBouncer or PgCat pool between the application and the database. pgBouncer runs in transaction pooling mode (a connection is leased for the duration of a single transaction, not a session), which breaks prepared statements on the lib/pq driver but works correctly on pgx/v5 thanks to protocol-level unnamed prepared statements. PgCat adds query-level load balancing and shard routing. Without this layer, your Go pool math (replicas multiplied by `MaxOpenConns`) hits `max_connections` and the cluster falls over. The ADR decision is not "do we use pgBouncer" but "transaction or session pooling, and which pool size per backend."

**Layer between database primary and replicas: the streaming replication topology.** Postgres ships WAL (write-ahead log) to physical replicas. Replicas are read-only and lag behind the primary by the round-trip time plus replay latency, typically milliseconds but unbounded under load. Your Go application sees this through two `*sql.DB` instances (primary and replica DSNs) and a routing rule in the repository. Read-your-writes semantics require the repository to route a read back to the primary for a bounded window after a write (session-sticky, usually 5 seconds). When replica lag spikes past a threshold, you drain that replica from the read pool. None of this is in the diagram above, but it is on your dashboard.

**Layer between database and object storage: the CDC and archival tap.** Logical replication via `pgoutput` feeds Debezium which feeds Kafka which feeds Iceberg which feeds analytics. Base backups go to S3 with WAL archiving for point-in-time recovery. Your RTO and RPO commitments live here. A staff engineer owns the ADR that says "WAL archived continuously with 15-minute checkpoint, base backup daily, PITR target 5 minutes, drill quarterly."

**Connection pool internals the diagram hides.** `*sql.DB` maintains an LRU of idle connections, a list of in-use connections, and a FIFO queue of goroutines waiting on `Acquire`. The relevant knobs are `MaxOpenConns` (hard ceiling including in-use), `MaxIdleConns` (ceiling on idle kept around), `ConnMaxLifetime` (forced close after age, defeats long-lived plan staleness after DDL), and `ConnMaxIdleTime` (close after inactivity, useful against cloud NAT gateways that kill idle TCP at 350 seconds). The incident pattern: `ConnMaxLifetime` unset, connections live for days, a schema migration changes a column type, cached query plans reference the old type, queries fail with `cached plan must not change result type`. The fix is `ConnMaxLifetime=30m` as a baseline.

**Prepared statement cache and the text vs binary protocol.** pgx uses the Postgres extended query protocol with binary format for values. This avoids expensive text encoding for integers, timestamps, and UUIDs. `database/sql` with pgx/stdlib uses the same protocol but adds a layer of indirection that costs a statement cache lookup per query. Native pgx with `pgx.Conn.Exec` skips this. In a hot path doing 100k QPS, the 2 to 5% CPU savings pay for the migration off `database/sql`.

**Flow step the diagram misses: connection wait.** Between step 1 and step 2 of the Query Execution Flow, when the pool is saturated, goroutines wait on `Acquire`. This wait time does not appear in query latency metrics and is often invisible until users complain. Instrument `db.Stats().WaitCount` and `db.Stats().WaitDuration` and alert when `WaitCount` grows linearly with traffic. That signal is the leading indicator of pool exhaustion, hours before p99 latency moves.

---
