## Database Pitfalls: When Your Data Layer Breaks Production

### The Connection Pool Starvation Nightmare

**The Incident**: An e-commerce platform had a 25-connection pool for their PostgreSQL database. During Black Friday, response times shot from 50ms to 30 seconds. The database wasn't overloaded - CPU was at 15%. Investigation revealed that long-running report queries (triggered by a marketing dashboard) were holding connections for 2+ minutes. The remaining connections were quickly exhausted by checkout requests. The pool couldn't grow because `MaxOpenConns` was set, but there was no timeout on acquiring connections.

```go
// WRONG: No acquire timeout, no separation of concerns
func setupDB() *sql.DB {
    db, _ := sql.Open("pgx", dsn)
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    // Missing: SetConnMaxLifetime, SetConnMaxIdleTime
    // Missing: Connection acquire timeout
    return db
}

// Both short and long queries use same pool
func getUser(ctx context.Context, id int64) (*User, error) {
    var user User
    err := db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id).Scan(&user.ID, &user.Name)
    return &user, err
}

func generateReport(ctx context.Context) ([]Row, error) {
    // This 2-minute query blocks other operations
    rows, err := db.QueryContext(ctx, "SELECT ... complex aggregation ...")
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    return nil, nil
}

// CORRECT: Separate pools for different workloads
type DBPools struct {
    Primary  *sql.DB // For short OLTP queries
    Replica  *sql.DB // For read-heavy operations
    Reports  *sql.DB // For long-running analytical queries
}

func setupDBPools(cfg Config) (*DBPools, error) {
    primary, err := setupPool(cfg.PrimaryDSN, PoolConfig{
        MaxOpen:         50,
        MaxIdle:         25,
        ConnMaxLifetime: 1 * time.Hour,
        ConnMaxIdleTime: 10 * time.Minute,
    })
    if err != nil {
        return nil, err
    }

    replica, err := setupPool(cfg.ReplicaDSN, PoolConfig{
        MaxOpen:         100, // More for reads
        MaxIdle:         50,
        ConnMaxLifetime: 1 * time.Hour,
        ConnMaxIdleTime: 10 * time.Minute,
    })
    if err != nil {
        return nil, err
    }

    reports, err := setupPool(cfg.ReportsDSN, PoolConfig{
        MaxOpen:         5,  // Limited for expensive queries
        MaxIdle:         2,
        ConnMaxLifetime: 30 * time.Minute,
        ConnMaxIdleTime: 5 * time.Minute,
    })
    if err != nil {
        return nil, err
    }

    return &DBPools{Primary: primary, Replica: replica, Reports: reports}, nil
}

// Use context timeout as acquire timeout
func getUser(ctx context.Context, pools *DBPools, id int64) (*User, error) {
    // Short timeout for OLTP
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    var user User
    err := pools.Primary.QueryRowContext(ctx,
        "SELECT * FROM users WHERE id = $1", id).Scan(&user.ID, &user.Name)
    return &user, err
}

func generateReport(ctx context.Context, pools *DBPools) ([]Row, error) {
    // Long timeout for reports, uses separate pool
    ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()

    return pools.Reports.QueryContext(ctx, "SELECT ... complex aggregation ...")
}
```

### The Rows.Close() Leak Epidemic

**The Incident**: A Go service's memory grew linearly over 3 days until OOM killed it. Memory profiler showed thousands of `*sql.Rows` objects. The code looked correct - it had `defer rows.Close()`. But the function returned early on certain error conditions before reaching the `Query()` call, and a later refactor moved error handling before the defer. The rows were never closed, connections leaked, and eventually the pool was exhausted with abandoned connections.

```go
// WRONG: Early return before defer, easy to miss in refactoring
func getActiveUsers(ctx context.Context, db *sql.DB) ([]*User, error) {
    if err := validateContext(ctx); err != nil {
        return nil, err
    }

    rows, err := db.QueryContext(ctx, "SELECT * FROM users WHERE active = true")
    if err != nil {
        return nil, err // No rows to close yet - OK
    }
    defer rows.Close() // This is fine...

    var users []*User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name); err != nil {
            return nil, err // rows.Close() called via defer - OK
        }

        // Later, someone adds a check here...
        if u.Name == "" {
            continue // This is fine
        }
        users = append(users, &u)
    }

    // But what if the loop is refactored to return early?
    return users, rows.Err()
}

// CORRECT: Use helper that guarantees cleanup
func getActiveUsers(ctx context.Context, db *sql.DB) ([]*User, error) {
    if err := validateContext(ctx); err != nil {
        return nil, err
    }

    return queryUsers(ctx, db, "SELECT * FROM users WHERE active = true")
}

// Helper that encapsulates the rows lifecycle
func queryUsers(ctx context.Context, db *sql.DB, query string, args ...any) ([]*User, error) {
    rows, err := db.QueryContext(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("query: %w", err)
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Active); err != nil {
            return nil, fmt.Errorf("scan: %w", err)
        }
        users = append(users, &u)
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("rows iteration: %w", err)
    }

    return users, nil
}

// Even better: Use sqlx or similar that handles this
func getActiveUsersSqlx(ctx context.Context, db *sqlx.DB) ([]*User, error) {
    var users []*User
    err := db.SelectContext(ctx, &users,
        "SELECT * FROM users WHERE active = true")
    return users, err
}
```

### The Transaction Timeout Trap

**The Incident**: A payment service used database transactions for atomic balance updates. Under load, some transactions took 30+ seconds to complete. Developers added a 5-second context timeout to the transaction start. But they didn't realize the timeout only affected the `BEGIN` statement, not subsequent queries. Long-running transactions still held locks, causing deadlocks. The "fix" made things worse by adding timeouts that caused partial commits in some edge cases.

```go
// WRONG: Timeout only on BEGIN, not entire transaction
func transferMoney(ctx context.Context, db *sql.DB, from, to int64, amountCents int64) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    tx, err := db.BeginTx(ctx, nil) // Timeout applies to BEGIN only
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // These queries run WITHOUT timeout after BEGIN completes
    _, err = tx.Exec("UPDATE accounts SET balance = balance - $1 WHERE id = $2", amountCents, from)
    if err != nil {
        return err
    }

    _, err = tx.Exec("UPDATE accounts SET balance = balance + $1 WHERE id = $2", amountCents, to)
    if err != nil {
        return err
    }

    return tx.Commit() // May hang indefinitely!
}

// CORRECT: Apply context timeout to ALL operations
func transferMoney(ctx context.Context, db *sql.DB, from, to int64, amountCents int64) error {
    // Create timeout context for entire transaction
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }

    // Use a helper to ensure proper cleanup
    committed := false
    defer func() {
        if !committed {
            tx.Rollback()
        }
    }()

    // Pass context to ALL queries
    _, err = tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amountCents, from)
    if err != nil {
        return fmt.Errorf("debit: %w", err)
    }

    _, err = tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amountCents, to)
    if err != nil {
        return fmt.Errorf("credit: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit: %w", err)
    }
    committed = true

    return nil
}

// Production-grade: With retry and idempotency
func transferMoneyWithRetry(ctx context.Context, db *sql.DB, idempotencyKey string, from, to int64, amountCents int64) error {
    return withRetry(ctx, 3, func() error {
        return executeTransfer(ctx, db, idempotencyKey, from, to, amountCents)
    })
}

func executeTransfer(ctx context.Context, db *sql.DB, idempotencyKey string, from, to int64, amountCents int64) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Check idempotency first
    var exists bool
    err = tx.QueryRowContext(ctx,
        "SELECT EXISTS(SELECT 1 FROM transfers WHERE idempotency_key = $1)",
        idempotencyKey).Scan(&exists)
    if err != nil {
        return err
    }
    if exists {
        return nil // Already processed
    }

    // Record the transfer for idempotency
    _, err = tx.ExecContext(ctx,
        "INSERT INTO transfers (idempotency_key, from_id, to_id, amount_cents) VALUES ($1, $2, $3, $4)",
        idempotencyKey, from, to, amountCents)
    if err != nil {
        return err
    }

    // Perform the transfer
    _, err = tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1",
        amountCents, from)
    if err != nil {
        return err
    }

    _, err = tx.ExecContext(ctx,
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        amountCents, to)
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

### The NULL Pointer Panic

**The Incident**: A user profile service crashed in production with a nil pointer dereference. The crash happened when accessing a field that was definitely populated - according to the struct definition. Root cause: the database column was nullable, but the Go struct used `string` instead of `sql.NullString`. When the column was NULL, `Scan()` succeeded but set the zero value. Later code assumed the value was valid because the struct field wasn't a pointer. Even worse, the crash was intermittent because most users had values, so tests passed.

```go
// WRONG: Non-nullable Go types for nullable columns
type User struct {
    ID        int64
    Name      string     // What if DB has NULL?
    Email     string     // What if DB has NULL?
    Phone     string     // Almost certainly nullable
    DeletedAt time.Time  // NULL when not deleted
}

func getUser(ctx context.Context, db *sql.DB, id int64) (*User, error) {
    var u User
    err := db.QueryRowContext(ctx,
        "SELECT id, name, email, phone, deleted_at FROM users WHERE id = $1", id).
        Scan(&u.ID, &u.Name, &u.Email, &u.Phone, &u.DeletedAt)
    // If phone is NULL, this doesn't error but Phone is ""
    // If deleted_at is NULL, this DOES error!
    return &u, err
}

// CORRECT: Match Go types to column nullability
type User struct {
    ID        int64
    Name      string           // NOT NULL in DB
    Email     string           // NOT NULL in DB
    Phone     sql.NullString   // NULL allowed
    DeletedAt sql.NullTime     // NULL when not deleted
}

func getUser(ctx context.Context, db *sql.DB, id int64) (*User, error) {
    var u User
    err := db.QueryRowContext(ctx,
        "SELECT id, name, email, phone, deleted_at FROM users WHERE id = $1", id).
        Scan(&u.ID, &u.Name, &u.Email, &u.Phone, &u.DeletedAt)
    return &u, err
}

// API model conversion with explicit null handling
type UserResponse struct {
    ID        int64   `json:"id"`
    Name      string  `json:"name"`
    Email     string  `json:"email"`
    Phone     *string `json:"phone,omitempty"`
    DeletedAt *string `json:"deleted_at,omitempty"`
}

func toResponse(u *User) UserResponse {
    resp := UserResponse{
        ID:    u.ID,
        Name:  u.Name,
        Email: u.Email,
    }

    if u.Phone.Valid {
        resp.Phone = &u.Phone.String
    }

    if u.DeletedAt.Valid {
        t := u.DeletedAt.Time.Format(time.RFC3339)
        resp.DeletedAt = &t
    }

    return resp
}

// Alternative: Use pointers throughout (sqlx approach)
type UserPtr struct {
    ID        int64
    Name      string
    Email     string
    Phone     *string    // nil when NULL
    DeletedAt *time.Time // nil when NULL
}
```

### The N+1 Query Catastrophe

**The Incident**: A blog API endpoint to list posts with authors was fast in development (10 posts, 10 authors). In production with pagination showing 50 posts, it made 51 database queries per request (1 for posts + 50 for authors). At 100 requests/second, the database was handling 5,100 queries/second for one endpoint. Response times were 2 seconds, and the database CPU was pegged at 100%.

```go
// WRONG: N+1 queries
func getPostsWithAuthors(ctx context.Context, db *sql.DB) ([]PostWithAuthor, error) {
    rows, _ := db.QueryContext(ctx, "SELECT id, title, author_id FROM posts LIMIT 50")
    defer rows.Close()

    var results []PostWithAuthor
    for rows.Next() {
        var p Post
        rows.Scan(&p.ID, &p.Title, &p.AuthorID)

        // N additional queries!
        var author Author
        db.QueryRowContext(ctx,
            "SELECT id, name FROM authors WHERE id = $1", p.AuthorID).
            Scan(&author.ID, &author.Name)

        results = append(results, PostWithAuthor{Post: p, Author: author})
    }
    return results, nil
}

// CORRECT: Single query with JOIN
func getPostsWithAuthors(ctx context.Context, db *sql.DB) ([]PostWithAuthor, error) {
    rows, err := db.QueryContext(ctx, `
        SELECT p.id, p.title, p.author_id, a.id, a.name
        FROM posts p
        JOIN authors a ON p.author_id = a.id
        ORDER BY p.created_at DESC
        LIMIT 50
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []PostWithAuthor
    for rows.Next() {
        var pwa PostWithAuthor
        err := rows.Scan(
            &pwa.Post.ID, &pwa.Post.Title, &pwa.Post.AuthorID,
            &pwa.Author.ID, &pwa.Author.Name,
        )
        if err != nil {
            return nil, err
        }
        results = append(results, pwa)
    }
    return results, rows.Err()
}

// Alternative: Batch load with IN clause
func getPostsWithAuthorsBatch(ctx context.Context, db *sql.DB) ([]PostWithAuthor, error) {
    // First query: get all posts
    rows, _ := db.QueryContext(ctx, "SELECT id, title, author_id FROM posts LIMIT 50")
    defer rows.Close()

    var posts []Post
    authorIDs := make(map[int64]bool)
    for rows.Next() {
        var p Post
        rows.Scan(&p.ID, &p.Title, &p.AuthorID)
        posts = append(posts, p)
        authorIDs[p.AuthorID] = true
    }

    // Second query: batch load all authors
    ids := make([]int64, 0, len(authorIDs))
    for id := range authorIDs {
        ids = append(ids, id)
    }

    authorsMap := make(map[int64]Author)
    authorRows, _ := db.QueryContext(ctx,
        "SELECT id, name FROM authors WHERE id = ANY($1)", pq.Array(ids))
    defer authorRows.Close()

    for authorRows.Next() {
        var a Author
        authorRows.Scan(&a.ID, &a.Name)
        authorsMap[a.ID] = a
    }

    // Combine results
    results := make([]PostWithAuthor, len(posts))
    for i, p := range posts {
        results[i] = PostWithAuthor{Post: p, Author: authorsMap[p.AuthorID]}
    }
    return results, nil
}
```

### Quick Reference: Database Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Connection pool exhaustion | Requests hang, timeouts | Separate pools, acquire timeouts |
| Rows not closed | Memory leak, connection leak | Helper functions, sqlx |
| Transaction timeout scope | Deadlocks, hung queries | Pass context to ALL queries |
| NULL handling | Panics, zero values | sql.Null* types, pointers |
| N+1 queries | Slow responses, high DB load | JOINs, batch loading |
| Missing indexes | Full table scans, slow queries | EXPLAIN ANALYZE, add indexes |
| Placeholder mismatch | Runtime errors (postgres vs mysql) | Use correct syntax ($1 vs ?) |
| Stale connections | Random failures after idle | SetConnMaxLifetime |

### Junior to FAANG: Pitfall Diagnosis as a First-Year Skill

Every pitfall above has a characteristic pager signature. Learning these signatures is the difference between guessing and diagnosing. A pool-starvation incident looks like: p99 latency climbs, p50 stays flat for a few minutes, then p50 climbs too, and InUse connections sits at MaxOpenConns for the duration. The database CPU is low. This pattern should trigger one thought: a long-running query is holding connections. Run pg_stat_activity filtered by state != 'idle' and ordered by query_start. The top row is almost always your culprit.

Rows-leak signature: memory grows linearly over days, not hours. The process does not crash suddenly, it gets OOM-killed by the kernel or by Kubernetes after a threshold. A pprof heap profile shows sql.Rows or driver.Rows allocations that never get freed. The first-job reflex is to grep for db.Query( and db.QueryContext( and audit every call for defer rows.Close.

Transaction-timeout-trap signature: deadlock errors in the Postgres log, application timeouts that do not map to slow queries in pg_stat_statements, and tx rollback counts climbing. The root cause is almost always a context that does not propagate to tx.ExecContext, or a BeginTx context that was canceled but the tx continued.

NULL panic signature: the crash is intermittent, happens on specific user IDs, and the stack trace points to a Scan or a dereference of a zero-value struct field. The why-did-this-fail reflex is to run psql and SELECT the columns for the failing row. If any are NULL and the Go struct has a non-pointer type, you found it.

N+1 signature: endpoint is fast in dev, slow in staging, unusable in prod. pg_stat_statements shows one query with calls in the thousands per request. Turn on sqlcommenter or pg_stat_statements normalization and look for a WHERE id = $1 query with calls > rows_read. That ratio is your N+1.

Worked example for a junior: given a slow endpoint, run through the signatures above in order (pool, rows leak, tx timeout, NULL, N+1). Each has a specific metric or log line. If none match, you have an index or plan problem, which is chapter 33 material.

Interview entry-point: "Your checkout endpoint used to take 100ms, now takes 5 seconds under load. Walk me through how you diagnose it." Expected arc: (1) check p99 vs p50 to distinguish tail latency from general slowdown, (2) check pool metrics, (3) check database CPU and active queries, (4) check slow query log, (5) reproduce with a load test and capture a CPU and heap profile. Skipping metrics and going straight to code is an L3 signal.

First-year database oncall checklist: know where your pool metrics are, know the Postgres or MySQL commands to list active queries, know how to read pg_stat_statements, know where backup and PITR runbooks live, know who to escalate to. If any of these is unknown, write the answer down and ask in your next 1:1.

### Senior at FAANG: Pitfall Governance and Runbook Design

At staff level your job is to make pitfalls rare by design, not to diagnose them faster. The following are the governance artifacts and real incident patterns that every database platform lead should have.

Pool-starvation governance. The pattern of one pool for OLTP and one for reports is correct but insufficient at scale. The actual ADR for a large Postgres fleet separates by query class (OLTP, batch, analytical, admin), by tenant (per-team pool or per-service pool), and by priority (foreground user traffic, background job). pgbouncer in transaction mode with per-database pools is the standard pattern for this. The ADR criteria: how many tenants, what is the isolation requirement, how is cost allocated. Without pgbouncer, a 1000-service fleet will exhaust Postgres connections even at 5 per service.

A common incident shape: a batch or analytics job drains the shared connection pool during a traffic spike, starving foreground user requests. The post-incident fix is per-workload pgbouncer pools and a connection budget per service enforced at the proxy.

Rows-leak governance. Linter (sqlclosecheck, rowserrcheck) plus a platform wrapper that returns a typed iterator rather than raw *sql.Rows. The iterator's Close is called by the wrapper in a finally block, making the leak structurally impossible. sqlc generates this pattern automatically. At 100+ engineers, hand-written database/sql is a reliability liability, not a flexibility asset.

Transaction-timeout governance. statement_timeout at the session level, lock_timeout at the transaction level, and idle_in_transaction_session_timeout at the connection level. All three are non-default and must be set explicitly. The ADR should mandate values based on workload: OLTP 5s statement / 1s lock / 30s idle, batch 5min / 10s / 2min, migrations unlimited statement / 50ms lock with retry / 0 idle. A classic version of this pitfall is an idle-in-transaction session that holds a lock for tens of minutes and blocks a migration, which traces back to a missing idle_in_transaction_session_timeout.

NULL-handling governance. At 10 million LOC you cannot rely on developers matching Go types to schema nullability. sqlc generates nullable types from the schema automatically. The ADR: adopt sqlc or ent, ban hand-written Scan into raw types, migrate legacy code over 2 quarters. Many Go-Postgres shops have moved their services to almost entirely sqlc-generated data-access code.

N+1 governance. At FAANG scale N+1 is detected automatically. Every query carries a trace span with a span-kind of db.client and a parent span for the HTTP request. A sidecar or an APM agent (Datadog, Honeycomb, Grafana Tempo) alerts on span counts per parent above a threshold (commonly 10). Many feed and timeline latency incidents are diagnosed exactly this way. Writing the query manually and using EXPLAIN is the 2015 answer. The 2025 answer is observability-driven detection with dataloader patterns in the application layer.

Runbook template for replica promotion (staff-level artifact):

```
# Runbook: Promote Postgres Replica R2 to Primary
Trigger: Primary P1 unreachable for > 60s OR PagerDuty incident DB-PRIMARY-DOWN.
Prerequisites: Oncall has prod DBA access, Consul UI open, Slack war-room created.

Step 1 (30s): Confirm P1 is truly down.
  - psql -h p1 -c "SELECT 1" from bastion. Expect timeout.
  - Check CloudWatch or equivalent for instance status.
  - If P1 responds, ABORT. This may be a partition.

Step 2 (60s): Check R2 replication lag.
  - psql -h r2 -c "SELECT pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp()"
  - If lag > 30s, consider R3 instead. Lag > 5min means data loss, require VP approval.

Step 3 (30s): Fence P1.
  - Revoke security-group ingress on P1 port 5432.
  - Confirm no connections via psql.

Step 4 (60s): Promote R2.
  - ssh r2 && sudo -u postgres pg_ctl promote -D /var/lib/postgresql/14/main
  - Verify: psql -h r2 -c "SELECT pg_is_in_recovery()" returns false.

Step 5 (120s): Redirect traffic.
  - Update Consul KV db/primary/host = r2.
  - Application services watch this key and reconnect.
  - Confirm via app logs and pool metrics.

Step 6 (30min): Re-bootstrap P1 as new replica.
  - pg_rewind or pg_basebackup from R2.
  - Start as streaming replica.

Step 7 (post-incident): Reconcile any writes in the fence window.
  - Query binlog or WAL archive for writes that landed on P1 after Step 1.
  - Manual reconciliation required if any exist.

Expected total RTO: 5 to 8 minutes for steps 1 to 5.
Expected RPO: 0 to 30 seconds depending on lag at Step 2.
```

Every paragraph of this runbook must be rehearsed monthly in a game-day. Mature database teams run quarterly primary-loss game-days with random replica selection. Runbooks that sit untested rot within 6 months because the infra changes under them.

pg_repack vs pg_squeeze vs CLUSTER governance. pg_repack is the default for online bloat removal, requires a trigger and doubles disk space temporarily. pg_squeeze is newer, uses logical decoding to avoid triggers, and is gaining adoption at Postgres-heavy shops. CLUSTER is offline-only and should be reserved for dev. The ADR criteria: table size, write traffic during repack, disk headroom, Postgres version. For tables > 500 GB with continuous writes, pg_squeeze. For tables < 100 GB, pg_repack. For offline-tolerant workloads, CLUSTER with a maintenance window.

VACUUM tuning ADR skeleton:

```
# ADR: Per-Table autovacuum Tuning for orders
Observation: orders table is 2 TB, 30k updates/s, current autovacuum runs daily for 4 hours.
Current cost limit: 200 (default). Vacuum is IO-bound, not making progress.
Proposal:
  - autovacuum_vacuum_cost_limit = 2000 (10x default)
  - autovacuum_vacuum_scale_factor = 0.05 (vs default 0.2)
  - autovacuum_vacuum_threshold = 10000
Expected: autovacuum runs every 2 hours for 30 minutes, keeps bloat below 15%.
Rollback: revert settings, observe for 72 hours.
Risk: higher IO during autovacuum. Mitigated by running during off-peak.
Monitoring: pg_stat_user_tables.n_dead_tup, pg_stat_progress_vacuum.
```

Partitioning ADR for the orders table (staff-level example): range partition by created_at monthly, attach new partition via ALTER TABLE ATTACH PARTITION during a maintenance window, detach and archive partitions older than 24 months to S3 via pg_dump. Avoid pg_partman in favor of explicit scripts for large deployments because pg_partman's locking behavior surprises teams at 100+ partitions.

---
