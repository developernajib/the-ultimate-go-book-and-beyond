## 34.1 sqlc: Type-Safe SQL

### Why sqlc?

By April 2026, sqlc has become the default recommendation for new Go services talking to PostgreSQL. It is not an ORM. You write the SQL you would have written anyway in a `.sql` file, annotate each statement with a `-- name:` comment, and run `sqlc generate`. The output is plain Go: a `Queries` struct with one method per SQL statement, each method taking a typed parameter struct and returning a typed row struct (or slice). Nothing reflects at runtime, nothing is hidden, and renaming a column in your schema turns into a compile error at the call site the moment you regenerate.

Concretely:

- **Type-safe Go from plain SQL.** Parameters become method arguments, result columns become struct fields, types come from the PostgreSQL schema.
- **Zero runtime reflection.** The generated `Scan` calls use positional arguments matching the SELECT list. Performance is equal to hand-written `pgx` code.
- **Full SQL power.** CTEs, window functions, `RETURNING`, `ON CONFLICT`, lateral joins, `COPY FROM` bulk loads, JSONB operators - anything PostgreSQL accepts, sqlc accepts.
- **First-class `pgx/v5` integration.** Set `sql_package: "pgx/v5"` and the generated code uses `pgxpool.Pool`, `pgx.Batch`, and `pgx.Rows` directly, so you stay on a single connection library across your entire stack.
- **Schema refactors become compile errors.** Drop a column used by a query and `sqlc generate` either refuses to generate or the generated code fails to build - the error surfaces at CI time, not 3 a.m. when the affected endpoint runs in production.
- **Loose coupling with hand-written pgx.** You can mix `qtx := queries.WithTx(tx)` calls with direct `tx.Exec(ctx, ...)` inside the same transaction, which makes incremental adoption painless.

### Setup

sqlc reads a YAML configuration file that tells it where to find your SQL schema and query files, which database engine to target, and how to generate the Go output. The `sql_package` field selects the underlying driver (`pgx/v5` for PostgreSQL), and flags like `emit_prepared_queries` and `emit_interface` control whether the generated code includes prepared statement support and an interface for mocking.

```yaml
# sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "db/queries/"
    schema: "db/schema/"
    gen:
      go:
        package: "db"
        out: "internal/db"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_prepared_queries: true
        emit_interface: true
```

### Schema and Queries

You define your database schema in plain SQL files and annotate each query with a special comment that tells sqlc the query name and return type. The `:one` annotation generates a function returning a single struct, `:many` returns a slice, and `:exec` returns only an error. sqlc infers Go types from the PostgreSQL column types in the schema, so parameter and return types are generated automatically.

```sql
-- db/schema/001_users.sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- db/queries/users.sql

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: ListUsers :many
SELECT * FROM users
WHERE status = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: CreateUser :one
INSERT INTO users (name, email, status)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateUser :exec
UPDATE users
SET name = $2, email = $3
WHERE id = $1;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = $1;

-- name: CountUsersByStatus :one
SELECT COUNT(*) FROM users WHERE status = $1;
```

### Generated Code Usage

After running `sqlc generate`, you get a `Queries` struct with typed methods for each annotated SQL query. You instantiate it by passing a `*pgxpool.Pool` (or any `DBTX` interface), and every method returns Go structs whose fields match the query's result columns. No reflection happens at runtime, the generated code calls `pgx.Row.Scan` with the correct number of arguments and types.

```go
package main

import (
    "context"
    "fmt"
    "log"

    "myapp/internal/db"

    "github.com/jackc/pgx/v5/pgxpool"
)

func main() {
    ctx := context.Background()

    pool, err := pgxpool.New(ctx, "postgres://...")
    if err != nil {
        log.Fatal(err)
    }
    defer pool.Close()

    queries := db.New(pool)

    // Create user
    user, err := queries.CreateUser(ctx, db.CreateUserParams{
        Name:   "Alice",
        Email:  "alice@example.com",
        Status: "active",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Created: %+v\n", user)

    // Get user
    user, err = queries.GetUserByID(ctx, user.ID)
    if err != nil {
        log.Fatal(err)
    }

    // List users
    users, err := queries.ListUsers(ctx, db.ListUsersParams{
        Status: "active",
        Limit:  10,
        Offset: 0,
    })
    if err != nil {
        log.Fatal(err)
    }

    // Count
    count, err := queries.CountUsersByStatus(ctx, "active")
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Active users: %d\n", count)
}
```

### Advanced sqlc Queries

sqlc reads SQL query files annotated with `-- name: QueryName :one/:many/:exec` comments and generates type-safe Go functions: the query parameters become function arguments and the result columns become struct fields, with types inferred from the PostgreSQL schema. Because the Go code is generated from SQL, there is no query builder API to misuse: the developer writes standard SQL and the generated layer handles scanning results into structs, preventing both SQL injection and column-order mismatches. Schema changes detected by `sqlc generate` cause compilation errors in the generated code if query column references become invalid, making database refactoring safe to detect at compile time rather than at runtime.

```sql
-- name: SearchUsers :many
SELECT * FROM users
WHERE name ILIKE '%' || $1 || '%'
   OR email ILIKE '%' || $1 || '%'
ORDER BY created_at DESC
LIMIT $2;

-- name: GetUserWithOrders :many
SELECT
    u.*,
    o.id as order_id,
    o.total_cents as order_total_cents,
    o.created_at as order_date
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.id = $1
ORDER BY o.created_at DESC;

-- name: BulkCreateUsers :copyfrom
INSERT INTO users (name, email, status) VALUES ($1, $2, $3);

-- name: UpdateUserStatus :execrows
UPDATE users SET status = $2 WHERE id = $1;
```

### sqlc Annotation Cheat Sheet

sqlc recognizes a small but expressive set of return-type annotations. Picking the right one is how you tell the generator what Go signature you want:

| Annotation | Generates | Use for |
|---|---|---|
| `:one` | `(Row, error)` | Single-row SELECT, or INSERT/UPDATE ... RETURNING a single row |
| `:many` | `([]Row, error)` | Multi-row SELECT |
| `:exec` | `error` | INSERT/UPDATE/DELETE where row count is irrelevant |
| `:execrows` | `(int64, error)` | Mutations where you need RowsAffected (optimistic locking, upserts) |
| `:execresult` | `(sql.Result, error)` | Mutations where you need LastInsertId (MySQL) |
| `:copyfrom` | `(int64, error)` | High-throughput bulk inserts via PostgreSQL COPY protocol |
| `:batchexec` / `:batchmany` / `:batchone` | `pgx.BatchResults` | Pipelined batches over a single round-trip with pgx |

The `:copyfrom` annotation is particularly important at scale: it produces a method that wraps `pgx`'s `CopyFrom`, which is roughly an order of magnitude faster than inserting rows one-by-one or even via multi-row `INSERT`. For batch jobs that load millions of rows, this alone often justifies adopting sqlc.

### Running sqlc in CI

Make the generated code part of the repository, not a build step. Commit everything under `internal/db/` and add a CI job that runs `sqlc generate` and then `git diff --exit-code`. If a developer edits a `.sql` file without regenerating, CI fails with a clean diff showing what is out of date. This catches the single most common mistake with code generators: generated code that silently drifts from the spec it was generated from.

### Pitfalls to Know

- **Dynamic WHERE clauses are awkward.** sqlc works best when the shape of the query is fixed. For search endpoints with optional filters, either write one query per filter combination (fine for 2-3 flags) or fall back to `squirrel` or raw `pgx` for the dynamic path. Do not fight the tool by concatenating SQL fragments around a sqlc query.
- **Nullable columns produce `pgtype.Text` / `sql.NullString`.** This is correct but verbose. Prefer `NOT NULL DEFAULT ''` at the schema level when the semantic distinction between empty and null does not matter.
- **`SELECT *` is convenient but brittle.** It pulls every column the table currently has, so adding a column silently widens the Go struct. Explicit column lists make schema changes explicit at the query site.
- **Schema file ordering matters.** sqlc parses schema files in lexical order, so name them `001_users.sql`, `002_orders.sql`, etc., and keep them aligned with your migration tool (golang-migrate, goose, or Atlas).

### Junior → FAANG: Your First sqlc Service, End to End

Start with a service you can describe in one sentence: "URL shortener that stores a short code, a target URL, and a click count." Create three files. `db/schema/001_links.sql` with the `CREATE TABLE`. `db/queries/links.sql` with `CreateLink :one`, `GetLinkByCode :one`, `IncrementClicks :exec`. `sqlc.yaml` with the `pgx/v5` target. Run `sqlc generate`. Open `internal/db/queries.sql.go` and read every line of generated code. That reading is the exercise. You will see a method signature like `func (q *Queries) GetLinkByCode(ctx context.Context, code string) (Link, error)` and a body that calls `q.db.QueryRow(ctx, getLinkByCode, code).Scan(&i.ID, &i.Code, &i.TargetURL, &i.Clicks, &i.CreatedAt)`. No reflection. No magic. You could have written it yourself, but sqlc wrote it for you and will rewrite it when the schema changes.

Worked example of the safety property. Rename `target_url` to `destination_url` in the schema. Run `sqlc generate`. Now the generated `Link` struct has `DestinationURL`. Every caller that referenced `link.TargetURL` fails to compile. This is the moment where you feel the value of sqlc in your spine: the schema change propagated through the type system, and the compiler found every call site for you. The Rails equivalent would have shipped to production and caught the bug in Sentry at 2 am.

Interview entry-point. "How would you make a database refactor safe?" Answer with the sqlc story: schema is the source of truth, queries are typed wrappers, CI runs `sqlc diff` as a gating check, the compiler finds every broken caller, the deploy is boring. Compare to the pre-sqlc world where you needed a grep, a mental model of the query string matches, and a full integration test suite hoping for coverage. The tool does not eliminate thinking, it eliminates the class of errors where the type system should have helped and did not.

First-job context. On week one you will inherit a service with `.sql` files and a `sqlc.yaml`. Your first PR will add a query. The review checklist: `-- name:` tag present, annotation correct (:one vs :many vs :exec), column list explicit (no `SELECT *` on production tables), parameter order matches usage, `EXPLAIN ANALYZE` attached in the PR description, integration test in `_test.go` using testcontainers-go. If you can ship that PR cleanly on day three, you have cleared the probationary bar at most Go shops.

### Senior @ FAANG: sqlc as a Platform, Not a Tool

At staff level, sqlc stops being a library and becomes the spine of your data access platform. The decisions you own are: the `sqlc.yaml` schema (versioned, shared across services via a Go module or a `buf.build` style registry), the CI pipeline that enforces regeneration, the observability middleware that wraps the generated `Queries`, the routing layer above it for read-replica splitting, the plugin strategy for polyglot codegen, and the migration policy that ensures generated code matches production schema.

sqlc.yaml at org scale. Use `version: "2"` and `plugins` blocks to invoke `sqlc-gen-python` and `sqlc-gen-kotlin` alongside the Go generator. The same `queries.sql` feeds a Go backend, a Kotlin mobile client, and a Python data pipeline, with identical column-to-field mappings. That is the platform-level value: schema drift across language boundaries becomes a CI failure, not a runtime mystery. Configure `emit_interface: true` and `emit_exact_table_names: true` and `emit_pointers_for_null_types: false` (use `pgtype.Text` instead, which carries the null bit explicitly). Configure `rename` blocks to bridge snake_case SQL to CamelCase Go without hand-editing.

Plugin ecosystem. `sqlc-gen-python` produces dataclasses and an async client against `asyncpg`. `sqlc-gen-kotlin` produces data classes and suspend functions for coroutine-based access. `sqlc-gen-typescript` (community) produces typed query wrappers for node-postgres. A principal-level architecture uses this: the canonical schema is in SQL, the canonical queries are in `.sql` files, and every language-specific service consumes generated code. Type safety is end-to-end across a polyglot stack with a single source of truth. This is how some polyglot shops align their Go and Kotlin backends.

CI pipeline, principal version. Step 1: spin a shadow Postgres via testcontainers-go or a dedicated CI Postgres. Step 2: apply all migrations from `db/migrations` via goose or atlas. Step 3: run `sqlc vet` with custom rules (no `SELECT *`, no unbounded `LIMIT`, no raw string interpolation, every `:many` must have a `LIMIT`). Step 4: run `sqlc generate`. Step 5: `git diff --exit-code` to fail if generated code is stale. Step 6: `golangci-lint run` including a custom linter that flags repository methods without a `context.Context` as the first arg. Step 7: `go test -race ./...` with `-tags=integration` to run the real-Postgres tests. Step 8: a query-count regression test that fails if an HTTP endpoint issues more queries than its budget. That pipeline catches 90 percent of the bugs that make it to production in less disciplined shops.

Observability middleware. Wrap the sqlc `DBTX` interface with a `tracedDBTX` that records OpenTelemetry spans. The span name is the query name (extracted from the generated constant name or from a `sqlc.arg` comment). The span carries `db.system=postgresql`, `db.statement=<redacted>`, `db.rows_affected`, `net.peer.name=<replica hostname>`. Ship spans to your APM. Build a dashboard keyed by query name. When p99 spikes you know exactly which query, and because the SQL lives in source control you can run `EXPLAIN ANALYZE` against production on the exact string. This closes the loop from code review to operations.

Read-replica routing above sqlc. sqlc takes a `DBTX` interface. Define `type RoutedDBTX struct { writer, reader DBTX }` that implements `DBTX` and routes based on a context key (`type readonly struct{}`). Methods on a `*Queries` built with the routed DBTX will dispatch to the reader pool when the context carries the readonly marker. Add a sqlc query-name allowlist so you do not route a write to the reader by mistake. For read-your-writes, set the marker only for queries known to tolerate replica lag, and fall back to primary for the others. The routing logic is 50 lines of Go above 10,000 lines of generated sqlc code, which is the right ratio.

Transaction discipline. sqlc's `WithTx` returns a `*Queries` bound to a transaction. The anti-pattern is holding a transaction open across multiple HTTP round trips or across goroutines. Principal rule: transactions are synchronous, scoped to a single request handler, and commit or rollback before the handler returns. Use `pgx.BeginFunc` with a closure so rollback-on-panic is automatic. Never return a `*Queries` from a function that took a transaction as input, the transaction ownership becomes unclear.

Batch and COPY patterns. `:copyfrom` is the right annotation for bulk loads. For pipelined mutations that do not fit `COPY` (because they have `RETURNING` or `ON CONFLICT`), use `:batchexec` / `:batchmany` which generates a `pgx.Batch` wrapper. Benchmark before choosing: on a 1M row insert, `COPY` beats `pgx.Batch` beats multi-row `INSERT` beats per-row `INSERT` by roughly 10x, 3x, 5x at each step. Principal-level default: `COPY` for pure inserts of homogenous data, `Batch` for mixed statements within a transaction.

Testing strategy. sqlmock is banned for sqlc code. The reason: sqlmock verifies that your code issues the SQL string you expected, which is a tautology with codegen. The useful test is that the SQL is correct against a real Postgres. Use testcontainers-go for integration tests, or pgtestdb which reuses a template database and is 10x faster for suites with hundreds of tests. Dockertest is the older alternative. For unit tests of business logic, test against the repository interface with a fake implementation, not against sqlc at all. The separation of concerns keeps unit tests fast and integration tests honest.

Schema refactor protocol. A breaking schema change (renaming a column used by a query) must go through a three-step rollout: add the new column, dual-write, migrate readers query-by-query, drop the old column. sqlc regeneration at each step verifies the Go code compiles against the current schema. The type system enforces the rollout discipline. Compare to a reflection ORM where the same refactor can silently accept the old column name and fail only at runtime. This is the structural argument for sqlc at scale: the tool turns schema refactors from a coordination problem into a compile-time problem, which is the strongest form of change management a code generator can offer.

Adoption signal. sqlc has become the visible default in the Go-Postgres ecosystem: it dominates new open-source Go backends, conference talks, and the job-posting stacks of Postgres-heavy shops. The common thread across teams that adopt it successfully: heavy Postgres usage, strong SQL culture, CI discipline. If your team lacks any of those, sqlc's value drops and GORM's productivity edge becomes defensible. The principal-level judgment is matching the tool to the team, not forcing the team to match the tool.

---
