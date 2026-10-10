## 32.2 Basic CRUD Operations

### Query Single Row

`QueryRow` returns a single `*sql.Row` whose `Scan` method copies column values into Go variables. If no row matches, `Scan` returns `sql.ErrNoRows` rather than a nil row, so the caller checks for that sentinel to distinguish "not found" from a real error. The parameterized placeholder `$1` prevents SQL injection. The driver escapes the value automatically.

```go
var ErrNotFound = errors.New("not found")

type User struct {
    ID        int64
    Name      string
    Email     string
    CreatedAt time.Time
}

func getUserByID(db *sql.DB, id int64) (*User, error) {
    query := `
        SELECT id, name, email, created_at
        FROM users
        WHERE id = $1
    `

    var user User
    err := db.QueryRow(query, id).Scan(
        &user.ID,
        &user.Name,
        &user.Email,
        &user.CreatedAt,
    )

    if err == sql.ErrNoRows {
        return nil, nil // Not found
    }
    if err != nil {
        return nil, err
    }

    return &user, nil
}
```

### Query Multiple Rows

`Query` returns `*sql.Rows`, which holds an open database connection until `Close()` is called. The `defer rows.Close()` ensures the connection returns to the pool even if scanning fails partway through. After the loop, `rows.Err()` catches errors that occurred during iteration (for example, a network interruption mid-stream).

```go
func getAllUsers(db *sql.DB) ([]User, error) {
    query := `SELECT id, name, email, created_at FROM users ORDER BY id`

    rows, err := db.Query(query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []User
    for rows.Next() {
        var user User
        if err := rows.Scan(&user.ID, &user.Name, &user.Email, &user.CreatedAt); err != nil {
            return nil, err
        }
        users = append(users, user)
    }

    // Check for errors during iteration
    if err := rows.Err(); err != nil {
        return nil, err
    }

    return users, nil
}

// With filtering
func getUsersByStatus(db *sql.DB, status string, limit int) ([]User, error) {
    query := `
        SELECT id, name, email, created_at
        FROM users
        WHERE status = $1
        ORDER BY created_at DESC
        LIMIT $2
    `

    rows, err := db.Query(query, status, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []User
    for rows.Next() {
        var user User
        if err := rows.Scan(&user.ID, &user.Name, &user.Email, &user.CreatedAt); err != nil {
            return nil, err
        }
        users = append(users, user)
    }

    return users, rows.Err()
}
```

### Insert

PostgreSQL's `RETURNING id` clause lets you retrieve the auto-generated primary key in the same round trip as the insert, avoiding a separate `SELECT`. Because the insert returns a row, `QueryRow` is the correct method. For MySQL, which lacks `RETURNING`, use `Exec` and call `result.LastInsertId()` instead.

```go
func createUser(db *sql.DB, name, email string) (int64, error) {
    query := `
        INSERT INTO users (name, email, created_at)
        VALUES ($1, $2, NOW())
        RETURNING id
    `

    var id int64
    err := db.QueryRow(query, name, email).Scan(&id)
    if err != nil {
        return 0, err
    }

    return id, nil
}

// Without RETURNING (MySQL style)
func createUserMySQL(db *sql.DB, name, email string) (int64, error) {
    query := `INSERT INTO users (name, email, created_at) VALUES (?, ?, NOW())`

    result, err := db.Exec(query, name, email)
    if err != nil {
        return 0, err
    }

    return result.LastInsertId()
}
```

### Update

`Exec` is the right method for statements that do not return rows. Checking `RowsAffected` after the update detects the case where the `WHERE` clause matched nothing, typically meaning the record was already deleted or the ID is invalid. Returning a domain error like `ErrNotFound` keeps the caller from silently succeeding on a no-op update.

```go
func updateUser(db *sql.DB, id int64, name, email string) error {
    query := `
        UPDATE users
        SET name = $1, email = $2, updated_at = NOW()
        WHERE id = $3
    `

    result, err := db.Exec(query, name, email, id)
    if err != nil {
        return err
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return err
    }

    if rowsAffected == 0 {
        return ErrNotFound
    }

    return nil
}
```

### Delete

The delete follows the same pattern as the update: execute with `Exec`, then check `RowsAffected` to confirm the row existed. This pattern is idempotent-safe. A second delete of the same ID returns `ErrNotFound` rather than silently succeeding.

```go
func deleteUser(db *sql.DB, id int64) error {
    query := `DELETE FROM users WHERE id = $1`

    result, err := db.Exec(query, id)
    if err != nil {
        return err
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return err
    }

    if rowsAffected == 0 {
        return ErrNotFound
    }

    return nil
}
```

### Junior to FAANG: the CRUD patterns you must internalize

The four code samples above are the spine of every service you will write in your first five years. Memorize them. Then internalize the traps.

Trap one: returning `(nil, nil)` for not-found, as `getUserByID` does above, is a style choice that the broader Go community increasingly rejects. The canonical alternative is to return `(nil, ErrNotFound)` as `updateUser` and `deleteUser` do. Pick one pattern per codebase and apply it consistently. Code reviewers reject PRs that mix both styles in the same package. Your senior engineer's complaint will be "I cannot tell from the call site whether I need to check for nil or for an error." Return typed errors.

Trap two: the `RETURNING id` idiom works on Postgres, SQLite (3.35+), and MariaDB (10.5+), but not MySQL. If your service targets both Postgres and MySQL, your repository abstraction must branch on driver and use `LastInsertId()` for MySQL. sqlc handles this cleanly with per-engine generation, which is one reason to adopt it early.

Trap three: `Exec` returns a `sql.Result` whose `LastInsertId` is not implemented by the pgx driver, even for MySQL-style `INSERT`. Call `LastInsertId` only when you know the driver supports it. On Postgres, always use `RETURNING`.

Trap four: placeholder syntax is driver-specific. Postgres uses `$1, $2, $3`. MySQL uses `?, ?, ?`. SQLite accepts either. Your query strings are not portable without a builder or code generator.

Worked example for muscle memory: write a `UserRepository` interface with the five methods above, implement it for Postgres with pgx, write a `mock_user_repository.go` generated by `mockgen` or `moq`, and write a service test that uses the mock. This is the shape of every PR in your first year.

First-job interview entry-point on CRUD: expect "write a function to paginate users" as a follow-up. The cheap answer is `LIMIT $1 OFFSET $2`. The correct answer is keyset pagination: `WHERE id > $1 ORDER BY id LIMIT $2`, because OFFSET at high page numbers reads and discards all skipped rows. Knowing that difference lifts you out of the junior pile.

### Senior at FAANG: CRUD is where architectural decisions hide

Every line of CRUD above has a staff-level consequence that juniors do not see. The senior responsibility is making those consequences explicit in code review and ADRs.

**Parameter binding and the prepared statement cache.** The examples use `db.QueryRow(query, id)`. Under `database/sql`, this prepares the statement, caches it on the connection, binds parameters, and executes. The cache lookup is keyed by the exact query string. If you construct queries with string concatenation for dynamic WHERE clauses, each variation is a separate cache entry. Under heavy dynamic-query workloads the cache evicts hot entries and you see intermittent `Parse` overhead. The mitigation is a query builder (squirrel, sqlc) that generates a bounded set of query shapes, or pgx native's `Exec` which does not cache by default. Measure cache hit rate with pgx's `Config.StatementCacheCapacity` and Postgres' `pg_prepared_statements`.

**Keyset pagination and the bloom of OFFSET misuse.** Engineers at scale have removed `OFFSET` from most repositories. On a 100 million row table, `OFFSET 1000000` costs a million row reads and discards. The keyset idiom `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50` uses the compound index and stays constant-time regardless of page depth. For paginated APIs, encode the last-seen `(created_at, id)` as an opaque cursor token. Document this as a repository-layer standard so no one writes `OFFSET` by habit.

**Bulk insert and CopyFrom.** The `createUser` example inserts one row per call. For bulk ingest (import jobs, backfills, event ingestion) `INSERT` at one row per round trip is 10 to 100 times slower than pgx's `CopyFrom`, which streams data over the Postgres copy protocol. `CopyFrom` bypasses triggers that rely on row-level events unless you flip a flag, which is a correctness concern you document. The midpoint for moderate batches is multi-row `INSERT ... VALUES (...), (...), (...)` with at most 65535 parameters per statement (the Postgres wire protocol limit) or a configurable batch size (1000 rows is a safe default). Every data-heavy service needs all three patterns documented: single-row for OLTP, batched-insert for moderate throughput, `CopyFrom` for ingest.

**Soft delete versus hard delete.** The `deleteUser` above is a hard delete. In most production systems deletes are soft: `UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, with a partial index `WHERE deleted_at IS NULL` on lookup columns to keep hot queries fast. Hard delete reserved for GDPR erasure requests and compliance-driven purges. The ADR captures the policy, the partial index strategy, and the vacuum implications (soft-deleted rows accumulate until purged, which bloats the table and the index).

**Optimistic concurrency control.** The `updateUser` above has a race condition. Two concurrent updates can both read the old state, compute new values, and write, with the second overwriting the first. The fix is a `version` column: `UPDATE users SET name = $1, version = version + 1 WHERE id = $2 AND version = $3`. Check `RowsAffected()`. If zero, return `ErrConflict`, let the caller retry with a fresh read. This is the default pattern for any update that reads before writing. Alternatives are `SELECT ... FOR UPDATE` inside a transaction (pessimistic) or SERIALIZABLE isolation with a retry loop. Pick per workload and document the choice.

**Row-level security for multi-tenant isolation.** A multi-tenant SaaS must not let tenant A read tenant B's rows. Application-layer filtering (`WHERE tenant_id = $1`) is one missed clause away from a breach. The senior standard is Postgres RLS: enable `ROW LEVEL SECURITY` on each tenant-scoped table, create policies that filter on `current_setting('app.tenant_id')`, and `SET LOCAL app.tenant_id = $1` at the start of every transaction. The database enforces isolation even if the application forgets. This is how Notion, Linear, and several FAANG internal multi-tenant services implement isolation. The cost is a small planner overhead and the discipline of setting the tenant GUC on every request.

**Error mapping at the repository boundary.** The examples return raw `err` from `db.QueryRow`. Staff-level repositories translate driver errors to domain errors. With pgx, you type-assert to `*pgconn.PgError` and switch on `Code`: `23505` becomes `ErrAlreadyExists`, `23503` becomes `ErrForeignKeyViolation`, `40001` becomes `ErrSerializationFailure` (retryable), `57014` becomes `ErrQueryCanceled` (usually from context deadline). The calling service sees a stable domain contract, not a driver-specific error tree. This is what makes the repository swappable and the service testable.

**Observability on every query.** Every repository method emits an OpenTelemetry span with attributes `db.system=postgresql`, `db.statement` (the SQL with parameters redacted), `db.rows_affected`, and `db.connection_wait_ms`. For long-tailed latency, log the query fingerprint (normalized SQL without literals) so aggregators can group. The incident value of "which query is slow" is enormous and costs nothing to add at construction time with `otelsql` or `otelpgx`.

---
