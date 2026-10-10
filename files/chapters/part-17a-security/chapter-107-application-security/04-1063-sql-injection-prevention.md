## 107.3 SQL Injection Prevention

SQL injection remains one of the most dangerous vulnerabilities. Go's database/sql package provides excellent protection when used correctly.

### SQL Injection Attack Example

SQL injection exploits string concatenation in query construction. When user input is inserted directly into a SQL string, an attacker can terminate the intended query and inject arbitrary SQL commands. The example below shows the vulnerable pattern and the resulting attack payload.

```go
// CRITICAL VULNERABILITY: Never concatenate user input into SQL
func GetUserByEmail(email string) (*User, error) {
    // WRONG - Vulnerable to SQL injection
    query := "SELECT * FROM users WHERE email = '" + email + "'"

    // Attack: email = "'; DROP TABLE users; --"
    // Results in: SELECT * FROM users WHERE email = ''; DROP TABLE users; --'

    var user User
    err := db.QueryRow(query).Scan(&user.ID, &user.Email)
    return &user, err
}
```

### Correct SQL Injection Prevention

Go's `database/sql` package prevents SQL injection through parameterized queries. Placeholders (`$1`, `?`) separate SQL structure from user data, so the database driver handles escaping. The example below demonstrates safe query patterns for SELECT, INSERT, UPDATE, and DELETE operations.

```go
package database

import (
    "database/sql"
    "fmt"
    "strings"
    "time"
)

// User represents a database user record
type User struct {
    ID           int
    Email        string
    Name         string
    PasswordHash string
    CreatedAt    time.Time
}

// UserModel wraps database operations with security
type UserModel struct {
    DB *sql.DB
}

// GetByEmail safely retrieves user by email using parameterized queries
func (m *UserModel) GetByEmail(email string) (*User, error) {
    // RIGHT: Use parameterized queries (placeholders)
    query := `SELECT id, email, password_hash, created_at
              FROM users WHERE email = $1`

    var user User
    err := m.DB.QueryRow(query, email).Scan(
        &user.ID,
        &user.Email,
        &user.PasswordHash,
        &user.CreatedAt,
    )

    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("user not found")
    }

    return &user, err
}

// Search demonstrates safe LIKE queries
func (m *UserModel) Search(searchTerm string) ([]*User, error) {
    // WRONG: Concatenating LIKE patterns
    // query := "SELECT * FROM users WHERE name LIKE '%" + searchTerm + "%'"

    // RIGHT: Use parameterized queries even for LIKE
    query := `SELECT id, email, name FROM users WHERE name LIKE $1`

    // Escape special characters and add wildcards in Go code
    pattern := "%" + escapeLikePattern(searchTerm) + "%"

    rows, err := m.DB.Query(query, pattern)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Email, &u.Name); err != nil {
            return nil, err
        }
        users = append(users, &u)
    }

    return users, rows.Err()
}

// escapeLikePattern escapes special characters in LIKE patterns
func escapeLikePattern(s string) string {
    s = strings.ReplaceAll(s, "\\", "\\\\")
    s = strings.ReplaceAll(s, "%", "\\%")
    s = strings.ReplaceAll(s, "_", "\\_")
    return s
}

// BulkInsert demonstrates safe batch operations
func (m *UserModel) BulkInsert(users []User) error {
    tx, err := m.DB.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(`INSERT INTO users (email, name) VALUES ($1, $2)`)
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, user := range users {
        // Each execution uses parameterized query
        if _, err := stmt.Exec(user.Email, user.Name); err != nil {
            return err
        }
    }

    return tx.Commit()
}
```

### Case Study: The 12-Vulnerability Code Audit (Why SQL Injection Persists)

Many engineering teams assume SQL injection is a solved problem that only exists in legacy systems. However, as documented in real-world security audits (such as [SQL Injection Still Works in 2025: How We Found 12 Vulnerabilities in Our Own Code](https://medium.com/@author/sql-injection-still-works-in-2025-how-we-found-12-vulnerabilities-in-our-own-code) by Erwin Hermanto), code audits of modern production Go codebases frequently uncover critical injection vectors across three distinct categories:

#### Category A: Raw String Concatenation Under Deadline Pressure

In ad-hoc reporting endpoints, batch scripts, and internal admin tooling, developers under delivery pressure frequently bypass repository abstractions:

```go
// VULNERABLE: Direct string formatting bypasses driver parameterization
func GetUserActivityReport(db *sql.DB, userID string, status string) (*sql.Rows, error) {
    query := fmt.Sprintf(
        "SELECT * FROM activity_logs WHERE user_id = '%s' AND status = '%s' ORDER BY created_at DESC",
        userID, status,
    )
    return db.Query(query)
}

// SAFE: Parameterized placeholders
func GetUserActivityReportSafe(db *sql.DB, userID string, status string) (*sql.Rows, error) {
    query := `SELECT * FROM activity_logs 
              WHERE user_id = $1 AND status = $2 
              ORDER BY created_at DESC`
    return db.Query(query, userID, status)
}
```

#### Category B: The ORM False Sense of Security

Engineers often assume that using an ORM (such as GORM or ent) makes them immune to SQL injection. However, ORMs only parameterize values when methods are invoked with placeholder syntax:

```go
// VULNERABLE: GORM with concatenated raw string in .Where()
func SearchProducts(db *gorm.DB, keyword string) ([]Product, error) {
    var products []Product
    // The entire string is passed verbatim to the SQL engine
    result := db.Where("name LIKE '%" + keyword + "%'").Find(&products)
    return products, result.Error
}

// SAFE: GORM parameterized placeholder
func SearchProductsSafe(db *gorm.DB, keyword string) ([]Product, error) {
    var products []Product
    result := db.Where("name LIKE ?", "%"+keyword+"%").Find(&products)
    return products, result.Error
}
```

**The Dynamic Identifier Gotcha (`ORDER BY` & Column Names)**:
SQL database protocols do not allow placeholders (`?`, `$1`) for SQL identifiers (table names, column names, sort directions). If an API accepts dynamic sort columns from query parameters, using `fmt.Sprintf` directly allows blind SQL injection. The only secure pattern is strict allowlist validation:

```go
// Safe dynamic ordering using an explicit allowlist map
var allowedSortColumns = map[string]bool{
    "created_at":   true,
    "updated_at":   true,
    "total_amount": true,
}

var allowedSortDirections = map[string]bool{
    "ASC":  true,
    "DESC": true,
}

func ListOrders(db *sql.DB, sortCol, sortDir string) (*sql.Rows, error) {
    // Validate against allowlist, falling back to safe defaults
    if !allowedSortColumns[sortCol] {
        sortCol = "created_at"
    }
    dirUpper := strings.ToUpper(sortDir)
    if !allowedSortDirections[dirUpper] {
        dirUpper = "DESC"
    }

    // Safe to interpolate only because sortCol and dirUpper are guaranteed allowlisted values
    query := fmt.Sprintf("SELECT id, total_amount, created_at FROM orders ORDER BY %s %s", sortCol, dirUpper)
    return db.Query(query)
}
```

#### Category C: Second-Order SQL Injection

Second-order injection occurs when input is safely parameterized and stored in the database at write time, but later retrieved by an asynchronous worker, report generator, or migration script and unsafely interpolated into a dynamic query under the assumption that "data from our own database is trusted."

```
Attack Vector (Second-Order SQL Injection):
Attacker registers endpoint URL: https://attacker.com/webhook' OR '1'='1
  │
  ├── Step 1 (Write Path): db.Exec("INSERT ... VALUES ($1)", payload) ──► Stored safely in DB
  │
  └── Step 2 (Read Path months later):
        db.QueryRow("SELECT url FROM webhooks ...").Scan(&url)
        db.Query("SELECT * FROM logs WHERE target = '" + url + "'") ──► INJECTION TRIGGERED!
```

**The Zero-Trust Data Principle**: Never treat database rows as trusted input. All values retrieved from persistent storage must be parameterized if passed into subsequent database queries.

### Junior → FAANG: SQL Injection Is Still the Most Common Critical Finding

SQL injection is decades old and still the top finding in most external pen tests. Juniors who write string-concatenated queries in Go are making the same mistake developers made in 2003.

**Gap to close:** Understand exactly what `database/sql` does when you use `?` placeholders. The driver sends the query and the parameters separately to the database server. The server treats the parameter as data, never as SQL syntax. That physical separation is the protection. When you concatenate a string into the query, you remove that separation and the protection disappears.

**First-job habit:** Never write `fmt.Sprintf` inside a SQL string. Configure a linter rule (or use `gosec`) that flags string formatting in SQL contexts. If a colleague's PR contains a formatted SQL string, block it. This is not pedantry: it is the correct bar.

**Worked example:** A common junior mistake is using parameterized queries for `WHERE` clauses but string formatting for `ORDER BY` column names, because placeholders do not work for identifiers. The correct fix is a whitelist: validate the column name against a known-good list before interpolating it. Never interpolate user input into an identifier position even if it passes other validation.

**Interview framing:** When asked about SQL injection, describe the two-layer defense: parameterized queries for all values, whitelist validation for any identifier (table name, column name, sort direction) that must be dynamic. Mentioning the identifier-position edge case shows depth that most candidates miss.

### Senior @ FAANG: Eliminating SQL Injection by Architecture

At senior level, the goal is not to write correct parameterized queries yourself. It is to make it impossible for anyone on the team to write an injection-vulnerable query by accident.

**Architectural controls:** Adopt a query builder or ORM that never exposes raw string interpolation in the default path. `sqlx` with named parameters, `pgx` with positional parameters, or `ent` as a type-safe ORM all make parameterized queries the path of least resistance. Evaluate these tools in an ADR that explicitly covers SQL injection surface area.

**SAST integration:** `gosec` rule G201 (SQL query construction using format string) and G202 (SQL query construction using string concatenation) should be mandatory CI gates with zero tolerance. A finding in these categories is an automatic PR block, not a warning. Document this policy in your team's engineering standards.

**Repository pattern security benefit:** The repository pattern has a security benefit beyond testability: all data access code is in one place. A security audit of the repository layer gives complete coverage of all database interactions. When data access is scattered across handlers, services, and utility functions, a complete audit is nearly impossible. This is an argument for the repository pattern that most architecture discussions miss.

**Multi-tenancy injection risk:** In multi-tenant SaaS systems, injection attacks can break tenant isolation: a malicious query might access another tenant's data by escaping the tenant ID filter. When building multi-tenant queries, the tenant ID filter must be applied at the repository layer, not passed down as a parameter that callers can omit. Use a context-propagated tenant ID and assert it in the repository layer so no query can accidentally run without a tenant scope.

**Incident response preparation:** Have a runbook for SQL injection incidents. It should cover: how to identify affected queries in logs (parameterized queries log the template without values, injection attempts may appear as unusual query structures), how to rotate database credentials, how to assess data exfiltration scope using query logs, and when to invoke your breach notification process. Having this runbook before an incident is a staff-level responsibility.

---
