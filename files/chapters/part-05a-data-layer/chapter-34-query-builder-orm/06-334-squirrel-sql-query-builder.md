## 34.4 squirrel: SQL Query Builder

### Basic Usage

squirrel builds SQL strings from method chains and returns the query text, argument slice, and any error via `ToSql()`. By default it uses `?` placeholders (MySQL style). Call `PlaceholderFormat(sq.Dollar)` for PostgreSQL's `$1, $2` format. Each builder is immutable, methods return a new builder, so you can safely branch from a shared base query.

```go
package main

import (
    "fmt"

    sq "github.com/Masterminds/squirrel"
)

func main() {
    // Select
    sql, args, err := sq.Select("id", "name", "email").
        From("users").
        Where(sq.Eq{"status": "active"}).
        OrderBy("created_at DESC").
        Limit(10).
        ToSql()

    fmt.Println(sql)
    // SELECT id, name, email FROM users WHERE status = ? ORDER BY created_at DESC LIMIT 10
    fmt.Println(args)
    // [active]

    // PostgreSQL placeholder
    psql := sq.StatementBuilder.PlaceholderFormat(sq.Dollar)
    sql, args, _ = psql.Select("*").
        From("users").
        Where(sq.Eq{"id": 1}).
        ToSql()
    // SELECT * FROM users WHERE id = $1
}
```

### Complex Queries

squirrel shines when building queries with optional filters. Instead of concatenating SQL fragments with `if` checks, you conditionally call `.Where` on the builder. The examples below show a dynamic search function, batch inserts using repeated `.Values` calls, updates with `SetMap`, and an upsert using a raw `Suffix` for PostgreSQL's `ON CONFLICT` clause.

```go
import (
    "database/sql"
    "time"

    sq "github.com/Masterminds/squirrel"
)

type User struct {
    ID     int64
    Name   string
    Email  string
    Status string
}

type UserFilters struct {
    Status       string
    Search       string
    CreatedAfter time.Time
    MinOrders    int
    SortBy       string
    SortDir      string
    Limit        int
    Offset       int
}

func buildUserQuery(filters UserFilters) (string, []any, error) {
    builder := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
        Select("u.*", "COUNT(o.id) as order_count").
        From("users u").
        LeftJoin("orders o ON u.id = o.user_id").
        GroupBy("u.id")

    if filters.Status != "" {
        builder = builder.Where(sq.Eq{"u.status": filters.Status})
    }

    if filters.Search != "" {
        builder = builder.Where(sq.Or{
            sq.ILike{"u.name": "%" + filters.Search + "%"},
            sq.ILike{"u.email": "%" + filters.Search + "%"},
        })
    }

    if !filters.CreatedAfter.IsZero() {
        builder = builder.Where(sq.Gt{"u.created_at": filters.CreatedAfter})
    }

    if filters.MinOrders > 0 {
        builder = builder.Having(sq.GtOrEq{"COUNT(o.id)": filters.MinOrders})
    }

    builder = builder.OrderBy(filters.SortBy + " " + filters.SortDir).
        Limit(uint64(filters.Limit)).
        Offset(uint64(filters.Offset))

    return builder.ToSql()
}

// Insert. On PostgreSQL, read the generated id back through RETURNING with
// QueryRow().Scan(). LastInsertId() is not supported by the pq/pgx drivers.
func insertUser(db *sql.DB, user User) (int64, error) {
    var id int64
    err := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
        Insert("users").
        Columns("name", "email", "status").
        Values(user.Name, user.Email, user.Status).
        Suffix("RETURNING id").
        RunWith(db).
        QueryRow().
        Scan(&id)
    if err != nil {
        return 0, err
    }

    return id, nil
}

// Batch insert
func batchInsertUsers(db *sql.DB, users []User) error {
    builder := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
        Insert("users").
        Columns("name", "email", "status")

    for _, u := range users {
        builder = builder.Values(u.Name, u.Email, u.Status)
    }

    _, err := builder.RunWith(db).Exec()
    return err
}

// Update
func updateUser(db *sql.DB, id int64, updates map[string]any) error {
    builder := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
        Update("users").
        SetMap(updates).
        Where(sq.Eq{"id": id})

    _, err := builder.RunWith(db).Exec()
    return err
}

// Upsert
func upsertUser(db *sql.DB, user User) error {
    _, err := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
        Insert("users").
        Columns("email", "name").
        Values(user.Email, user.Name).
        Suffix("ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name").
        RunWith(db).
        Exec()
    return err
}
```

### Junior → FAANG: squirrel as the Dynamic DSL Gap Filler

If you arrived here from sqlc chapters thinking "sqlc already solved everything, why learn a builder," the gap is this. sqlc is stringly-typed at authorship time and compile-time-typed at call time. That works when the WHERE clause shape is known in advance. Admin search pages, saved-filter features, multi-tenant query shaping with optional scopes, and "build me a CSV export" endpoints do not have a known shape. You either generate 2^N sqlc queries for every combination of optional filters or you build a string at runtime. squirrel is the disciplined runtime path.

First-job context. On your first sprint you will likely see a `BuildUserSearchQuery(filters UserFilters)` function that concatenates strings with `fmt.Sprintf`. That function is a bug waiting for a pentester. Learn the rule now. Parameters go through placeholders (the `?` or `$1` that squirrel emits), never through `fmt.Sprintf`. `sq.Eq{"status": userInput}` is safe because `userInput` becomes an argument in the args slice. `.Where("status = '" + userInput + "'")` is a direct SQL injection. squirrel cannot stop you if you bypass it, so the team rule is "no string interpolation of user input into any builder method."

Worked example for an interview. "Design a product search endpoint that supports optional name, category, price range, and in-stock filters, sorted by any of three columns." Your answer should be: start from a base `sq.Select(...).From("products")`, conditionally chain `.Where` for each non-zero filter, and whitelist the sort column and direction against a `map[string]bool` before passing them to `.OrderBy`. The whitelist is the non-obvious part, because `OrderBy` takes a raw identifier, not a parameter, so column names are the one place where injection re-enters. Interviewers look for that detail.

Interview entry-point questions you should be able to answer. What is the difference between `sq.Eq{}`, `sq.Expr()`, and `Where("col = ?", v)`. Why does `PlaceholderFormat` matter (driver compatibility). Why is `StatementBuilder` a value not a pointer (immutability, safe to share). When would you reach for `goqu` instead (SQL dialect features squirrel does not model, like Postgres window functions with clean syntax).

### Senior @ FAANG: Builders as the Runtime DSL Layer, Injection Boundaries, and the goqu Trade-Off

At staff level squirrel is not a library choice, it is an architectural boundary. The question you are answering for your org is "where does runtime query composition live, and how do we keep it safe as the team grows from 10 to 200 engineers." Three design rules carry the weight.

Rule one. Builders are a last resort, not a default. Every query that can be sqlc should be sqlc, because code review on a static query is trivial and code review on a dynamic builder chain requires reconstructing the query in your head. The decision tree I push on teams: if the WHERE shape is fixed, sqlc. If the shape varies across a closed set of fewer than four combinations, sqlc with a small switch. If the shape is open (admin UI, saved searches, report builder), squirrel behind a repository method that returns the built `(sql, args)` and never exposes the builder to callers. The repository owns the DSL, the service layer never sees it.

Rule two. The injection boundary is explicit and linted. squirrel has two injection surfaces. Identifier positions (table, column, ORDER BY, GROUP BY) and raw expressions (`.Where("...")` with a string literal, `.Suffix`, `.Prefix`). At Notion-scale and Shopify-scale shops, the pattern is a thin wrapper package `internal/qb` that re-exports squirrel but forbids raw strings via a custom analyzer or a `go vet` rule, forcing `.Where(sq.Eq{...})` and `.OrderByExpr(SortColumn(col), SortDir(dir))` where `SortColumn` and `SortDir` are newtypes that only accept pre-validated enum values. Without that wrapper, "just this once" string concatenation leaks into the codebase within six months.

Rule three. Masterminds/squirrel versus Doug-Martin/goqu. squirrel is minimal, dialect-agnostic, and has a tiny API surface, which is both its strength (low cognitive load, easy review) and its weakness (no first-class window functions, CTEs feel bolted on via `.Prefix`, no dialect-aware upsert). goqu models dialects as first-class (`goqu.Dialect("postgres")`), has typed expressions, supports `ON CONFLICT` natively, and handles window functions cleanly. The trade-off I articulate in ADRs: goqu for teams that write complex analytical Postgres and want the compiler to help, squirrel for teams that write 95% simple CRUD and want reviewers to read the builder chain top-to-bottom without learning a second DSL. A shop running Postgres, Redshift, and Snowflake via a shared Go codebase almost always ends up on goqu because dialect routing matters. A pure Postgres shop usually stays on squirrel.

Multi-tenant query shaping is the canonical squirrel use case and deserves its own pattern. Every query in a multi-tenant system has an implicit `WHERE tenant_id = $ctx`. You cannot rely on every engineer to remember that. The pattern is a `TenantScopedBuilder` that wraps `sq.SelectBuilder` and injects the tenant predicate in `.ToSql()`, with the raw builder unexported. Every repository takes a `context.Context`, extracts `tenantID` from it, and constructs through the scoped builder. This is the same idea as Rails' `default_scope` but compile-enforced. The failure mode you are preventing is a staff engineer in a hurry writing a cross-tenant admin query that leaks customer A's data into customer B's dashboard, which is a Sev 1 and a public incident report. The wrapper eliminates the class of bug.

Performance note that matters at scale. squirrel allocates per method call (each chain link returns a new builder value with a copied slice). For hot-path queries executed thousands of times per second, the allocations show up in pprof. The fix is not "stop using squirrel," it is "build the query once at package init, `sync.Pool` the args slice, and reuse the SQL string." Most teams do not hit this, but it is worth knowing when the flame graph shows `squirrel.(*SelectBuilder).Where` at 4% of CPU, you have a compile-once-execute-many optimization available.

Finally, tie squirrel to observability. Every repository method should wrap `.ToSql()` in a span that records the SQL template (not the args, which may contain PII) and the argument count. This lets you answer "which query shapes are hot" without touching the DB. Engineering teams running dynamic-query-heavy services describe exactly this pattern, because without it, dynamic query shops cannot correlate a slow-query log line back to the Go call site.

---
