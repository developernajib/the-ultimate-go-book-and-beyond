## 8. Database Optimization

Database calls are often the bottleneck in web applications.

### 8.1 Query Optimization

**Efficient Queries**:

```go
package main

import (
    "database/sql"
    "context"
)

// Bad: N+1 queries
func getUsersWithOrdersBad(db *sql.DB) ([]User, error) {
    // Query users
    rows, err := db.Query("SELECT id, name FROM users")
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name); err != nil {
            return nil, err
        }

        // N queries for orders (BAD!)
        orderRows, err := db.Query(
            "SELECT id, total FROM orders WHERE user_id = $1", u.ID)
        if err != nil {
            return nil, err
        }

        for orderRows.Next() {
            var o Order
            if err := orderRows.Scan(&o.ID, &o.Total); err != nil {
                orderRows.Close()
                return nil, err
            }
            u.Orders = append(u.Orders, o)
        }
        orderRows.Close()

        users = append(users, u)
    }

    return users, rows.Err()
}

// Good: Single JOIN query
func getUsersWithOrdersGood(db *sql.DB) ([]User, error) {
    query := `
        SELECT
            u.id, u.name,
            o.id, o.total
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
        ORDER BY u.id
    `

    rows, err := db.Query(query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    userMap := make(map[int64]*User)
    var users []User

    for rows.Next() {
        var (
            userID   int64
            userName string
            orderID  sql.NullInt64
            total    sql.NullFloat64
        )

        if err := rows.Scan(&userID, &userName, &orderID, &total); err != nil {
            return nil, err
        }

        user, exists := userMap[userID]
        if !exists {
            user = &User{
                ID:     userID,
                Name:   userName,
                Orders: make([]Order, 0),
            }
            userMap[userID] = user
            users = append(users, *user)
        }

        if orderID.Valid {
            user.Orders = append(user.Orders, Order{
                ID:    orderID.Int64,
                Total: total.Float64,
            })
        }
    }

    return users, rows.Err()
}

// Best: Separate queries with IN clause
func getUsersWithOrdersBest(db *sql.DB) ([]User, error) {
    // Get users
    users, err := getUsers(db)
    if err != nil {
        return nil, err
    }

    if len(users) == 0 {
        return users, nil
    }

    // Get all user IDs
    userIDs := make([]int64, len(users))
    userMap := make(map[int64]*User)
    for i, u := range users {
        userIDs[i] = u.ID
        users[i].Orders = make([]Order, 0)
        userMap[u.ID] = &users[i]
    }

    // Get all orders in one query
    query, args, err := sqlx.In(
        "SELECT user_id, id, total FROM orders WHERE user_id IN (?)",
        userIDs,
    )
    if err != nil {
        return nil, err
    }

    rows, err := db.Query(query, args...)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        var userID int64
        var o Order
        if err := rows.Scan(&userID, &o.ID, &o.Total); err != nil {
            return nil, err
        }

        if user, ok := userMap[userID]; ok {
            user.Orders = append(user.Orders, o)
        }
    }

    return users, rows.Err()
}
```

### 8.2 Connection Pool Tuning

**Optimal Pool Configuration**:

```go
package main

import (
    "database/sql"
    "time"
)

func configureDBPool(db *sql.DB) {
    // Maximum open connections
    // Rule of thumb: (available_cores * 2) + effective_spindle_count
    // For web apps: start with 25-50
    db.SetMaxOpenConns(25)

    // Maximum idle connections
    // Should be close to MaxOpenConns for best performance
    db.SetMaxIdleConns(25)

    // Connection lifetime
    // Should be less than database server timeout
    // MySQL default: 8 hours
    // PostgreSQL default: unlimited
    db.SetConnMaxLifetime(5 * time.Minute)

    // Idle connection lifetime (Go 1.15+)
    // Close idle connections sooner
    db.SetConnMaxIdleTime(1 * time.Minute)
}

// Monitor connection pool
func monitorPool(db *sql.DB) {
    stats := db.Stats()

    log.Printf("Open connections: %d", stats.OpenConnections)
    log.Printf("In use: %d", stats.InUse)
    log.Printf("Idle: %d", stats.Idle)
    log.Printf("Wait count: %d", stats.WaitCount)
    log.Printf("Wait duration: %s", stats.WaitDuration)
    log.Printf("Max idle closed: %d", stats.MaxIdleClosed)
    log.Printf("Max lifetime closed: %d", stats.MaxLifetimeClosed)

    // Alert if wait count is increasing
    if stats.WaitCount > 1000 {
        log.Printf("WARNING: High wait count, consider increasing pool size")
    }
}

// Connection pool for different workloads
func configureForOLTP(db *sql.DB) {
    // Online Transaction Processing
    // Many short queries
    db.SetMaxOpenConns(50)
    db.SetMaxIdleConns(50)
    db.SetConnMaxLifetime(5 * time.Minute)
}

func configureForOLAP(db *sql.DB) {
    // Online Analytical Processing
    // Few long-running queries
    db.SetMaxOpenConns(10)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(30 * time.Minute)
}
```

### 8.3 Prepared Statements

**Prepared Statement Benefits**:

```go
package main

import (
    "database/sql"
    "context"
)

// Bad: Repeated query parsing
func insertUsersBad(db *sql.DB, users []User) error {
    for _, u := range users {
        // Query is parsed every iteration
        _, err := db.Exec(
            "INSERT INTO users (name, email) VALUES ($1, $2)",
            u.Name, u.Email,
        )
        if err != nil {
            return err
        }
    }
    return nil
}

// Good: Prepared statement
func insertUsersGood(db *sql.DB, users []User) error {
    // Prepare once
    stmt, err := db.Prepare(
        "INSERT INTO users (name, email) VALUES ($1, $2)")
    if err != nil {
        return err
    }
    defer stmt.Close()

    // Execute many times
    for _, u := range users {
        if _, err := stmt.Exec(u.Name, u.Email); err != nil {
            return err
        }
    }

    return nil
}

// Best: Transaction + prepared statement
func insertUsersBest(db *sql.DB, users []User) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(
        "INSERT INTO users (name, email) VALUES ($1, $2)")
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, u := range users {
        if _, err := stmt.Exec(u.Name, u.Email); err != nil {
            return err
        }
    }

    return tx.Commit()
}

// Context-aware prepared statements
func insertUsersWithContext(
    ctx context.Context,
    db *sql.DB,
    users []User,
) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.PrepareContext(ctx,
        "INSERT INTO users (name, email) VALUES ($1, $2)")
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, u := range users {
        // Check context cancellation
        if ctx.Err() != nil {
            return ctx.Err()
        }

        if _, err := stmt.ExecContext(ctx, u.Name, u.Email); err != nil {
            return err
        }
    }

    return tx.Commit()
}
```

### 8.4 Batch Inserts

**Efficient Batch Inserts**:

```go
package main

import (
    "database/sql"
    "fmt"
    "strings"
)

// Single batch insert
func batchInsert(db *sql.DB, users []User) error {
    if len(users) == 0 {
        return nil
    }

    // Build query
    placeholders := make([]string, len(users))
    values := make([]any, 0, len(users)*2)

    for i, u := range users {
        placeholders[i] = fmt.Sprintf("($%d, $%d)", i*2+1, i*2+2)
        values = append(values, u.Name, u.Email)
    }

    query := fmt.Sprintf(
        "INSERT INTO users (name, email) VALUES %s",
        strings.Join(placeholders, ", "),
    )

    _, err := db.Exec(query, values...)
    return err
}

// Chunked batch inserts (for very large datasets)
func batchInsertChunked(db *sql.DB, users []User, chunkSize int) error {
    for i := 0; i < len(users); i += chunkSize {
        end := i + chunkSize
        if end > len(users) {
            end = len(users)
        }

        if err := batchInsert(db, users[i:end]); err != nil {
            return err
        }
    }

    return nil
}

// PostgreSQL COPY (fastest)
func copyInsert(db *sql.DB, users []User) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(pq.CopyIn("users", "name", "email"))
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, u := range users {
        if _, err := stmt.Exec(u.Name, u.Email); err != nil {
            return err
        }
    }

    if _, err := stmt.Exec(); err != nil {
        return err
    }

    return tx.Commit()
}

// Performance comparison (10,000 rows):
// Individual inserts: ~5.0s
// Batch insert (1000/batch): ~0.5s (10x faster)
// COPY: ~0.1s (50x faster)
```

---
