## ORM Pitfalls: When Abstraction Becomes Obstruction

### The GORM Preload Avalanche

**The Incident**: A blog platform used GORM with `Preload()` to fetch posts with comments, nested down to comment authors: `Preload("Comments").Preload("Comments.Author").Preload("Author")`. Performance was fine with 10 posts, each with 5 comments. In production with 100 posts averaging 200 comments each, the API call took 45 seconds. The team assumed `Preload` was free. In reality each `Preload` runs one extra query per association level (batched with `WHERE ... IN`, not N+1), but here the unbounded nested preloads pulled roughly 20,000 comment rows plus all their authors into memory on every request, with no `LIMIT` anywhere. The cost was not a swarm of queries, it was a handful of unbounded result sets materialized in Go.

```go
// WRONG: unbounded nested preloads materialize huge result sets
func getPostsWithComments(db *gorm.DB) ([]Post, error) {
    var posts []Post
    err := db.Preload("Comments").      // One batched query (comments WHERE post_id IN ...)
           Preload("Comments.Author").  // Another batched query (authors WHERE id IN ...)
           Preload("Author").
           Find(&posts).Error
    // 1 query for posts
    // 1 query for all comments (WHERE post_id IN ...)
    // 1 query for all comment authors (WHERE id IN ...)
    // 1 query for all post authors (WHERE id IN ...)
    // Few queries, but each unbounded: ~20k comment rows pulled into memory
    return posts, err
}

// CORRECT: Use explicit JOINs for eager loading
func getPostsWithComments(db *gorm.DB) ([]Post, error) {
    var posts []Post
    err := db.
        Joins("Author").                    // JOIN, not separate query
        Preload("Comments", func(db *gorm.DB) *gorm.DB {
            return db.Joins("Author").Limit(100) // Bounded preload with JOIN
        }).
        Find(&posts).Error
    return posts, err
}

// Even better: Raw query for complex cases
func getPostsWithCommentCounts(db *gorm.DB) ([]PostWithCount, error) {
    var results []PostWithCount
    err := db.Raw(`
        SELECT p.*, u.name as author_name, COUNT(c.id) as comment_count
        FROM posts p
        JOIN users u ON p.author_id = u.id
        LEFT JOIN comments c ON c.post_id = p.id
        GROUP BY p.id, u.name
        ORDER BY p.created_at DESC
        LIMIT 100
    `).Scan(&results).Error
    return results, err
}

// Or use subquery preloading (GORM v2)
func getPostsOptimized(db *gorm.DB) ([]Post, error) {
    var posts []Post
    // Batch preload with single query using IN
    err := db.Preload("Comments", func(db *gorm.DB) *gorm.DB {
        return db.Where("created_at > ?", time.Now().AddDate(0, 0, -7)).
                  Order("created_at DESC").
                  Limit(10) // Only recent comments
    }).Find(&posts).Error
    return posts, err
}
```

### The Transaction Autocommit Trap

**The Incident**: A payment service used GORM transactions. The code called `db.Transaction(...)` and thought everything inside was atomic. But a separate goroutine was spawned to send a notification using the same db handle. That goroutine's query ran outside the transaction, saw uncommitted data, and sent a "payment complete" email before the transaction committed. When the transaction rolled back due to a later error, the customer had already received confirmation of a failed payment.

```go
// WRONG: Spawning goroutine with db handle during transaction
func processPayment(db *gorm.DB, payment Payment) error {
    return db.Transaction(func(tx *gorm.DB) error {
        if err := tx.Create(&payment).Error; err != nil {
            return err
        }

        // Update balance
        if err := tx.Model(&Account{}).
            Where("id = ?", payment.AccountID).
            Update("balance_cents", gorm.Expr("balance_cents - ?", payment.AmountCents)).Error; err != nil {
            return err
        }

        // BUG: Using db instead of tx, reads uncommitted data!
        go sendPaymentNotification(db, payment.ID)

        // Later error causes rollback...
        if err := validatePayment(tx, payment); err != nil {
            return err // Rollback! But notification already sent!
        }

        return nil
    })
}

// CORRECT: Send notifications after successful commit
func processPayment(db *gorm.DB, payment Payment) error {
    err := db.Transaction(func(tx *gorm.DB) error {
        if err := tx.Create(&payment).Error; err != nil {
            return err
        }

        if err := tx.Model(&Account{}).
            Where("id = ?", payment.AccountID).
            Update("balance_cents", gorm.Expr("balance_cents - ?", payment.AmountCents)).Error; err != nil {
            return err
        }

        if err := validatePayment(tx, payment); err != nil {
            return err
        }

        return nil
    })

    // Only send notification after successful commit
    if err == nil {
        go sendPaymentNotification(db, payment.ID)
    }

    return err
}

// Even better: Use outbox pattern for reliable notifications
func processPaymentWithOutbox(db *gorm.DB, payment Payment) error {
    return db.Transaction(func(tx *gorm.DB) error {
        if err := tx.Create(&payment).Error; err != nil {
            return err
        }

        // Queue notification in same transaction
        notification := Outbox{
            AggregateType: "payment",
            AggregateID:   payment.ID,
            EventType:     "payment.completed",
            Payload:       mustJSON(payment),
        }
        if err := tx.Create(&notification).Error; err != nil {
            return err
        }

        return nil
    })
    // Separate worker processes outbox after commit
}
```

### The Soft Delete Time Bomb

**The Incident**: An HR system used GORM's soft delete feature (`gorm.Model` includes `DeletedAt`). Everything worked until a compliance audit. The auditors found that "deleted" employee records were still in the database and queryable with `Unscoped()`. Worse, a junior developer had added a raw SQL report that didn't know about soft deletes, exposing "deleted" salary data. The company faced GDPR violations because soft delete isn't actual deletion.

```go
// The hidden problem: soft deletes keep data forever
type Employee struct {
    gorm.Model        // Includes DeletedAt for soft delete
    Name        string
    SalaryCents int64
    SSN         string  // PII that GDPR requires actual deletion
}

// "Delete" doesn't actually delete
func deleteEmployee(db *gorm.DB, id uint) error {
    return db.Delete(&Employee{}, id).Error // Sets DeletedAt, data remains!
}

// Raw SQL bypasses soft delete
func getSalaryReport(db *gorm.DB) ([]SalaryRow, error) {
    var results []SalaryRow
    // This returns ALL employees including "deleted" ones!
    err := db.Raw("SELECT name, salary_cents FROM employees").Scan(&results).Error
    return results, err
}

// CORRECT: Explicit soft delete handling and data lifecycle
type Employee struct {
    ID        uint `gorm:"primarykey"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`

    // Non-PII fields
    Name       string
    Department string

    // PII in separate table with hard delete
    PersonalInfo *EmployeePersonalInfo `gorm:"foreignKey:EmployeeID"`
}

type EmployeePersonalInfo struct {
    EmployeeID  uint `gorm:"primarykey"`
    SSN         string
    SalaryCents int64
}

// Proper deletion: hard delete PII, soft delete employee
func deleteEmployeeGDPRCompliant(db *gorm.DB, id uint) error {
    return db.Transaction(func(tx *gorm.DB) error {
        // Hard delete PII
        if err := tx.Unscoped().
            Where("employee_id = ?", id).
            Delete(&EmployeePersonalInfo{}).Error; err != nil {
            return err
        }

        // Soft delete employee record (for audit trail)
        if err := tx.Delete(&Employee{}, id).Error; err != nil {
            return err
        }

        return nil
    })
}

// Force all queries through ORM to respect soft deletes
func getSalaryReport(db *gorm.DB) ([]SalaryRow, error) {
    var results []SalaryRow
    err := db.Model(&Employee{}).
        Select("employees.name, employee_personal_infos.salary_cents").
        Joins("JOIN employee_personal_infos ON employees.id = employee_personal_infos.employee_id").
        Scan(&results).Error
    // Automatically excludes soft-deleted records
    return results, err
}
```

### The sqlc Type Generation Gotcha

**The Incident**: A team used sqlc for type-safe queries. They defined a query that could return NULL for a column. sqlc generated a `sql.NullString` type. The API handler directly JSON-marshaled the result. The JSON output had `{"Valid": true, "String": "value"}` instead of just `"value"`. Every API response was malformed, and mobile clients crashed parsing the unexpected structure.

```go
// sqlc generated code (from query with nullable column)
type GetUserRow struct {
    ID    int64
    Name  string
    Phone sql.NullString  // Nullable in DB
}

// WRONG: Direct JSON marshaling of sqlc types
func getUserHandler(w http.ResponseWriter, r *http.Request) {
    user, _ := queries.GetUser(ctx, id)
    json.NewEncoder(w).Encode(user)
    // Output: {"ID":1,"Name":"John","Phone":{"String":"555-1234","Valid":true}}
    // Expected: {"id":1,"name":"John","phone":"555-1234"}
}

// CORRECT: Map to API types
type UserResponse struct {
    ID    int64   `json:"id"`
    Name  string  `json:"name"`
    Phone *string `json:"phone,omitempty"`
}

func toUserResponse(u GetUserRow) UserResponse {
    resp := UserResponse{
        ID:   u.ID,
        Name: u.Name,
    }
    if u.Phone.Valid {
        resp.Phone = &u.Phone.String
    }
    return resp
}

func getUserHandler(w http.ResponseWriter, r *http.Request) {
    user, _ := queries.GetUser(ctx, id)
    json.NewEncoder(w).Encode(toUserResponse(user))
    // Output: {"id":1,"name":"John","phone":"555-1234"}
}

// Or configure sqlc to use pointers (sqlc.yaml)
/*
version: "2"
sql:
  - engine: "postgresql"
    queries: "query.sql"
    schema: "schema.sql"
    gen:
      go:
        package: "db"
        out: "internal/db"
        emit_pointers_for_null_types: true  # Use *string instead of sql.NullString
*/
```

### The Query Builder SQL Injection Revival

**The Incident**: A search API used squirrel query builder for dynamic filters. A developer used string concatenation to add a user-controlled column name to ORDER BY. Security review missed it because "we use a query builder, not raw SQL." An attacker injected `id. DROP TABLE users. --` as the sort column. The query builder faithfully included it in the query. The users table was dropped in production.

```go
// WRONG: String concatenation with query builder
func searchUsers(db *sql.DB, filter Filter) ([]User, error) {
    query := sq.Select("*").From("users")

    if filter.Name != "" {
        query = query.Where("name LIKE ?", "%"+filter.Name+"%")
    }

    // SQL INJECTION: column name from user input!
    if filter.SortBy != "" {
        query = query.OrderBy(filter.SortBy + " " + filter.SortDir)
        // User input: "id; DROP TABLE users; --"
    }

    sql, args, _ := query.ToSql()
    return db.Query(sql, args...)
}

// CORRECT: Whitelist all dynamic identifiers
var allowedSortColumns = map[string]bool{
    "id":         true,
    "name":       true,
    "email":      true,
    "created_at": true,
}

var allowedSortDirs = map[string]string{
    "asc":  "ASC",
    "desc": "DESC",
    "":     "ASC", // default
}

func searchUsers(db *sql.DB, filter Filter) ([]User, error) {
    query := sq.Select("*").From("users")

    if filter.Name != "" {
        query = query.Where("name LIKE ?", "%"+filter.Name+"%")
    }

    // Validate sort column against whitelist
    sortCol := "created_at" // default
    if filter.SortBy != "" {
        if !allowedSortColumns[filter.SortBy] {
            return nil, fmt.Errorf("invalid sort column: %s", filter.SortBy)
        }
        sortCol = filter.SortBy
    }

    // Validate sort direction
    sortDir, ok := allowedSortDirs[strings.ToLower(filter.SortDir)]
    if !ok {
        return nil, fmt.Errorf("invalid sort direction: %s", filter.SortDir)
    }

    query = query.OrderBy(sortCol + " " + sortDir)

    sql, args, _ := query.ToSql()
    return db.Query(sql, args...)
}

// Even safer: Use enum types for API input
type SortColumn string
const (
    SortByID        SortColumn = "id"
    SortByName      SortColumn = "name"
    SortByCreatedAt SortColumn = "created_at"
)

type SortDirection string
const (
    SortAsc  SortDirection = "ASC"
    SortDesc SortDirection = "DESC"
)

type Filter struct {
    Name    string
    SortBy  SortColumn    `json:"sort_by" validate:"omitempty,oneof=id name created_at"`
    SortDir SortDirection `json:"sort_dir" validate:"omitempty,oneof=ASC DESC"`
}
```

### Quick Reference: ORM/Query Builder Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Unbounded nested preload | Slow queries, memory blowup | Bound with Limit, use JOINs |
| Transaction scope | Data inconsistency | Keep all ops in tx, notify after commit |
| Soft delete leaks | PII exposure, compliance issues | Hard delete PII, audit soft deletes |
| Type marshaling | Malformed JSON | Map to API-specific types |
| Dynamic columns | SQL injection | Whitelist identifiers |
| Global DB variable | Connection leaks | Pass db explicitly, use context |
| Missing indexes | Full table scans | Add indexes for WHERE clauses |
| Eager loading depth | Memory explosion | Limit depth, paginate |

### Junior -> FAANG: Reading Incident Reports and Pattern Matching Your Own Code

Incident reports are the fastest way to level up a junior engineer. Each of the five pitfalls above is a real class of outage that costs money, customer trust, or regulatory standing. Read them as patterns, not anecdotes. The questions to ask yourself after each one are fixed: what was the surface signal, what was the root cause, what was the proximate fix, what was the systemic fix, and what lint or test would have caught it.

Worked example: apply the pattern to the Preload Avalanche. Surface signal, a 45-second API response. Root cause, unbounded nested `Preload` pulls a huge result set into memory (one batched query per association level, but every row materialized), not a swarm of per-parent queries. Proximate fix, bound the preload with `Limit` or switch to a single JOIN with a flat DTO. Systemic fix, a query-count assertion in the integration test for the endpoint. Lint or test, a middleware in the test harness that counts queries per request and fails if any endpoint exceeds its declared budget. At L3 the goal is to reach the proximate fix. At L4 the goal is to reach the systemic fix.

Worked example: apply the pattern to the Transaction Autocommit Trap. Surface signal, customers receiving "payment succeeded" emails for payments that never cleared. Root cause, a goroutine launched inside the transaction used the outer `*gorm.DB` handle, not `tx`, and executed outside the transactional scope. Proximate fix, move the goroutine launch to after the `db.Transaction` call returns nil. Systemic fix, an outbox row written inside the transaction with a separate poller that publishes events. Lint or test, a review checklist item banning goroutine launches inside a `db.Transaction` callback and a `go vet` shim that flags `go fn(db, ...)` inside `Transaction(func(tx *gorm.DB)`.

First-job context. When your team has an incident, read the postmortem end to end, and if there is no postmortem, ask if you can write one. Postmortems written by L3 engineers are the single single most useful thing you can do for your promotion case, because they force you to articulate the surface-to-systemic chain, and they are visible to managers across teams. Do not write them to assign blame. Write them to enumerate the systemic fixes the org should fund.

The "why did this fail?" reflex for each pitfall. Preload Avalanche: check the query log before profiling anywhere else. Transaction Autocommit: search for `go ` inside `Transaction(` blocks. Soft Delete Time Bomb: grep for `Unscoped` and for raw SQL that references tables with `gorm.Model`. sqlc Type Generation: look at the JSON body on the wire, not the Go struct. Query Builder Injection: grep for string concatenation with `OrderBy`, `GroupBy`, `Select`, and dynamic table names. Each reflex takes thirty seconds and rules out the most common root cause first.

### Senior @ FAANG: Incident Reports, Maturity Models, and Governance of ORM Risk

At staff and principal level, the pitfalls above are not bugs to fix in your own code. They are risk categories to govern across a portfolio of services owned by teams you do not manage. The tools are incident reports, maturity models, and architectural guardrails.

Incident report 1: Soft-delete leaked PII. Real shape of the incident at a hypothetical 100-engineer shop. HR service uses GORM with `gorm.Model`. An analyst writes a raw SQL report against the read replica for a board deck. The report does not filter on `deleted_at IS NULL` because the analyst does not know the column exists. Three weeks later a former employee files a GDPR erasure request, legal checks the database, finds the former employee's salary in the report's cached output, and the company writes a regulatory disclosure. Systemic fix at L6: PII fields move to a separate table with hard delete, soft delete is reserved for audit-relevant non-PII metadata, and the schema linter rejects any column tagged `@pii` in a table that also has a `deleted_at` column. Cost to implement, roughly two engineer-months across the platform team. Cost avoided, a GDPR fine with a ceiling of 4% of global revenue.

Incident report 2: Eager-load OOMed the replica. Real shape: an internal reporting endpoint uses `Preload("Orders").Preload("Orders.Items").Preload("Orders.Items.Product")` across a customer list. In staging the customer list is 50 rows. In production the customer list is 800000 rows because a caller paginated by passing `limit=1000000` hoping to get "all." The replica materializes 40GB of `sql.Rows`, the Go process OOMs, the pod restarts, the load balancer retries, the replica OOMs again. Systemic fix at L6: a repository guardrail that refuses to execute a query with no `LIMIT` and more than two `Preload` levels, enforced in the base repository class. At L7: a query-cost estimator that consults `pg_stats` at request time and rejects queries whose estimated memory footprint exceeds a per-pod budget.

Incident report 3: Hook side effects in prod. Real shape: `AfterUpdate` hook on `User` publishes a Kafka event. A batch reconciliation job runs `UPDATE users SET email_verified = true WHERE ...` using `tx.Exec` directly, bypassing GORM, so no hook fires, so the audit log diverges from the database. Three months later an auditor finds the divergence and the company cannot produce a defensible audit trail for a regulatory inquiry. Systemic fix at L6: all mutation-triggered side effects move out of hooks and into outbox rows written in the same transaction, consumed by a separate publisher. Hooks are banned by lint. At L7: the outbox pattern is shipped as a shared library with exactly-once semantics via idempotency keys.

Maturity model for the data access layer, L1 to L5.

L1: Hand-rolled raw SQL scattered across handlers. No connection pool tuning. No migrations tool. `db` is a package-level global. Team learns transactions by breaking prod. Typical at a pre-seed startup or an early internal tool. Not sustainable beyond five engineers.

L2: A single ORM or query builder chosen by the first senior hire. Migrations via a CLI tool. Repository layer exists but leaks ORM types. Context propagated inconsistently. Some services still use raw SQL. Typical at a 20 to 50 engineer company. Works until the first big incident, usually an N+1 or a missing transaction.

L3: Repository interfaces that do not leak persistence types. Expand-contract migrations enforced by code review. `contextcheck` in CI. A shared `txutil.Run` helper. Integration tests use query-count assertions on the critical paths. Typical at a 100 engineer company with a dedicated platform team starting to form. The data layer is no longer a daily source of incidents.

L4: Golden-path codegen. sqlc or ent generates repository code from schema plus query files. A schema linter enforces PII tagging, nullability conventions, and index requirements. N+1 detection in CI via static analysis over generated code. A shared outbox library. Feature teams no longer write raw SQL for new features. Typical at a 300 to 1000 engineer company with a platform team of five to ten.

L5: A platform team owns the golden path end to end. Schema changes flow through an internal review tool that checks compatibility with every consumer service. Query plans are captured at PR time and compared to production baselines, regressions block merge. Multi-tenancy, sharding, and cross-region replication are abstracted behind a typed DSL that feature teams never see the SQL of. Tenant isolation enforced by row-level security with automatic audit. Typical at a FAANG with thousands of engineers. The data layer is a product, not a shared resource.

Governance ADR for ORM risk. The written decision at the org level covers five dimensions. First, tool choice: one primary ORM or codegen for the monorepo, one escape hatch for hotspot optimization, anything else requires architecture review. Second, hook policy: bounded whitelist, all others banned, enforced by lint. Third, transaction boundary: opened at service layer, never spans network calls to non-database services, retries centralized. Fourth, soft-delete policy: banned on PII tables, allowed on audit tables, enforced by schema lint. Fifth, migration policy: expand-contract mandatory, advisory locks mandatory, no schema changes at app startup.

Interview and promotion signal. An L5 engineer writes correct code against this policy. An L6 writes one of these policies for their service. An L7 writes the policy that binds the 100 teams, negotiates acceptance with skeptical staff engineers in each team, and ships the tooling that makes compliance the path of least resistance. The measure is not the document, it is whether the incident rate for the governed risk category drops and stays dropped.

---
