## Summary

Go's `database/sql` package provides the primitives to build a reliable data access layer.

1. **Connection Pool**. `sql.DB` is a pool, not a single connection. Set `MaxOpenConns`, `MaxIdleConns`, `ConnMaxLifetime`, and `ConnMaxIdleTime` based on your workload and database server limits. Monitor `db.Stats()` in production.
2. **Context**. Always use the `*Context` variants (`QueryContext`, `ExecContext`, `BeginTx`) so that request deadlines and cancellation signals propagate to the database driver.
3. **Transactions**. Defer `tx.Rollback()` immediately after `Begin`. Use a transaction helper to eliminate repeated begin/commit/rollback boilerplate and to handle panics safely.
4. **Prepared Statements**. Prepare once, execute many times. Useful in hot loops and batch operations. For most single-use queries, inline parameterized queries are sufficient.
5. **NULL Handling**. Match Go types to column nullability. Use `sql.NullString` and related types for nullable columns, or use pointer fields if you need cleaner JSON serialization.
6. **Error Handling**. Map driver-specific error codes to domain errors (`ErrNotFound`, `ErrDuplicateKey`). Implement retry logic with exponential backoff for transient failures like connection resets and deadlocks.
7. **Health Checks**. Ping alone confirms the TCP connection. Run `SELECT 1` to confirm the server can execute queries. Track `WaitCount` and `WaitDuration` to detect pool saturation before it causes user-facing latency.

### Junior to FAANG: What to Actually Remember From This Chapter

If you internalize only seven things from this chapter, make them these. First, sql.DB is a pool. Every time you see sql.DB in a codebase, mentally translate it to "a collection of connections that are checked out and returned per query." This framing makes connection leaks obvious. Second, every database call in a request path takes a context with a deadline. QueryContext not Query. ExecContext not Exec. BeginTx with ctx, not Begin. If a code review PR contains a non-Context variant in request-handling code, reject it. Third, defer rows.Close comes on the line immediately after the err check, not later, not before. Fourth, defer tx.Rollback comes on the line immediately after BeginTx, even if you plan to commit. The rollback becomes a no-op after a successful commit. Fifth, never build SQL with fmt.Sprintf and user input. The stdlib gives you $1 and ?, use them. Sixth, match Go types to column nullability. A nullable column maps to sql.NullString or *string, never to string. Seventh, when something is slow, look at p99 and the pool stats before you look at the code.

These seven rules cover roughly 85% of the database bugs you will encounter in your first two years. The remaining 15% are query-plan issues (chapter 33), replication lag, and distributed consistency, which require different mental models.

Interview entry-point for every chapter-32 topic: the interviewer is checking whether you treat the database as a remote stateful service with failure modes, or as a magic persistence box. The former is a junior-to-senior signal. The specific language to use: "the pool checks out a connection," "the query acquires a lock for duration X," "the transaction holds rows invisible to other transactions until commit." If you cannot narrate the lifecycle of a Query in those terms, reread sections 32.1 through 32.5 before your next loop.

Why-did-this-fail reflex summary. Pool exhaustion means connections are held too long, find the holder via pg_stat_activity. Rows leak means defer rows.Close is missing somewhere, grep for it. Transaction hang means a context is not propagating, check for Query vs QueryContext. NULL panic means Go type does not match schema, check INFORMATION_SCHEMA.COLUMNS for is_nullable. N+1 means a loop contains a query, refactor to JOIN or batch. Memorize these five pairs and you have a diagnostic tree for 90% of production database incidents.

First-job preparation checklist. Be able to draw on a whiteboard: (1) the lifecycle of a request through a pooled sql.DB, (2) a transaction timeline with BEGIN, UPDATE, COMMIT annotated with lock acquisition, (3) the pool saturation failure pattern with p50 and p99 curves. Practice these on paper. In an interview, having them in muscle memory lets you focus on the novel parts of the question rather than the mechanics.

### Senior at FAANG: Chapter-32 Summary as a Staff-Level Platform Charter

For staff and principal engineers the summary above is a minimum bar, not a finish line. The real summary for a database platform owner is a charter that turns these seven rules into organizational mechanisms. The following is what the chapter-32 content looks like at L6 and L7.

Platform charter outline.

1. Connection pooling is a platform concern, not a service concern. Every service consumes a typed pool from a platform library that enforces MaxOpenConns based on the service's declared QPS budget. pgbouncer or RDS Proxy fronts the database. The ADR governing pool sizes is reviewed quarterly.

2. Context propagation is enforced by a linter and by the platform library's refusal to expose non-Context methods. The platform library wraps sql.DB to return only db.QueryContext-style methods. Service authors cannot accidentally call Query.

3. Transactions are exposed via a WithTx helper that handles defer rollback, panic recovery, context timeout, and isolation-level selection. Product teams cannot call BeginTx directly. The WithTx helper emits tracing spans and retries on serialization_failure when the caller opts in with a policy object.

4. Prepared statements are used selectively. The platform library tracks per-query cache hit rates and prompts service owners to materialize prepared statements for queries above a QPS threshold. Most services do not touch this.

5. NULL handling is solved structurally by sqlc. The platform mandates sqlc for all new code and funds a two-quarter migration for legacy code. Hand-written Scan into non-Null types is banned.

6. Error handling is layered. Driver errors are mapped to domain errors in a centralized error module. Retry policies are declarative (annotation on the query or a policy object). Transient errors (connection, deadlock, serialization) are retried with exponential backoff and jitter, capped at a budget tracked per-endpoint. The budget prevents retry storms.

7. Health checks are part of a broader SLO framework. Per-database SLOs track availability, p99 query latency, and replication lag. Ping is insufficient, the platform runs SELECT 1 every 5s and a canary workload query every 60s. Alerts fire on SLO burn rate, not on raw metric thresholds.

Maturity model transitions.

Moving from Level 2 (streaming replica, manual failover) to Level 3 (automated failover with fencing): requires Orchestrator or Patroni or a similar consensus-driven failover controller, requires a fencing mechanism (STONITH, security-group revocation, virtual IP), requires a monthly failover drill. Budget: 2 engineer-quarters.

Moving from Level 3 to Level 4 (sharded with online resharding): requires a sharding abstraction (Vitess, Citus, custom), requires a dual-write and CDC backfill framework, requires a shadow-traffic validation harness, requires a chaos testing regime that includes random primary loss weekly. Budget: 6 to 12 engineer-quarters.

Moving from Level 4 to Level 5 (database as a product with tenant SLOs): requires cost-allocation telemetry per tenant, requires admission control (the platform can reject traffic that exceeds a tenant's budget), requires a customer-facing dashboard, requires a roadmap with tenant OKRs. Budget: a permanent team of 6 to 10 engineers.

Cross-chapter integration. Chapter 32 is about the Go client side. Chapter 33 goes deep on PostgreSQL, including query plans and indexing. Chapter 36 covers migrations and schema evolution. Chapter 37 covers pooling and sharding at fleet scale. A staff engineer's view of this chapter is that it is the application-facing contract for the database, and the contract must be consistent across all services in the fleet. Divergence (some services use gorm, some use sqlc, some use raw database/sql) is technical debt that costs oncall time and onboarding time. The ADR to consolidate on one abstraction is usually the right call, even if the abstraction is imperfect.

Staff engineer story template. When you interview at L6 you will be asked for a database story. The best template is: (1) situation and numbers (200 services, 40 Postgres instances, 15 incidents per quarter), (2) what you changed (centralized migration framework, mandatory ADR, sqlc adoption), (3) how you coordinated (6 months, 4 teams, 2 skeptical tech leads), (4) measurable outcome (incidents dropped to 3 per quarter, onboarding time dropped from 2 weeks to 3 days), (5) what you would do differently (started the linter earlier, spent more time on the rollback runbook).

If you cannot tell a story like that, you are not ready for L6 ownership of a database platform. Spend your next year pattern-matching real incidents to the templates in this chapter and building one such story from your own work.

---
