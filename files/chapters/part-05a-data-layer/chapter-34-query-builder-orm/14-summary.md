## Summary

Go's database tooling spans a spectrum from raw SQL control to full ORM convenience, and the right choice depends on your team's SQL fluency, query complexity, and tolerance for abstraction.

**Key tools covered:**

1. **sqlc** generates type-safe Go code from annotated SQL files. No reflection at runtime, full SQL power, and schema changes cause compile errors rather than runtime failures. Best for teams that write SQL directly and want compile-time guarantees.
2. **GORM** provides a full ORM with model structs, automatic migrations, association loading, hooks, and scopes. It accelerates CRUD development but requires care with N+1 queries, transaction scope, and soft-delete semantics.
3. **SQLBoiler** takes a database-first approach, introspecting an existing schema to generate fully typed models and query methods. Suited to projects where the database schema is the source of truth.
4. **squirrel** builds parameterized SQL from method chains without managing models or relationships. It solves the dynamic filter problem, search APIs with optional conditions, cleanly and safely.
5. **bun** offers ORM features (relations, migrations) with explicit query builders (`NewSelect`, `NewInsert`) that make the generated SQL predictable. A practical middle ground between GORM and raw SQL.

**Architectural takeaways:**

- The repository pattern (a Go interface over data access) lets you swap implementations without touching service logic, and it makes unit testing straightforward with mock implementations.
- Production systems often combine tools: sqlc for performance-critical read paths, squirrel for dynamic search APIs, and GORM for admin CRUD where development speed matters more than query control.
- Query builders parameterize values but not identifiers. Always whitelist column names used in `ORDER BY`, `SELECT`, or table references to prevent SQL injection.
- Pass `context.Context` through every database call so queries respect HTTP request cancellation and deadlines.

### Junior -> FAANG: What to Keep From This Chapter on Day One

If you internalize four rules from this chapter you will outperform most L3 and L4 engineers on data access code. First, never loop a query inside a range over the results of another query. Second, never write SQL by string concatenation, even inside a query builder, even for identifiers, without a whitelist. Third, always pass `context.Context` through every database call. Fourth, transactions belong at the service layer and never span an outbound call to a non-database service.

Worked example of applying these four rules to your first real PR. You are asked to build `GET /orders` for a dashboard. Your draft is `db.Find(&orders)` followed by a loop that fetches each order's user. That violates rule one. Fix with `db.Preload("User").Find(&orders)`. Your draft accepts a `?sort=` query param and passes it to `OrderBy`. That violates rule two. Fix with a whitelist map and reject unknown columns with a 400. Your draft calls `db.Preload(...).Find(...)` with no context. That violates rule three. Fix with `db.WithContext(r.Context()).Preload(...).Find(...)`. Your draft wraps the read in a transaction because "transactions are safer." That is overkill and violates the spirit of rule four. Fix by removing the transaction because there is no write.

The "why did this fail?" reflex, condensed. Read the generated SQL before reading the Go code. Count queries per request before measuring latency. Check context propagation before tuning pool size. Look at `EXPLAIN ANALYZE` before adding an index. Each step takes less than a minute and rules out the most common root cause.

Interview entry point. In an L3 or L4 interview, when asked "how would you build this endpoint," walk through these four rules out loud. Interviewers score whether you have internalized the rules, not whether you remember the exact GORM syntax.

### Senior @ FAANG: What This Chapter Unlocks at Staff and Principal Level

At L5 and above the chapter content is table stakes. What you are being measured on is whether you can scale these rules from your own keyboard to a policy that binds a 100-engineer organization without requiring you to review every PR.

The staff-level reading of this chapter. The tools are less interesting than the seams they enable. A repository interface is a seam between domain and persistence. An outbox table is a seam between transactional state and eventual consistency. A schema lint is a seam between developer intent and operational risk. A query-count test is a seam between handler code and database load. A migration tool with advisory locks is a seam between deploy and database state. Staff engineers design seams. Principal engineers ship the platform that makes seams the path of least resistance.

Maturity model recap. L1 hand-rolled SQL everywhere. L2 one ORM chosen by the first senior. L3 repository interfaces and context propagation enforced. L4 codegen plus schema linting. L5 platform team owning the golden path end to end. Know where your organization sits, know the next step, and propose the investment that moves it one level. That is the L6 to L7 promotion signal.

Portfolio ADRs that belong above the chapter content. Tool choice ADR: one primary, one escape hatch, anything else requires review. Hook policy ADR: whitelist of three, all others banned by lint. Transaction boundary ADR: service layer only, no cross-service spans, centralized retry. Locking ADR: optimistic default, pessimistic with capacity justification. Soft-delete ADR: banned on PII tables, allowed on audit tables. Migration ADR: expand-contract mandatory, advisory locks mandatory, no startup migrations. Each ADR is a one-pager with owner, review cadence, and enforcement mechanism.

Governance maturity. The measure of a senior engineer's policy is not the policy document. It is the incident rate for the governed category three quarters after the policy lands. If the rate does not drop, the policy is theater. Write policies that come with enforcement tooling, deprecation timelines, and kill criteria. Retire policies that stop paying rent.

Cost model for the data layer. In 2026, for a typical cloud deployment, one database connection costs roughly $0.50 per month in RDS on an r7g.2xlarge sized for 2000 connections. One N+1 that fires 100 extra queries per request at 10 RPS burns 1000 queries per second, roughly 2% of a medium Postgres instance. One stale query plan that scans a table sequentially instead of using an index can 10x the IO bill for a service. Staff engineers know these numbers because they defend the data layer's budget at planning time.

Interview signal recap. L3: writes correct code. L4: picks the right tool for the constraints. L5: designs the seam for a service. L6: ships the policy and tooling for a platform. L7: sets the multi-year strategy and owns the outcome when the bet lands or misses. Each level includes the ones below. No level skips the fundamentals in this chapter.

The chapter's single most important idea, restated for staff and principal readers. The data access layer is where abstraction leaks most expensively. Every abstraction you ship should be tested against the three forces that bend it: scale (does it hold at 10x traffic), change (does it survive a schema migration without a rewrite), and failure (does it degrade gracefully under partial database outage). An abstraction that wins all three is worth the investment. An abstraction that wins on none is technical debt dressed up as a library.

---
