# Chapter 32: Database Fundamentals in Go

*Data is the center of gravity of every production system. Get the access layer wrong and no amount of clever application code will save you.*

Every significant production application is ultimately a sophisticated wrapper around data. Whether you are building a payment processor, a social graph, a logistics platform, or an analytics pipeline, the database layer determines your system's correctness, durability, and scalability ceiling. Engineers who treat the data layer as an afterthought (throwing raw queries into handlers, ignoring connection lifecycle, skipping transactions) inevitably inherit the consequences at the worst possible moment: a production incident at 2 a.m. with data inconsistencies that cannot be reconciled automatically.

Go occupies a unique position in the database ecosystem. Its standard library ships a production-grade database abstraction in `database/sql` that is simultaneously minimal and powerful, a deliberate design that forces engineers to understand what is happening beneath the abstraction rather than hiding it. Unlike ORMs that silently generate N+1 queries or pools that misconfigure themselves, Go's `database/sql` exposes the mechanics directly: you size the pool, you manage transactions, you handle NULL values explicitly. This transparency is an advantage, not a burden. It means the performance characteristics are predictable and the failure modes are understandable.

This chapter builds the foundational skills every Go engineer needs before working with any database in production. You will learn how `database/sql` works from driver registration through connection pool management, how to execute queries safely using parameterized statements, how to handle transactions with proper rollback semantics, and how to structure your data access layer using repository patterns that keep business logic cleanly separated from persistence concerns.

**What you'll learn in this chapter:**
- How Go's `database/sql` package works, including driver registration, the `*sql.DB` connection pool, and the difference between `Query`, `QueryRow`, and `Exec`
- How to configure connection pool parameters (`MaxOpenConns`, `MaxIdleConns`, `ConnMaxLifetime`) and why each setting matters under load
- How to use parameterized queries to prevent SQL injection and improve prepared statement reuse
- How to scan query results into Go structs safely, including NULL-value handling with `sql.NullString` and related types
- How to implement transactions with proper `defer`-based rollback patterns and context-aware cancellation
- How to structure a repository pattern in Go with interfaces, enabling testability and clean separation of concerns
- How to implement batch operations and bulk inserts efficiently using multi-row value lists
- How to handle database-specific errors, detect connection failures, and implement retry logic with exponential backoff

**Why this matters at scale:**
Stripe's payment infrastructure and Uber's dispatch system both rely on Go services making hundreds of thousands of database calls per second. The difference between a well-tuned connection pool and a misconfigured one is the difference between sub-millisecond query latency and cascading connection exhaustion that takes down an entire service.

**Prerequisites:** Chapters 1 to 10 (Go fundamentals), Chapter 9 (Error Handling), Chapter 14 (Context and Cancellation).

### Junior to FAANG: entry point to the data layer

If you have only touched databases from a scripting language or an ORM like Django or ActiveRecord, the jump to `database/sql` feels bare. That is the point. Before reading the rest of the chapter, anchor a few prerequisites.

First, understand what a driver is. `database/sql` is an interface. You register a driver (`github.com/jackc/pgx/v5/stdlib` for Postgres, `github.com/go-sql-driver/mysql` for MySQL) that implements `driver.Driver`, `driver.Conn`, `driver.Stmt`. Your code never imports that package directly in business logic, it imports it in `main.go` with a blank import so the `init()` registers it. If you see `_ "github.com/..."` that is a driver import.

Second, `*sql.DB` is not a connection. It is a pool. The zero-cost mental model: each call to `db.QueryContext` checks out a pooled connection, runs the query, releases the connection back. Rows that you have not fully read or closed hold the connection hostage. Forgetting `rows.Close()` is the number one junior bug and it looks exactly like a connection pool leak in production metrics.

Third, your first job interview entry-point on databases will be a CRUD implementation and questions about SQL injection, transactions, and indexes. A worked example you should be able to write on a whiteboard is: a `UserRepository` interface with `Create`, `GetByID`, `Update`, `Delete`, using parameterized queries, handling `sql.ErrNoRows`, returning domain errors. If you can write that cleanly in 20 minutes, you are ready for the chapter.

Worked context setup for your laptop: run Postgres 18 in Docker with `docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:18`, connect with `postgres://postgres:dev@localhost:5432/postgres?sslmode=disable`, create a `users` table, and exercise every code sample in this chapter against it. Reading is not enough. Your muscle memory for `rows.Scan`, `defer rows.Close()`, and `tx.Rollback()` is built by typing.

### Senior at FAANG: data layer as a system design axis

At staff and principal levels the data layer is not "pick an ORM." It is an architectural axis that drives cost, availability, blast radius, and team topology. The framing below is what you are expected to bring to an ADR review at Stripe, Uber, Meta, or Google.

**RDBMS vs NoSQL vs NewSQL vs lakehouse selection.** The default in 2026 for a new OLTP service at most FAANG-tier shops is Postgres 17 with pgx/v5 and sqlc. The reasons are concrete: MVCC with Serializable Snapshot Isolation (SSI) gives correct-by-default concurrency for most business logic, logical replication unlocks zero-downtime migrations and CDC into Kafka, Row-Level Security enables multi-tenant isolation without app-layer filtering bugs, and the extension ecosystem (pgvector, TimescaleDB, Citus) covers adjacent workloads without a new datastore. You reach for DynamoDB or Spanner when you need region-active-active with bounded write latency at arbitrary scale. You reach for Cassandra or ScyllaDB when write amplification dominates and eventual consistency is acceptable. You reach for a lakehouse (Iceberg on S3 with Trino or DuckDB) when analytics is the primary workload and you want schema evolution without rewriting petabytes. NewSQL (CockroachDB, YugabyteDB, Spanner, TiDB) earns its place when you need SQL semantics plus geo-distribution and can pay the latency tax on cross-region writes.

**Connection pool as capacity planner.** `MaxOpenConns` is not a Go setting, it is a capacity contract with the database. Postgres default `max_connections` is 100, and each backend costs roughly 10 MB of RSS plus shared buffer overhead. If you run 20 replicas of a service with `MaxOpenConns=50`, you have overcommitted 1000 connections against a server that supports 100. The incident pattern is classic: a slow query under load causes connection dwell to rise, the pool fills, new requests block on `Acquire`, p99 latency goes vertical, health checks fail, the service is marked unhealthy, traffic shifts to surviving replicas, and the cascade consumes the cluster. The fix is pgBouncer in transaction pooling mode in front of Postgres, with `MaxOpenConns` per replica sized so `replicas * MaxOpenConns <= pgBouncer_pool_size` and `pgBouncer_pool_size <= max_connections - admin_reserve`. Write this down in the ADR. Enforce it in Terraform.

**pgx vs database/sql.** At FAANG-scale Postgres shops, pgx/v5 used natively (not through `database/sql`) is the preferred choice. You get the binary protocol, batch execution via `pgx.Batch`, `CopyFrom` for bulk ingest at 10 to 100x the throughput of `INSERT`, typed array and JSONB support without manual marshaling, and listen/notify for pub-sub. You lose the `database/sql` interface abstraction, which matters only if you genuinely need to swap Postgres for MySQL. You do not. If you need the `database/sql` surface for legacy reasons (shared middleware, `sqlmock` tests), use `pgx/v5/stdlib` as the driver and keep the door open to pgx native later.

**ORM and query-builder trade-offs.** sqlc generates type-safe Go code from SQL. This is the default choice at scale because the query is reviewable, the plan is predictable, and the generated code is transparent. GORM is rejected in most senior-level ADRs because it hides N+1 queries behind chained method calls, its AutoMigrate is actively dangerous in production, and its reflection-based scan is slow. ent is defensible for heavily graph-shaped domains but its cost model is opaque. The working rule: write SQL, generate Go, review plans.

**Transaction isolation as an ADR.** For a typical SaaS multi-tenant workload, READ COMMITTED (Postgres default) is correct for the 95% case where you read, decide, and write within a single statement or where optimistic locking via a `version` column covers the race. Upgrade to REPEATABLE READ (snapshot isolation in Postgres) when you need a consistent view across multiple statements, for example an invoice total computed from line items where a concurrent insert must not be seen mid-aggregation. Escalate to SERIALIZABLE (SSI in Postgres) when business correctness requires that concurrent transactions produce a serial schedule, for example inventory decrement with constraint "no overselling." SSI costs throughput because it tracks read-write dependencies and aborts transactions with `40001` serialization_failure. You must implement a bounded retry loop (3 to 5 attempts with jittered backoff) around any SERIALIZABLE transaction. Document the level and the retry policy in the ADR, not in a code comment.

**Incident patterns every staff engineer must recognize.** Connection exhaustion (discussed above). Replica lag cascade: a read-your-writes workload routed to an async replica sees stale data, the app writes a compensating record, the lag grows, the cascade spirals. The fix is explicit primary routing for read-after-write and lag-aware load balancing. Idle-in-transaction leaks: a `BEGIN` without a matching `COMMIT`/`ROLLBACK` holds locks and prevents vacuum, bloat accumulates, query plans degrade. The fix is `idle_in_transaction_session_timeout = '30s'` and `statement_timeout = '5s'` as GUCs, backed by `context.WithTimeout` at every call site. Transaction ID wraparound: Postgres XID is 32-bit, at roughly 2 billion transactions without vacuum the database refuses writes to protect data. Monitor `age(datfrozenxid)` and alert at 1 billion. This has taken down Sentry, Joyent, and Mailchimp in well-documented public postmortems, and it recurs in internal systems at scale. It is not hypothetical.

The rest of this chapter gives you the Go-level mechanics. The senior responsibility is owning the architectural consequences.

---
