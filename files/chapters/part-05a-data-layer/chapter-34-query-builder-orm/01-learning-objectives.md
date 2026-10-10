## Learning Objectives

After completing this chapter, you will be able to:

1. **Choose the right database tool** - Understand when to use raw SQL, query builders, or ORMs
2. **Master sqlc** - Generate type-safe Go code from SQL queries
3. **Work with GORM** - Build applications rapidly with Go's most popular ORM
4. **Use SQLBoiler** - Apply database-first code generation
5. **Build dynamic queries** - Create flexible search APIs with squirrel
6. **Apply enterprise patterns** - Implement repository patterns used by Uber, Stripe, and Shopify
7. **Avoid common pitfalls** - Recognize and prevent N+1 queries and other ORM anti-patterns

### Junior → FAANG: Objectives Mapped to Interview Signal

For a first FAANG or FAANG-adjacent role, translate each objective into a demonstrable artifact. "Choose the right database tool" becomes a written one-page ADR in your portfolio comparing sqlc, GORM, and bun for a concrete service you built. "Master sqlc" becomes a small repo with a `queries.sql`, a generated `db.go`, and a `make sqlc` target in CI. "Work with GORM" becomes a CRUD admin panel where you can point to the exact line that would cause an N+1 and the `.Preload` that fixes it. "Build dynamic queries" becomes a search endpoint with five optional filters built on squirrel, with a test that verifies no SQL injection is possible via column names. "Apply enterprise patterns" becomes a repository interface with two implementations (sqlc and an in-memory fake) plus a `testcontainers-go` integration test. These artifacts are what a hiring manager scans on GitHub before the screen, and they compress a year of on-the-job learning into one review-able story.

Worked entry-point question. "Walk me through your data access layer." The answer structure that wins: (1) what the interface looks like in `internal/domain`, (2) which implementation you chose and the one-sentence ADR for why, (3) how the test harness runs a real Postgres, (4) one specific query that surprised you and how you measured its plan, (5) one N+1 you caught and how. If you can deliver that in three minutes, you are through the phone screen.

### Senior @ FAANG: Objectives Reframed as Architecture Deliverables

At staff and principal level the objectives are not "master sqlc," they are "own the data access strategy for a service or a fleet of services." The first deliverable is a technical strategy document that enumerates every database-facing service in your org, classifies each as sqlc-suitable, GORM-suitable, or raw-SQL-required, and proposes a migration path for the ones that chose the wrong tool. The second deliverable is a CI template that runs `sqlc diff`, `sqlc vet`, and a query-count regression test as gating checks, shipped as a shared GitHub Action across the org. The third deliverable is a linter configuration (golangci-lint plus a custom `go/analysis` pass) that flags `.Preload` inside a loop, raw SQL string concatenation, and unbounded `Find` without `Limit`. The fourth deliverable is a runbook for the three most common failure modes: pool exhaustion under burst load, N+1 caught in production, and a soft-delete query returning deleted rows because a developer bypassed the scope.

The fifth deliverable, which is the one that separates staff from principal, is an organizational alignment: a written policy that says "new Go services default to sqlc plus pgx, deviations require an ADR approved by the data platform team." That kind of policy is how disciplined Go platform teams prevent the long tail of one-off GORM choices from accumulating into an unmaintainable fleet. The objectives of this chapter are not academic, they are the building blocks of that policy. Master each one not to pass an interview but to write the document that makes the interview unnecessary.

Cross-cutting concerns a senior must also own: observability hooks (pgx tracer emitting OpenTelemetry spans with query name and duration), connection pool sizing (the formula is `max_conns = ((core_count * 2) + effective_spindle_count)` for Postgres, adjusted for pgbouncer topology), read-write split via separate pools and a repository that routes by method, and schema migration pipeline (goose or atlas, with sqlc regeneration as a post-migration hook in CI). These are not addenda to the chapter objectives, they are the objectives a principal is expected to deliver as a system, not as isolated knowledge.

---
