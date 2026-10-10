## Database & Connection Pool Pitfalls

The Go standard library's `database/sql` package is concurrency-safe and manages connection pooling automatically. However, misunderstanding its connection lifecycle and statement caching leads directly to database connection exhaustion and thread deadlocks.

---

### 1. Failing to Close `sql.Rows`

#### Root Cause Mechanics
When querying a database with `db.Query()`, a connection is leased from the pool and reserved until the `Rows` object is closed. If `rows.Close()` is omitted or an error branch returns early without closing, the connection is never returned to the pool. When all connections in the pool are locked, all subsequent database queries stall indefinitely.

#### Production-Grade Solution
```go
rows, err := db.QueryContext(ctx, "SELECT id, name FROM users WHERE active = true")
if err != nil {
    return err
}
defer rows.Close() // Mandatory: releases leased connection back to the pool

for rows.Next() {
    var u User
    if err := rows.Scan(&u.ID, &u.Name); err != nil {
        return err
    }
    users = append(users, u)
}

// ALWAYS check rows.Err() to detect network interruptions during iteration
if err := rows.Err(); err != nil {
    return fmt.Errorf("error during row iteration: %w", err)
}
```

---

### 2. Transaction Leaks from Unhandled Rollbacks

#### Root Cause Mechanics
Calling `db.BeginTx()` reserves a single dedicated connection. If a panic occurs or a function returns early without calling `tx.Commit()` or `tx.Rollback()`, the transaction remains open in the database, holding table locks and leaking connections.

#### Production-Grade Solution
```go
tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
if err != nil {
    return err
}
// Idempotent safety net: tx.Rollback() does nothing if tx.Commit() was already called
defer tx.Rollback()

if err := insertOrder(ctx, tx, order); err != nil {
    return err // defer tx.Rollback() executes cleanly
}

return tx.Commit()
```
