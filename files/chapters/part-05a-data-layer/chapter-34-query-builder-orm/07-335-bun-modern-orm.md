## 34.5 bun: Modern ORM

### Setup

bun wraps a standard `database/sql` connection with a dialect-aware query builder. Models use struct tags in the `bun:` namespace to define table names, column aliases, primary keys, and relationship mappings. Unlike GORM, bun generates SQL through explicit builder methods (`NewSelect`, `NewInsert`, `NewUpdate`, `NewDelete`) rather than a single chained object, which makes the query intent clear at each call site.

```go
package main

import (
    "context"
    "database/sql"
    "log"
    "time"

    "github.com/uptrace/bun"
    "github.com/uptrace/bun/dialect/pgdialect"
    "github.com/uptrace/bun/driver/pgdriver"
)

type User struct {
    bun.BaseModel `bun:"table:users,alias:u"`

    ID        int64     `bun:"id,pk,autoincrement"`
    Name      string    `bun:"name,notnull"`
    Email     string    `bun:"email,notnull,unique"`
    Status    string    `bun:"status,notnull,default:'active'"`
    CreatedAt time.Time `bun:"created_at,notnull,default:current_timestamp"`

    Orders []*Order `bun:"rel:has-many,join:id=user_id"`
}

type Order struct {
    bun.BaseModel `bun:"table:orders,alias:o"`

    ID         int64     `bun:"id,pk,autoincrement"`
    UserID     int64     `bun:"user_id,notnull"`
    TotalCents int64     `bun:"total_cents,notnull"`
    CreatedAt  time.Time `bun:"created_at,notnull,default:current_timestamp"`

    User *User `bun:"rel:belongs-to,join:user_id=id"`
}

func main() {
    dsn := "postgres://user:pass@localhost:5432/mydb?sslmode=disable"
    sqldb := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dsn)))

    db := bun.NewDB(sqldb, pgdialect.New())
    ctx := context.Background()

    // Create tables
    db.NewCreateTable().Model((*User)(nil)).IfNotExists().Exec(ctx)
    db.NewCreateTable().Model((*Order)(nil)).IfNotExists().Exec(ctx)

    // Insert
    user := &User{Name: "Alice", Email: "alice@example.com"}
    if _, err := db.NewInsert().Model(user).Exec(ctx); err != nil {
        log.Fatal(err)
    }

    // Select
    var users []User
    if err := db.NewSelect().
        Model(&users).
        Where("status = ?", "active").
        Order("created_at DESC").
        Limit(10).
        Scan(ctx); err != nil {
        log.Fatal(err)
    }

    // With relations
    if err := db.NewSelect().
        Model(&users).
        Relation("Orders").
        Scan(ctx); err != nil {
        log.Fatal(err)
    }

    // Update
    if _, err := db.NewUpdate().
        Model(user).
        Set("name = ?", "Alice Smith").
        Where("id = ?", user.ID).
        Exec(ctx); err != nil {
        log.Fatal(err)
    }

    // Delete
    if _, err := db.NewDelete().
        Model(user).
        Where("id = ?", user.ID).
        Exec(ctx); err != nil {
        log.Fatal(err)
    }
}
```

### Advanced Queries

bun supports subqueries as first-class values: you pass a `*bun.SelectQuery` directly into a `Join` clause, and bun renders it as a derived table. For cases where the query builder is too restrictive, `NewRaw` accepts a plain SQL string with `?` placeholders while still returning typed results through `Scan`. Bulk inserts pass a slice pointer to `NewInsert().Model()`, bun generates a single multi-row `INSERT` statement.

```go
// Subquery
subq := db.NewSelect().
    Model((*Order)(nil)).
    ColumnExpr("user_id").
    ColumnExpr("SUM(total_cents) as total_spent_cents").
    Group("user_id")

var results []struct {
    User            User
    TotalSpentCents int64
}

err := db.NewSelect().
    Model((*User)(nil)).
    ColumnExpr("u.*").
    ColumnExpr("s.total_spent_cents").
    Join("LEFT JOIN (?) AS s ON s.user_id = u.id", subq).
    Scan(ctx, &results)

// Raw query
var users []User
err = db.NewRaw("SELECT * FROM users WHERE status = ? ORDER BY created_at DESC", "active").
    Scan(ctx, &users)

// Bulk insert
users := []User{
    {Name: "Alice", Email: "alice@example.com"},
    {Name: "Bob", Email: "bob@example.com"},
}
_, err = db.NewInsert().Model(&users).Exec(ctx)
```

### Junior → FAANG: bun as the Pragmatic ORM Middle Ground

If you learned Ruby on Rails ActiveRecord or Django ORM first, your instinct is to reach for GORM in Go because the `db.Find(&user, id)` style feels familiar. That instinct is why so many Go-on-Rails teams ship slow services. bun sits deliberately between GORM and raw sqlc. It gives you model structs and relationship tags, but every query is a builder chain with explicit verbs (`NewSelect`, `NewInsert`), so there is no hidden "ORM magic" doing a second query behind your back. When a senior reviewer asks "what SQL does this emit," you can read the builder chain and answer without running the code.

First-job mental model. A bun query is a pipeline. `db.NewSelect().Model(&users).Where(...).Scan(ctx)` is four steps: pick a verb, attach a destination, filter, execute. Learn those four steps and 80% of bun is covered. The remaining 20% is relations (`Relation("Orders")`), raw escape hatches (`NewRaw`), and hooks. Do not use `Relation("Orders")` on a list endpoint without a `Limit` on both sides, or you will pull 500 users times 2,000 orders and crash the pod. The first production bug juniors ship with bun is exactly that.

Worked example. "Build an endpoint that returns the top 10 customers by lifetime spend for a given tenant." Answer: a single `NewSelect` with `ColumnExpr("u.id, u.name, SUM(o.total_cents) AS spend_cents")`, a `Join("JOIN orders o ON ...")`, `Where("u.tenant_id = ?", tenantID)`, `Group("u.id, u.name")`, `Order("spend_cents DESC")`, `Limit(10)`, `Scan(ctx, &rows)`. The interview signal you are giving is that you reached for a single JOIN + GROUP BY rather than N+1 through `Relation`. That is the distinction between a junior who uses an ORM and an engineer who understands the SQL it emits.

JSONB first-class support is bun's killer feature on Postgres. If your struct has a `Metadata map[string]any` with `bun:"metadata,type:jsonb"`, bun marshals it transparently, and you can query with `Where("metadata @> ?", bun.SafeQuery(...))`. Coming from sqlc, where JSONB requires hand-written conversion code, this alone often justifies bun on a greenfield project. Interviewers at Postgres-heavy shops (Notion, Linear, Retool) will ask about this.

### Senior @ FAANG: bun as the OTel-Native ORM, Benchmarks, and the Uptrace Lens

At staff level the bun-versus-GORM question is not a taste debate, it is a telemetry and allocation conversation. bun is built by Uptrace, an OpenTelemetry vendor, and its observability story is the reason it belongs in the conversation at all. Before looking at features, establish the measurement baseline.

Performance, real numbers. Published benchmarks and my own pprof runs put bun roughly 30-50% faster than GORM on SELECT-heavy workloads and 2-4x faster on bulk INSERT, with a similar advantage in allocations per query. The gap comes from three places. GORM uses reflection on every call to walk the struct tags, bun caches the reflected schema at first use. GORM's query builder goes through a generic `*gorm.DB` that accumulates state via pointer mutation and copies, bun's builders are typed per verb and copy less. GORM's callbacks fire even when empty, bun's hooks are nil-checked and skip cleanly. At p99 on a hot CRUD endpoint, the difference between bun and GORM is often the difference between meeting and missing a 50ms SLO. You still will not beat sqlc + pgx, which is 2-3x faster than bun again, but bun pays for itself when you need a real query builder.

OpenTelemetry integration is first-class, not bolted on. `bun.NewDB(sqldb, pgdialect.New())` accepts an `otelbun` hook:

```go
import "github.com/uptrace/bun/extra/bunotel"

db.AddQueryHook(bunotel.NewQueryHook(
    bunotel.WithDBName("orders"),
    bunotel.WithFormattedQueries(true),
))
```

This emits spans per query with `db.system=postgresql`, `db.statement` set to the SQL template (not the args, which is correct from a PII standpoint), and error recording. You do not write this instrumentation, you adopt it. By comparison GORM's OTel plugin is community-maintained and has historically lagged spec updates. If your org has a "every DB call must be a span" rule, bun gives you that out of the box.

Hooks as the cross-cutting concern layer. bun's `QueryHook` interface has `BeforeQuery` and `AfterQuery`. I push teams to ship three hooks as a standard bundle. One for tracing (`bunotel`). One for slow-query logging that records any query over 100ms with the template and duration (not args). One for a per-tenant QPS counter that increments a Prometheus gauge. Because hooks run around every query, this gives you a control plane equivalent to Rails' `ActiveSupport::Notifications` but type-safe. The anti-pattern to avoid is a hook that does additional I/O (writing to Redis, calling a webhook). Hooks are on the hot path, keep them CPU-only.

Batch operations and the N+1 killer. bun's `NewInsert().Model(&slice).Exec(ctx)` emits a single multi-row INSERT. For 10,000 rows, that is one network round-trip. The same workload through GORM's `Create(&slice)` historically emitted 10,000 individual INSERTs unless you set `CreateBatchSize`. That kind of default matters when you are running a batch import job. bun also supports `OnConflict("(email) DO UPDATE")` natively, so upserts are one call, not a read-then-write dance.

Migrations. bun has a migrations package (`github.com/uptrace/bun/migrate`) with numbered up/down files and a `bun.Migrations` registry. It is simpler than goose or golang-migrate, but also less feature-rich (no dirty-state detection, no advisory locks by default). For a team running one service per database, bun migrations are fine. For a shop running 50 services against shared clusters, pair bun with golang-migrate so the advisory-lock behavior is standardized across the fleet and the migration tool is independent of the ORM.

When bun is the wrong answer. Three cases. First, a pure-sqlc team that has operational discipline around handwritten queries. Adding bun means two ways to query the DB, which doubles review load. Second, a team that needs schema versioning across multi-region Spanner or Cockroach deployments. bun's Postgres dialect maps to Cockroach acceptably but falls short of the transactional idioms those DBs expect. Third, any codebase that has already committed to GORM at scale (100+ models). The migration cost to bun is not justified unless you have a measured perf problem. "bun is 40% faster" is not enough on its own, "our p99 is 80ms over SLO and bun closes the gap" is.

The staff-level ADR bullet. "We adopt bun for services that need (a) dynamic queries beyond sqlc's reach, (b) first-class Postgres JSONB access, and (c) OpenTelemetry spans per query without custom wrapping. We reject bun for hot-path services where sqlc + pgx benchmarks better, and for services under 10 models where hand-written pgx is simpler to review." Put that in a doc, reference it in PR reviews, and new engineers know when to reach for which tool.

---
