## Learning Objectives

After completing this chapter, you will be able to:

1. **Master the database/sql package** - Understand Go's database abstraction layer, connection pooling, and driver architecture
2. **Implement production-ready data access** - Build repository patterns with proper error handling and transactions
3. **Optimize database operations** - Configure connection pools, use prepared statements, and implement batch operations
4. **Handle edge cases** - Deal with NULL values, timeouts, connection failures, and database-specific errors
5. **Apply enterprise patterns** - Implement patterns used by Stripe, Uber, and Netflix for high-scale database access
6. **Debug database issues** - Profile queries, monitor connection health, and troubleshoot performance problems

### Junior to FAANG: what these objectives really require

Read the objectives above as skills you practice, not facts you memorize. "Master the database/sql package" at junior level means you can explain what `*sql.DB` is (a pool, not a connection), what `Query` returns (a `*sql.Rows` that you must `Close`), and what `Exec` returns (a `sql.Result` with `RowsAffected` and `LastInsertId`, the latter not supported by Postgres). If an interviewer asks "why is `db.Ping` needed," you should answer that opening a `*sql.DB` is lazy, no TCP connection happens until the first query or explicit `Ping`.

"Implement production-ready data access" at entry level means: you can write a `UserRepository` interface, implement it against Postgres, wrap a create-and-log-audit operation in a transaction, and add a unit test using a real test database or `sqlmock`. "Handle edge cases" means you know that `QueryRow` never returns `nil`, errors surface on `Scan`, and `sql.ErrNoRows` is the sentinel for no match.

First-job interview entry-point: expect a live-coding CRUD exercise and a follow-up on connection pool sizing. A junior answer is "set MaxOpenConns to 25." A junior-to-senior-track answer is "size it against the database server's max_connections divided by the number of replicas, leaving headroom for admin connections, and confirm with p99 wait time on connection acquisition."

### Senior at FAANG: objectives reframed as leadership responsibilities

At staff level, each objective has a second order you are accountable for. The junior owns the code. The senior owns the consequences.

**Master the database layer, reframed.** You own the ADR that says "pgx/v5 native, not database/sql, for all new Postgres services." You own the sqlc versus GORM versus ent decision and can defend it against a team that prefers the familiar ORM. You understand the prepared statement cache (pgx caches plans per connection, so `MaxConnLifetime` interacts with plan invalidation after `ALTER TABLE`), and you understand when the binary protocol is worth the cost (every time for Postgres, the text protocol's `INTEGER` parsing alone costs 30% of CPU in hot paths).

**Production-ready data access, reframed.** You own the repository contract boundary. Repositories return domain errors, not `*pq.Error` or `*pgconn.PgError`. You map `23505` unique_violation to `ErrAlreadyExists`, `40001` serialization_failure to a retryable sentinel, `57014` query_canceled to a context-deadline error. You own the retry loop policy (exponential backoff with jitter, bounded attempts, circuit breaker on sustained failure), and you own the observability contract (every query emits a span with SQL fingerprint, rows affected, duration, and connection wait time).

**Optimize operations, reframed.** You own the pool-sizing math across replicas. If the service has 20 pods with `MaxOpenConns=25`, you have contracted 500 Postgres backends, which exceeds the default `max_connections=100`. You put pgBouncer (transaction pooling) between the app and Postgres, set pgBouncer `default_pool_size=90`, `reserve_pool_size=10`, and set the Go pool high enough to saturate pgBouncer without blocking. You know that in transaction pooling mode, session-scoped features (prepared statements, `SET LOCAL`, advisory locks, `LISTEN/NOTIFY`) break, and pgx/v5 has a protocol-level workaround (`DescribePortal` with unnamed statements) that makes this work.

**Handle edge cases, reframed.** You own the transaction isolation ADR. You know that Postgres REPEATABLE READ is actually snapshot isolation and admits write skew, which is why SSI exists for the SERIALIZABLE tier. You know MySQL InnoDB REPEATABLE READ uses gap locks and behaves differently from Postgres. You know that a long-running analytical transaction on a primary blocks `VACUUM` and accelerates bloat, and you know to route those queries to a dedicated replica or a materialized view refreshed by logical replication.

**Enterprise patterns, reframed.** You own the distributed transaction story. Your default answer is "no distributed transactions, use the outbox pattern." You can explain why: 2PC has no progress guarantee under coordinator failure and no mainstream Postgres or MySQL deployment runs XA in production. You know Sagas with compensating actions are the industry standard for cross-service workflows, and you know the outbox pattern (write business data and event row in the same local transaction, CDC streams the event to Kafka) eliminates the dual-write problem without distributed commit.

**Debug issues, reframed.** You own the incident runbook. Connection exhaustion: check `pg_stat_activity` for `idle in transaction`, check pgBouncer `SHOW POOLS`, check Go pool metrics (`db.Stats().WaitCount`, `WaitDuration`, `MaxIdleClosed`). Replica lag cascade: check `pg_stat_replication.replay_lag`, shed read traffic from the lagged replica, force read-after-write to primary. Transaction ID wraparound alert: run emergency `VACUUM FREEZE` on the oldest tables, consider stopping writes if `age(datfrozenxid)` exceeds 1.8 billion. These are the incidents you get paged for, and the runbook is your responsibility, not the SRE team's.

---
