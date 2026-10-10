## 32.12 Common Mistakes and How to Avoid Them

### Mistake 1: Not Closing Rows

`*sql.Rows` holds an open database connection until `Close()` is called. If you forget `defer rows.Close()`, the connection is never returned to the pool. Under load, the pool fills up and every subsequent query blocks waiting for a free connection.

```go
// WRONG: Connection leak
func getUsers(db *sql.DB) ([]User, error) {
    rows, err := db.Query("SELECT id, name FROM users")
    if err != nil {
        return nil, err
    }
    // Missing: defer rows.Close()

    var users []User
    for rows.Next() {
        var u User
        rows.Scan(&u.ID, &u.Name) // Also missing error check
        users = append(users, u)
    }
    return users, nil
}

// CORRECT: Always close rows and check errors
func getUsers(db *sql.DB) ([]User, error) {
    rows, err := db.Query("SELECT id, name FROM users")
    if err != nil {
        return nil, err
    }
    defer rows.Close() // Always defer close

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name); err != nil {
            return nil, fmt.Errorf("scanning user: %w", err)
        }
        users = append(users, u)
    }

    if err := rows.Err(); err != nil { // Check iteration errors
        return nil, fmt.Errorf("iterating rows: %w", err)
    }

    return users, nil
}
```

### Mistake 2: Using Query for Non-SELECT Statements

`Query` returns `*sql.Rows` that must be closed. If you use `Query` for a `DELETE` or `UPDATE`, the returned rows object holds a connection until garbage collection, which may never happen promptly enough. Use `Exec` for any statement that does not return rows.

```go
// WRONG: Query returns rows that must be closed
func deleteUser(db *sql.DB, id int64) error {
    rows, err := db.Query("DELETE FROM users WHERE id = $1", id)
    if err != nil {
        return err
    }
    // rows will be returned but never used, causing connection leak
    return nil
}

// CORRECT: Use Exec for non-SELECT statements
func deleteUser(db *sql.DB, id int64) error {
    result, err := db.Exec("DELETE FROM users WHERE id = $1", id)
    if err != nil {
        return err
    }

    affected, err := result.RowsAffected()
    if err != nil {
        return err
    }

    if affected == 0 {
        return ErrNotFound
    }

    return nil
}
```

### Mistake 3: Transaction Mismanagement

If you return an error before calling `tx.Commit()` or `tx.Rollback()`, the transaction stays open and its connection is never released. Always `defer tx.Rollback()` immediately after `Begin`. The deferred rollback is a no-op after a successful commit, so there is no downside to including it.

```go
// WRONG: Missing rollback on error paths
func createOrder(db *sql.DB, order Order) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }

    _, err = tx.Exec("INSERT INTO orders ...")
    if err != nil {
        return err // Transaction left open!
    }

    _, err = tx.Exec("INSERT INTO order_items ...")
    if err != nil {
        return err // Transaction left open!
    }

    return tx.Commit()
}

// CORRECT: Always defer rollback
func createOrder(db *sql.DB, order Order) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback() // No-op if already committed

    _, err = tx.Exec("INSERT INTO orders ...")
    if err != nil {
        return err
    }

    _, err = tx.Exec("INSERT INTO order_items ...")
    if err != nil {
        return err
    }

    return tx.Commit() // Rollback won't execute after successful commit
}
```

### Mistake 4: Ignoring Context Cancellation

The non-context methods (`db.Query`, `db.Exec`) block indefinitely. If a query runs for minutes due to a missing index or a lock wait, the goroutine and its connection are stuck for the entire duration. Always use `QueryContext` or `ExecContext` with a timeout so slow queries get canceled before they cascade into pool exhaustion.

```go
// WRONG: Not using context
func getLongReport(db *sql.DB) ([]Report, error) {
    rows, err := db.Query(`
        SELECT * FROM reports
        WHERE created_at > NOW() - INTERVAL '1 year'
    `) // Could run forever
    // ...
}

// CORRECT: Use context with timeout
func getLongReport(ctx context.Context, db *sql.DB) ([]Report, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    rows, err := db.QueryContext(ctx, `
        SELECT * FROM reports
        WHERE created_at > NOW() - INTERVAL '1 year'
    `)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            return nil, fmt.Errorf("query timeout exceeded")
        }
        return nil, err
    }
    defer rows.Close()
    // ...
}
```

### Mistake 5: SQL Injection Vulnerabilities

String concatenation with `fmt.Sprintf` puts user input directly into the SQL string, allowing an attacker to inject arbitrary SQL. Parameterized queries (`$1`, `?`) send the values separately from the query text, so the driver escapes them automatically. For dynamic column or table names that cannot be parameterized, validate against a whitelist of allowed identifiers.

```go
// WRONG: String concatenation allows SQL injection
func getUserByName(db *sql.DB, name string) (*User, error) {
    query := fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name)
    // If name = "'; DROP TABLE users; --", disaster!
    return db.Query(query)
}

// CORRECT: Use parameterized queries
func getUserByName(db *sql.DB, name string) (*User, error) {
    query := "SELECT * FROM users WHERE name = $1"
    row := db.QueryRow(query, name) // Driver escapes automatically
    // ...
}

// CORRECT: For dynamic column names, use whitelist
func sortUsers(db *sql.DB, sortColumn string) ([]User, error) {
    allowedColumns := map[string]bool{
        "name": true, "email": true, "created_at": true,
    }

    if !allowedColumns[sortColumn] {
        return nil, fmt.Errorf("invalid sort column: %s", sortColumn)
    }

    query := fmt.Sprintf("SELECT * FROM users ORDER BY %s", sortColumn)
    return db.Query(query)
}
```

### Junior to FAANG: Connecting Mistakes to Incident Patterns

Each mistake above maps to a real incident class you will eventually diagnose. Rows not closed causes "database/sql: connection is busy" errors at p99 under load, typically at 3 AM when traffic doubles. The first-job debug reflex is to check SHOW PROCESSLIST (MySQL) or pg_stat_activity (Postgres) for idle-in-transaction sessions older than 60 seconds. If the connection count equals MaxOpenConns and the oldest idle session came from a handler that iterates rows, you found it.

Query-for-non-SELECT is subtler. The leak only manifests when the connection is not garbage-collected quickly, which means low-traffic services hide it for weeks. The worked-example debug: write a load test that loops 10k deletes and watch open_connections rise monotonically. If it rises, someone used Query instead of Exec.

Transaction mismanagement is the top-3 cause of database outages at companies under 100 engineers. A handler returns early on validation failure without committing or rolling back, the connection stays checked out, and 30 minutes later the pool is empty. The interview entry-point version: "Walk me through the lifecycle of a *sql.Tx in Go." If you cannot name the three exit paths (Commit, Rollback, and connection drop due to context cancellation), you are not ready for a backend role at a database-heavy product.

Context cancellation is the most commonly missed mistake because tests pass without it. A junior-to-senior signal is whether you default to QueryContext even in internal tools. The why-did-this-fail reflex here: when a request times out but the database query keeps running, you used Query instead of QueryContext and the pool will not recover until the query completes.

SQL injection in 2026 should never happen in a greenfield Go codebase because the stdlib and every ORM default to parameterized queries. Where it does appear is in (1) dynamic ORDER BY, (2) dynamic table names for multi-tenant schemas, (3) string-building admin tools. The whitelist pattern above is the entry-level answer. The senior answer is to use a query builder like squirrel or sqlc that refuses to accept un-validated identifiers.

First-job checklist you should be able to apply to any PR: defer rows.Close, defer tx.Rollback, QueryContext with a deadline, parameterized args for every value, whitelist for every identifier, Exec for every non-SELECT.

### Senior at FAANG: Mistake Governance and Fleet-Wide Prevention

At staff level individual bug-fixes are not enough. You need mechanisms that make the mistake impossible across a 500-engineer codebase. The mechanisms are linters, review rules, platform abstractions, and SLO-backed alerts.

Linter coverage. Every Go monorepo at scale should run rowserrcheck, sqlclosecheck, and contextcheck in CI. These catch mistakes 1, 2, and 4 automatically. Add a custom analysis pass that refuses any call to db.Query, db.Exec, or db.QueryRow that is not db.QueryContext, db.ExecContext, or db.QueryRowContext. This class of lint is standard at database-heavy Go shops. If your org does not run it, write the ADR to add it.

Platform abstractions. At scale you do not hand raw *sql.DB to product teams. You hand them a wrapped client that enforces context propagation, emits tracing spans, records query metrics per normalized SQL fingerprint, and refuses queries longer than a configured statement_timeout. Datadog's postgres_dbm works by scraping pg_stat_statements and correlating normalized fingerprints with APM traces. Build the wrapper so fingerprints are automatic.

Schema-change governance (the most consequential). The classic failure mode is DDL that holds ACCESS EXCLUSIVE too long: a migration or a partition-maintenance job takes the lock, every query on the table queues behind it, and the table goes dark for the duration. The fleet-wide prevention is a migration framework that enforces:

```
# Schema-change ADR (mandatory in every migration PR)
- Lock type acquired: (ACCESS EXCLUSIVE, SHARE, ROW EXCLUSIVE)
- Estimated lock duration at 2x current row count
- lock_timeout set: (yes, value)
- statement_timeout set: (yes, value)
- Rollback procedure: (inverse migration, point-in-time recovery window)
- Tool: (plain SQL, pg_repack, pgroll, gh-ost, pt-osc)
- Backfill strategy: (online batched, offline, none)
- Canary plan: (staging for 24h, shadow read for 1 week)
```

Any migration that cannot answer all eight questions is blocked at review. A mature schema-change review board rejects a meaningful fraction of proposed migrations on first submission for missing one of these fields.

Online DDL tooling ADR. For MySQL the choice is gh-ost vs pt-online-schema-change. gh-ost reads the binlog rather than using triggers and is the tool GitHub built and runs by default, while pt-online-schema-change is trigger-based. For Postgres the choice is pg_repack (for bloat) vs pgroll (for multi-version schema) vs reshape (similar to pgroll) vs plain ALTER with a long enough lock_timeout for small tables. The ADR criteria: table size, write throughput during migration window, Postgres version (pgroll requires 13+), and whether the change is type-changing (requires pgroll-style expand-contract).

VACUUM governance. At 1 TB+ Postgres, default autovacuum settings cause bloat because the cost limits were tuned for 2005 hardware. The ADR that every senior Postgres operator should have written: per-table autovacuum_vacuum_scale_factor, autovacuum_vacuum_cost_limit, and a scheduled pg_repack rotation. Without this, autovacuum falls behind, and as the oldest unfrozen XID ages past `autovacuum_freeze_max_age` (200M by default) Postgres forces increasingly aggressive anti-wraparound vacuums, culminating in a read-only shutdown near the 2-billion-XID limit if it never catches up. Uber's 2016 "Why We Switched from Postgres to MySQL" blog post attributed part of their pain to this class of vacuum and write-amplification cost.

Partitioning ADR. Time-based range partitioning is the default. Hash partitioning is for when access is not time-skewed (the classic example is user_id keyed data with uniform access). List partitioning is for multi-tenant with a small tenant count. The staff-engineer criterion: write a 6-month forward projection of row count and query patterns before picking a scheme. The mistake pattern is choosing hash when time would have been cheaper because someone read a blog post about Uber.

Blast-radius thinking. For every database change a staff engineer should ask: "If this deployment is wrong, how many rows are corrupted and how long to restore?" A bad migration on a 10 TB table with PITR retention of 7 days is a potential 7-day rollback window. A bad application bug that UPDATEs without WHERE is worse because it affects all rows in microseconds. A single "UPDATE without WHERE" on a large orders table can corrupt every row that fast and force hours of PITR restore plus cross-team reconciliation, a failure mode many teams have lived through. The prevention is (1) require WHERE in all UPDATE/DELETE via a linter, (2) require two-person approval for production migrations, (3) rehearse PITR restore monthly so the runbook is not stale.

Oncall maturity for databases. At Level 1 the developer who wrote the code is oncall. At Level 3 a platform DBA team owns the database, develops the runbooks, and the product team is paged only for product-specific errors (constraint violations, deadlocks on their tables). At Level 5 the database team publishes SLOs per tenant, the product team is a customer with a budget. Know which level applies to the role you are interviewing for and ask the interviewer where their org sits.

---
