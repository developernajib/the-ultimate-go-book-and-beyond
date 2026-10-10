## 32.5 Prepared Statements

### Using Prepared Statements

Prepared statements send the query to the database for parsing and planning once, then execute it multiple times with different parameters. Beyond the performance benefit for repeated queries, they provide the primary defense against SQL injection.

> **Senior track**: Most Go drivers, including `pgx`, already cache prepared statements per connection internally, so explicit `db.Prepare` adds less value than engineers expect - in many cases the per-query overhead of parameterized SQL through `QueryContext`/`ExecContext` is already near-optimal. Explicit prepared statements remain useful in three cases: (1) hot-path queries executed thousands of times per second where you want to pin the plan, (2) when you need the server-side plan reused across a long-lived connection in a background worker, and (3) when you are driving a high-throughput batch load against a single connection. Note that `*sql.Stmt` is safe for concurrent use - the pool transparently re-prepares the statement on whichever connection it lands on.

```go
func preparedStatements(db *sql.DB) {
    // Prepare statement
    stmt, err := db.Prepare(`SELECT id, name FROM users WHERE email = $1`)
    if err != nil {
        log.Fatal(err)
    }
    defer stmt.Close()

    // Use multiple times
    emails := []string{"alice@example.com", "bob@example.com"}
    for _, email := range emails {
        var id int64
        var name string
        err := stmt.QueryRow(email).Scan(&id, &name)
        if err == sql.ErrNoRows {
            continue
        }
        if err != nil {
            log.Printf("Error querying %s: %v", email, err)
            continue
        }
        fmt.Printf("Found: %d - %s\n", id, name)
    }
}
```

### Statement Pool Pattern

For applications with a fixed set of queries, preparing them all at startup avoids the per-request cost of parsing and planning. The `Queries` struct below holds each prepared statement as a field, and `PrepareQueries` returns an error if any statement fails to compile, catching SQL typos at startup rather than at runtime. Call `Close()` during graceful shutdown to release the server-side prepared statement resources.

```go
type Queries struct {
    getUserByID    *sql.Stmt
    getUserByEmail *sql.Stmt
    createUser     *sql.Stmt
    updateUser     *sql.Stmt
    deleteUser     *sql.Stmt
}

func PrepareQueries(db *sql.DB) (*Queries, error) {
    q := &Queries{}
    var err error

    q.getUserByID, err = db.Prepare(`SELECT id, name, email FROM users WHERE id = $1`)
    if err != nil {
        return nil, err
    }

    q.getUserByEmail, err = db.Prepare(`SELECT id, name, email FROM users WHERE email = $1`)
    if err != nil {
        return nil, err
    }

    q.createUser, err = db.Prepare(`INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id`)
    if err != nil {
        return nil, err
    }

    q.updateUser, err = db.Prepare(`UPDATE users SET name = $1, email = $2 WHERE id = $3`)
    if err != nil {
        return nil, err
    }

    q.deleteUser, err = db.Prepare(`DELETE FROM users WHERE id = $1`)
    if err != nil {
        return nil, err
    }

    return q, nil
}

func (q *Queries) Close() {
    q.getUserByID.Close()
    q.getUserByEmail.Close()
    q.createUser.Close()
    q.updateUser.Close()
    q.deleteUser.Close()
}
```

### Junior → FAANG: Understanding What Prepared Statements Actually Are

New engineers often conflate "parameterized query" with "prepared statement." They are related but not identical. A parameterized query is a SQL string with placeholders (`$1`, `$2`, `?`) plus separately bound arguments, which defeats SQL injection because the driver sends the text and the values over different protocol messages. A prepared statement is a named, server-side object created by the database after it parses and plans the SQL once, so subsequent executions skip the parse and plan phases. `database/sql` calls like `db.QueryContext(ctx, "SELECT ... WHERE id = $1", id)` are always parameterized, and with `pgx` they are also prepared behind the scenes on the connection. A first-job rule is that you should never interpolate values into SQL strings with `fmt.Sprintf`, ever, no matter how "safe" the input looks. Common interview question: "What is the difference between a prepared statement and a stored procedure?" Answer: a prepared statement is a one-session plan cache for a single SQL statement, while a stored procedure is a named, persistent block of procedural SQL stored in the database catalog. Worked example for juniors: if you call `stmt.QueryRow(email)` on a `*sql.Stmt` returned from `db.Prepare`, the pool will pick any idle connection. If that connection has not prepared the statement yet, `database/sql` silently re-prepares it on that connection. This is why forgetting `defer stmt.Close()` leaks server-side statement handles across the whole pool.

### Senior @ FAANG: Plan Cache Poisoning, pgBouncer, and Protocol-Level Prepares

At staff and principal levels, prepared statements stop being a micro-optimization and become an operational liability you must reason about explicitly. Postgres uses a custom plan for the first five executions of a prepared statement, then considers switching to a generic plan that ignores parameter values. When the generic plan is chosen against a skewed column, you get catastrophic plan regression. A query that took 2ms on the custom plan can take 2 seconds on the generic plan because the planner assumes average selectivity instead of the actual parameter. The staff-level mitigation is `plan_cache_mode = force_custom_plan` per session for known-skewed queries, or rewriting the query to inline a literal where the optimizer needs it. You should also know that `pg_stat_statements` aggregates by normalized query text, so prepared and ad hoc versions of the same SQL land in the same bucket, which helps observability but hides per-plan latency differences.

The pgBouncer interaction is the classic senior trap. In transaction pooling mode prior to Postgres 14 plus pgBouncer 1.21, server-side prepared statements were fundamentally incompatible because each client transaction could land on a different server connection, and the `S_1` statement name the driver remembered did not exist on the new backend. The production symptom was intermittent `prepared statement "stmt_xxx" does not exist` errors under load. The modern fix is pgBouncer 1.21 plus with `max_prepared_statements` enabled, which tracks prepared statements at the pooler layer and replays them on new backends. If you are stuck on older infra, you disable statement caching in the driver (`pgx.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol` or `QueryExecModeExec`), which trades the plan cache for pool compatibility. This is a real ADR you will write.

Protocol-level versus session-level prepares is the next layer. The extended query protocol Parse/Bind/Execute messages let the driver send an unnamed prepared statement that lives only for the current execution, which avoids the cache-poisoning class of bugs entirely while still preserving parameter safety and avoiding text-based re-parsing. `pgx` exposes this as `QueryExecModeExec` (unnamed) versus `QueryExecModeCacheStatement` (named and cached) versus `QueryExecModeDescribeExec` (caches the Describe result but not the Parse). For read-replica fleets where connections churn, unnamed prepares are often the right default. For long-lived worker connections running the same five queries a million times, cached named prepares win. The test that separates mid-level from senior candidates is "explain when you would choose each mode and how you would verify the choice under production load." Good answers include query-level `pg_stat_statements` deltas, p99 latency histograms per query fingerprint, and load-testing with representative parameter distributions to surface the generic-plan cliff before it surfaces in an incident.

---
