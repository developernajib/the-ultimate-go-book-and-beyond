## 32.13 Interview Questions

### Question 1: Explain database/sql's connection pool behavior

**What FAANG expects**: That you treat `sql.DB` as a pool, not a connection. That you can quantify *why* the defaults are dangerous in production. That you can reason about pool sizing relative to the database's `max_connections` and the number of application replicas. Candidates who say "I just call `sql.Open` and it works" fail this question.

**Answer**: Go's database/sql maintains a pool of database connections:

- `sql.Open()` doesn't establish connections. It creates a pool and validates the DSN
- Connections are created lazily on first query (use `PingContext` at startup to fail fast)
- `SetMaxOpenConns()` limits total connections (default: unlimited, almost always wrong)
- `SetMaxIdleConns()` limits kept-alive connections (default: 2, causes TCP churn under load)
- `SetConnMaxLifetime()` closes connections after duration (default: 0 = forever, dies behind NAT/firewalls)
- `SetConnMaxIdleTime()` closes idle connections after duration

The pool automatically handles connection lifecycle, returning connections after query completion and reusing them for subsequent queries. Sizing rule: `MaxOpenConns <= db_max_connections / num_replicas` with headroom for admin connections and migrations.

**Follow-ups:**
- *"Your service is deployed across 50 pods against a Postgres with `max_connections=200`. What do you set `MaxOpenConns` to, and why not just use the database's full capacity?"* (Answer: ~3 per pod with headroom for admin/migrations/failover replicas. Full capacity invites cascading outages during deploys.)
- *"A connection works at startup, then queries start failing with `driver: bad connection` after 10 minutes of idle. What's happening?"* (Answer: an intermediate NAT/LB is silently killing the TCP connection. Fix with `SetConnMaxLifetime` shorter than the idle timeout.)
- *"How would you expose pool saturation as a metric?"* (Answer: `db.Stats()` returns `InUse`, `Idle`, `WaitCount`, and `WaitDuration`. Export them to Prometheus and alert on `WaitCount` rising.)

### Question 2: How would you handle database failover in a distributed system?

**What FAANG expects**: That you distinguish retryable from non-retryable errors, that you talk about idempotency before retries, and that you do not retry inside a transaction without thought. Bonus points for mentioning that retries amplify load during an incident and need a circuit breaker.

**Answer**: Key strategies include:

1. **Connection retry with exponential backoff and jitter** - only for idempotent operations
2. **Read replica routing** - Direct read queries to replicas, writes to primary
3. **Circuit breaker pattern** - Fail fast when database is down to avoid thread-pool starvation
4. **Connection health checks** - Periodic `PingContext()` calls, plus `SetConnMaxLifetime`
5. **Multiple database endpoints** - Use a proxy (PgBouncer, RDS Proxy) or DNS failover
6. **Graceful degradation** - Cache fallback for reads, queue writes to a durable buffer

```go
func (db *DB) QueryWithRetry(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    var lastErr error
    for attempt := 0; attempt < 3; attempt++ {
        rows, err := db.QueryContext(ctx, query, args...)
        if err == nil {
            return rows, nil
        }
        lastErr = err
        if !isRetryable(err) {
            break
        }
        // Exponential backoff with jitter
        backoff := time.Duration(1<<attempt) * 100 * time.Millisecond
        jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
        select {
        case <-time.After(backoff + jitter):
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }
    return nil, lastErr
}
```

**Follow-ups:**
- *"What makes an error retryable?"* (Answer: transient: `driver.ErrBadConn`, `context.DeadlineExceeded` from connection phase, Postgres `serialization_failure` (SQLSTATE 40001), `deadlock_detected` (40P01). Non-retryable: constraint violations, syntax errors, auth failures.)
- *"You retry an `INSERT` that actually succeeded but the ACK got lost. How do you prevent duplicates?"* (Answer: idempotency keys, `INSERT ... ON CONFLICT DO NOTHING RETURNING`, or `SELECT` before retry under a unique constraint.)
- *"When would you NOT retry?"* (Answer: inside a transaction that already applied partial state, for write-heavy operations without idempotency keys, and when a circuit breaker is open.)

### Question 3: What's the difference between QueryRow and Query?

**What FAANG expects**: A clean explanation of lifecycle and resource management, plus awareness that forgotten `rows.Close()` is one of the most common causes of pool exhaustion in Go codebases.

**Answer**:

- `QueryRow()` returns `*sql.Row` for single-row results. Errors are deferred to `Scan()`
- `Query()` returns `*sql.Rows` for multiple rows. Requires explicit `Close()` (the connection is held until closed or iteration finishes)
- `QueryRow()` is more convenient for known single-row queries. It auto-closes after `Scan`
- `Query()` without `defer rows.Close()` leaks a connection per invocation, which silently exhausts the pool over hours

```go
// QueryRow - automatic resource management
var name string
err := db.QueryRowContext(ctx, "SELECT name FROM users WHERE id = $1", 1).Scan(&name)

// Query - manual resource management
rows, err := db.QueryContext(ctx, "SELECT name FROM users")
if err != nil {
    return err
}
defer rows.Close() // MUST close to release connection
for rows.Next() {
    if err := rows.Scan(&name); err != nil {
        return err
    }
}
if err := rows.Err(); err != nil { // Check for iteration errors
    return err
}
```

**Follow-ups:**
- *"Why check `rows.Err()` after the loop?"* (Answer: `rows.Next()` returning false can mean EOF or a streaming error (network interruption mid-stream), and `rows.Err()` distinguishes them.)
- *"You break out of a `for rows.Next()` loop early. Is `defer rows.Close()` still enough?"* (Answer: yes - `Close()` is idempotent and drains any remaining rows to release the connection.)
- *"Your Grafana dashboard shows the pool's `InUse` count climbing forever until restart. Where do you look first?"* (Answer: `grep -n "\.Query(" --include="*.go" -R` and audit every call site for `defer rows.Close()`. This is almost always the cause.)

### Question 4: How do you prevent SQL injection in Go?

**What FAANG expects**: That you default to parameterized queries, that you know the one edge case (identifiers/table names can't be parameterized), and that you can handle dynamic queries safely via whitelists or a query builder.

**Answer**: Always use parameterized queries:

```go
// Safe: parameters are escaped by driver
db.QueryContext(ctx, "SELECT * FROM users WHERE id = $1", userID)

// For dynamic identifiers (table, column, ORDER BY direction), use whitelists
validColumns := map[string]bool{"name": true, "email": true, "created_at": true}
if !validColumns[column] {
    return errors.New("invalid column")
}
query := fmt.Sprintf("SELECT %s FROM users ORDER BY id", column)
```

Parameterized queries defend against injection because the driver sends the query and arguments over the wire as separate protocol messages - the argument never enters the SQL parser. `fmt.Sprintf` into SQL is always a red flag outside the narrow identifier-whitelist case.

**Follow-ups:**
- *"Can you parameterize `LIMIT $1 OFFSET $2`?"* (Answer: yes, both are values. But `ORDER BY $1` does not work - it is parsed as a literal, not a column reference.)
- *"What about `IN (?, ?, ?)` with a variable-length slice?"* (Answer: build the placeholder list dynamically based on slice length and pass the slice as variadic `args...`, or use Postgres `= ANY($1)` with an array argument, which pgx handles natively.)
- *"How does `sqlc` help here?"* (Answer: queries are parsed at code-gen time against the real schema, placeholders are statically typed, and user-supplied identifiers are impossible because there are no string interpolations in generated code.)

### Question 5: Explain transaction isolation levels and when to use each

**What FAANG expects**: That you know the anomalies, that you know Postgres/MySQL defaults differ, and that you understand `SERIALIZABLE` is not free - it can fail with `serialization_failure` and must be retried.

**Answer**:

| Level | Dirty Read | Non-Repeatable Read | Phantom Read |
|-------|------------|---------------------|--------------|
| Read Uncommitted | Yes | Yes | Yes |
| Read Committed | No | Yes | Yes |
| Repeatable Read | No | No | Yes (Postgres MVCC: no) |
| Serializable | No | No | No |

- **Read Committed** (Postgres default): Good for most application workloads
- **Repeatable Read** (MySQL InnoDB default): When you read data multiple times in a transaction
- **Serializable**: Financial transactions, inventory, anywhere a read-modify-write must be linearizable. Expect occasional `SQLSTATE 40001` and retry the whole transaction.

```go
tx, err := db.BeginTx(ctx, &sql.TxOptions{
    Isolation: sql.LevelSerializable,
})
```

**Follow-ups:**
- *"Under `Serializable`, the transfer from Question 6 in Chapter 32's transaction section fails with SQLSTATE 40001. What do you do?"* (Answer: retry the entire transaction, not just the failing statement. The DB aborted it because a conflicting serialization order was detected.)
- *"Why does Postgres's `Repeatable Read` actually prevent phantom reads, even though the SQL standard allows them?"* (Answer: Postgres uses snapshot isolation via MVCC, which is strictly stronger than the standard's `Repeatable Read` definition.)
- *"You need a row-level lock without escalating to full `Serializable`. What do you use?"* (Answer: `SELECT ... FOR UPDATE` inside a `Read Committed` transaction. locks the row until commit, other transactions block on it. `FOR UPDATE SKIP LOCKED` is the standard queue pattern.)

### Junior to FAANG: Interview Signal Ladders by Level

Every database interview question is scored on a ladder. Understanding the ladder tells you what to say first, what to volunteer, and when to stop. Below is the expected-answer ladder for the five questions above at L3 (new grad), L4 (mid), L5 (senior), L6 (staff), and L7 (principal).

Q1 (connection pool). L3: name the four tuning methods. L4: explain what "driver: bad connection" means and how SetConnMaxLifetime fixes it. L5: give the sizing formula MaxOpenConns <= (db_max_connections - admin_reserve) / num_replicas and defend the choice. L6: present the trade-off between pgbouncer in transaction mode (smaller pool, session-state risks) vs session mode (larger pool, fewer risks) and pick one with criteria. L7: propose a multi-region pool strategy with a latency budget per region and a degradation mode when the primary is lost.

Q2 (failover). L3: mention retry with backoff. L4: distinguish retryable from non-retryable errors. L5: explain idempotency keys and why they must precede retries. L6: propose a circuit breaker with per-endpoint budgets and discuss how retries amplify load (the AWS DynamoDB 2015 metadata retry storm and the Roblox 2021 Consul storm). L7: design a region-failover procedure with fencing tokens, data-loss budget (RPO), and a runbook that a 2-AM oncall can execute in 15 minutes.

Q3 (QueryRow vs Query). L3: describe the two methods. L4: mention defer rows.Close and rows.Err. L5: explain the pool-exhaustion failure mode with a real symptom ("InUse climbs, p99 spikes, queries block at sql.(*DB).conn"). L6: propose a linter policy and a platform wrapper that makes the mistake impossible. L7: design a query-lifecycle abstraction that emits tracing, metrics, and row-level audit events with no product-team effort.

Q4 (SQL injection). L3: parameterized queries. L4: identifier whitelist for dynamic ORDER BY. L5: discuss code-gen via sqlc as a structural prevention. L6: propose an org-wide migration from hand-written queries to sqlc or a typed query builder, with a plan for legacy code. L7: discuss static analysis for taint propagation in Go and how companies use taint-tracking tools (CodeQL, Semgrep, or homegrown analyzers like Meta's Zoncolan and Pysa) for database security at scale.

Q5 (isolation). L3: list the four levels. L4: explain Postgres's snapshot isolation. L5: explain why SERIALIZABLE can fail and how to retry. L6: explain SSI (serializable snapshot isolation) vs 2PL and pick a level for a specific workload (inventory, financial, social graph). L7: discuss distributed consensus isolation (Spanner's external consistency, CockroachDB's serializable) and when the overhead is justified.

Worked interview example. Interviewer asks Q2 at an L5 loop: "How do you handle database failover?" Your arc should be (1) what counts as retryable, (2) idempotency keys before retries, (3) circuit breaker to prevent retry storms, (4) replica routing, (5) graceful degradation. Spend 60 seconds per layer. If they ask a follow-up about any layer, go deep. If they do not, do not improvise more, stop and let them drive. Over-talking is an L4 signal at an L5 loop.

Why-did-this-fail interview reflex. When an interviewer presents a symptom (slow queries, pool exhaustion, split-brain), your first move should always be to ask for three specifics: what is the p99 latency, what does the connection-pool metric look like, and what changed in the last 24 hours. Jumping to a solution without data is the single most common signal that drops a candidate from senior to mid.

### Senior at FAANG: Bar-Raiser Questions for Staff and Principal

At L6 and L7 the five questions above are warm-ups. The real bar-raiser questions probe architectural judgment, multi-year planning, and organizational leadership. The following are questions you should be able to answer in a 45-minute loop with supporting diagrams.

Bar-raiser 1: "Design a database migration from a single 4 TB Postgres to a sharded deployment with zero downtime and a rollback plan." Expected arc: (a) dual-write with a consistency checker, (b) online backfill via logical replication (pg_logical_replication_slots) or CDC (Debezium), (c) shadow-read validation for 2 weeks, (d) cutover with a feature flag, (e) rollback plan that keeps the old primary read-write for 30 days. Name-drop: Notion's 2021 block-sharding and 2023 re-shard, and Figma's 2023 horizontal partitioning of Postgres. If you cannot draw the dual-write timeline on a whiteboard with failure modes annotated, you are not ready for L6.

Bar-raiser 2: "Your company runs 200 Postgres instances across 40 teams. VACUUM is inconsistent, schema changes cause outages monthly, and oncall is unsustainable. What do you do in your first 90 days as the new database platform lead?" Expected arc: (1) metrics-first (deploy pg_stat_statements, pg_stat_activity scraping, autovacuum telemetry to every instance), (2) centralize the migration framework (pgroll or gh-ost wrapper, enforce schema-change ADR), (3) SLOs per tenant (not per instance), (4) oncall restructure (platform owns infra paging, product owns query paging), (5) six-month roadmap with a 30/60/90 deliverable. This is the Datadog playbook circa 2020 to 2022.

Bar-raiser 3: "When do you pick CockroachDB, Spanner, YugabyteDB, TiDB, Vitess, or sharded Postgres?" Expected matrix: workload write-heavy vs read-heavy, need for global strong consistency, cloud-vendor lock-in tolerance, SQL dialect compatibility, team expertise. CockroachDB: Postgres-compat, multi-region, high write-amplification. Spanner: Google-only, external consistency, cost. YugabyteDB: Postgres-compat OSS, smaller community. TiDB: MySQL-compat, built by PingCAP and widely deployed in APAC (ByteDance and others). Vitess: MySQL sharding, battle-tested at YouTube/Slack/GitHub. Sharded Postgres (Citus or home-grown): when you need Postgres features and can invest in ops. Answer must include a "what would push me to the other choice" for at least three pairs.

Bar-raiser 4: "Walk me through the runbook for promoting a Postgres replica to primary during a region failure." Expected: (1) verify the primary is truly gone (not a partition), (2) confirm the replica's lag is below the RPO budget, (3) fence the old primary (STONITH or revoke network), (4) pg_ctl promote on the replica, (5) update service discovery (Consul, DNS, or a proxy), (6) redirect application traffic via a feature flag or connection-string flip, (7) re-bootstrap the old primary as a replica via pg_basebackup or pg_rewind, (8) post-incident reconcile any writes that landed in the split-brain window. You should know which step the GitHub 2018 split-brain failover got wrong: automated promotion across a network partition with no fencing token.

Bar-raiser 5: "Describe a database decision you owned that took more than 6 months to ship." This is the staff-engineer signature question. You need one story with a decision doc, a cross-team coordination plan, a measurable outcome, and a retrospective. Weak answers describe what you built. Strong answers describe what you did not build and why, what you changed about the team's process, and what the second-order effects were two years later.

ADR templates library for principal candidates:
- Schema-change framework adoption (pgroll vs gh-ost vs plain).
- Sharding strategy (time vs hash vs list vs range-with-attach-partition).
- Multi-region topology (active-active, active-passive, read-local write-global).
- Backup and PITR retention (cost vs RPO vs compliance).
- ORM adoption for a 100+ engineer team (sqlc vs ent vs gorm vs raw database/sql).
- Cross-database migration (Postgres to CockroachDB, MySQL to Vitess, Cassandra to ScyllaDB).
- Connection pooling (application pool vs pgbouncer vs RDS Proxy vs Odyssey).

At L7 the interviewer will not ask you to write code. They will ask you to write an ADR live, defend it against a pushback, and name the person on your team who would disagree and how you would resolve it. If you cannot name a realistic disagreement you have not thought hard enough about the decision.

---
