## 34.3 SQLBoiler

### Code Generation

SQLBoiler takes a database-first approach: it connects to your existing database, reads the schema, and generates fully typed Go model code for every table, including relationships, insert/update/delete methods, and query builders. This is the opposite of GORM's code-first model, where you define structs and the ORM creates tables. Install the `sqlboiler` binary and a driver plugin for your database, then run the generator.

```bash
# Install
go install github.com/volatiletech/sqlboiler/v4@latest
go install github.com/volatiletech/sqlboiler/v4/drivers/sqlboiler-psql@latest

# Generate models
sqlboiler psql
```

### Configuration

SQLBoiler reads a `sqlboiler.toml` file for database connection details and generation options. The `blacklist` field excludes tables (like migration tracking tables) from code generation, and `pkgname` controls the Go package name of the output.

```toml
# sqlboiler.toml
[psql]
  dbname = "myapp"
  host   = "localhost"
  port   = 5432
  user   = "postgres"
  pass   = "secret"
  sslmode = "disable"
  blacklist = ["migrations"]

output   = "models"
pkgname  = "models"
```

### Usage

The generated models expose methods directly on model structs (`user.Insert`, `found.Update`, `found.Delete`) and package-level query functions like `models.FindUser` and `models.Users(...)`. Query modifiers (`qm.Where`, `qm.OrderBy`, `qm.Limit`) compose into the query chain, and eager loading uses `qm.Load` with generated relationship constants. The `boil.Infer()` argument tells SQLBoiler to auto-detect which columns to include based on non-zero struct fields.

```go
package main

import (
    "context"
    "database/sql"
    "log"

    "myapp/models"

    "github.com/volatiletech/sqlboiler/v4/boil"
    "github.com/volatiletech/sqlboiler/v4/queries/qm"
    _ "github.com/lib/pq"
)

func main() {
    db, err := sql.Open("postgres", "...")
    if err != nil {
        log.Fatal(err)
    }

    boil.SetDB(db)
    ctx := context.Background()

    // Create
    user := &models.User{
        Name:  "Alice",
        Email: "alice@example.com",
    }
    if err := user.Insert(ctx, db, boil.Infer()); err != nil {
        log.Fatal(err)
    }

    // Find
    found, err := models.FindUser(ctx, db, user.ID)
    if err != nil {
        log.Fatal(err)
    }

    // Query
    users, err := models.Users(
        qm.Where("status = ?", "active"),
        qm.OrderBy("created_at DESC"),
        qm.Limit(10),
    ).All(ctx, db)
    if err != nil {
        log.Fatal(err)
    }

    // Eager loading
    users, err = models.Users(
        qm.Load(models.UserRels.Orders),
        qm.Where("status = ?", "active"),
    ).All(ctx, db)

    // Update
    found.Name = "Alice Smith"
    if _, err := found.Update(ctx, db, boil.Whitelist("name")); err != nil {
        log.Fatal(err)
    }

    // Delete
    if _, err := found.Delete(ctx, db); err != nil {
        log.Fatal(err)
    }
}
```

### Junior → FAANG: When a Database-First Tool Changes How You Think

sqlboiler inverts the workflow junior engineers learn first. Instead of writing Go structs and letting the ORM create tables, you write migrations in SQL, apply them to a live database, point sqlboiler at that database, and receive generated Go code. The mental flip matters: the schema is not a consequence of your Go code, your Go code is a consequence of the schema. For a junior engineer used to Rails or Django that is disorienting, but it is exactly the model used by teams where a DBA owns the schema and application engineers consume it.

Worked example. A DBA adds a `phone_number` column to `users` with a CHECK constraint validating E.164 format. You pull the migration, apply it to your local Postgres, run `sqlboiler psql`, and the generated `User` struct gains a `PhoneNumber null.String` field. Your application code now has a typed accessor for the new column without you having to touch any Go file by hand. The CHECK constraint still lives in the database, so invalid writes fail at the SQL layer even if your Go validation misses. That layered defense is the database-first philosophy in one example.

Interview entry-point. "When would you pick sqlboiler over sqlc?" The crisp answer: "When the schema is owned by a separate team (DBA, data platform, a compliance function) and the application is downstream. sqlboiler regenerates from the live schema, so schema changes propagate as Go type changes without me having to write new query files. sqlc is query-first and assumes the app team owns the schema. If ownership is split, sqlboiler's model matches the org chart." Say that and you have shown you understand tools are organizational choices, not just technical ones.

First-job context. sqlboiler is common in fintech, healthcare, and regulated-industry Go services where the schema is audited separately from the application. If your first job is at Plaid, Ramp, or a banking-as-a-service shop, there is a real chance sqlboiler or a similar database-first tool is in the stack. Read the generated code. Learn the `qm` query modifier conventions. Understand `boil.Infer()` versus `boil.Whitelist()` because the difference is what separates an UPDATE that touches the columns you want from one that silently overwrites half the row.

### Senior @ FAANG: Database-First vs Query-First as an Organizational Contract

The senior framing of sqlboiler versus sqlc is not "which is better," it is "which matches the ownership model of your data." In query-first (sqlc), the app team writes SQL queries and the schema is a collaborative artifact reviewed like any other code. In database-first (sqlboiler), the schema is an upstream contract produced by a separate function, and the app team consumes typed code regenerated on each schema release. The choice reflects Conway's Law: your data access tooling mirrors your org chart whether you plan for it or not.

sqlboiler philosophy unpacked. The generator reads `information_schema` and `pg_catalog` to produce a complete typed client: one struct per table, Insert/Update/Upsert/Delete methods, typed column constants, relationship accessors, and a `qm` DSL for query composition. The `null` package provides nullable types that preserve the distinction between "absent" and "zero," which sqlc's `pgtype` also handles but sqlboiler exposes with a more ergonomic API. The generated code is substantially larger than sqlc's output because every table produces a full CRUD surface by default, which is a productivity win when you want CRUD and a bloat cost when you do not.

Trade-offs against sqlc. sqlboiler gives you CRUD for free because every table gets Insert/Update/Delete without you writing SQL. sqlc gives you only the queries you wrote, so you add boilerplate for simple CRUD but you never get a method you did not ask for. On a 50-table schema sqlboiler generates roughly 5x the code of sqlc. The generated `qm` DSL is runtime-composed, which means query construction takes strings that look like raw SQL fragments, which means column names are not compile-time checked in the DSL. sqlc's approach of generating one typed method per named query is stricter. The trade: sqlboiler accelerates CRUD, sqlc enforces query-text discipline.

Where sqlboiler wins definitively. (1) Schemas with hundreds of tables, where writing named queries for every CRUD access is infeasible. (2) Schemas maintained by a DBA team with a release cadence separate from the application, where "regenerate from the live schema" is the correct workflow. (3) Applications that do mostly simple reads and writes with occasional custom queries, where the custom queries go through `qm` modifiers. (4) Regulated domains where the schema carries constraints (CHECK, FOREIGN KEY, DOMAIN types) that must be enforced at the database layer, and the Go code should reflect the schema rather than drive it.

Where sqlboiler loses. (1) Applications with complex analytical queries, CTEs, and window functions, because the `qm` DSL does not express those ergonomically and you drop to `queries.Raw` anyway. (2) Teams with strong SQL culture who want named queries in source control, where sqlc's model is cleaner. (3) Services where the generated code size matters for compile time or binary size, because sqlboiler's output is large.

Migration from sqlboiler. A common pattern in 2026: teams that adopted sqlboiler in 2019-2021 migrate to sqlc for hot-path queries while keeping sqlboiler for the long tail of CRUD. Both tools coexist on the same `*sql.DB` or `*pgxpool.Pool` because both ultimately issue SQL through standard drivers. The repository interface stays stable. The adapter implementation gains sqlc-backed methods for the specific queries that need compile-time safety on complex SQL, while sqlboiler continues to serve the trivial access patterns. This hybrid is defensible and well documented in public engineering posts from several fintech shops.

Polyglot codegen, sqlboiler does not have a plugin ecosystem comparable to sqlc's. If you need typed clients in Python or Kotlin, sqlboiler leaves you on your own. sqlc's `sqlc-gen-python` and `sqlc-gen-kotlin` plugins, along with the community's TypeScript generator, make sqlc the stronger choice when the schema feeds multiple languages. Principal-level evaluation: if the org is Go-only or Go-primary, sqlboiler is viable. If the org is polyglot with strong type-safety requirements across languages, sqlc's ecosystem wins.

Testing sqlboiler code. The same rule applies: mock-db (sqlmock) tests are tautological against generated code, real-db tests via testcontainers-go or pgtestdb are required. sqlboiler has a `randomize` helper that populates test structs with valid random data respecting FK and CHECK constraints, which is useful for property-based tests. Use it. Pair with `go-cmp` for deep equality assertions and with `pgx`'s query tracer for N+1 detection in integration tests.

Connection ownership. sqlboiler's `boil.SetDB(db)` is a global-state antipattern. Principal rule: do not use `boil.SetDB`. Pass the `*sql.DB` explicitly to every generated method (the generated methods accept a `boil.ContextExecutor` as their last argument). Global state makes testing painful and makes multi-tenant routing impossible. Every generated method takes the executor, use that, ignore the global.

Soft delete. sqlboiler does not add soft-delete semantics by default, which is a point in its favor relative to GORM. If your schema uses a `deleted_at` column, you write the filter in the query, which is explicit and reviewable. This is the query-first principle asserting itself even within the database-first tool: the SQL you see is the SQL that runs.

FAANG and near-FAANG adoption. sqlboiler is less common at the hyperscalers than sqlc but retains users in fintech and healthcare. Several banking-as-a-service platforms use it because their compliance model puts the schema under separate governance. The adoption signal: when you see sqlboiler in an org, look for a separate DBA or data-platform team, that is the tell. When you see sqlc, look for an app team that owns the schema end to end. The tool reveals the org.

Principal-level recommendation. Default to sqlc for new Go services because query-first matches the prevailing 2026 Go culture and has the stronger plugin ecosystem. Choose sqlboiler when your org has a split schema-ownership model and regenerating from a live schema matches your release process. Never choose both at once without a clear ADR describing why. Both at once means you have not decided which philosophy governs your data access, and that indecision will show up as schema-drift bugs within two quarters.

---
