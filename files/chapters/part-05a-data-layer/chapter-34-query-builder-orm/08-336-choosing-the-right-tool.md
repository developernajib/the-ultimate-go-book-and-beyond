## 34.6 Choosing the Right Tool

### Comparison Table

| Feature | database/sql | sqlc | GORM | SQLBoiler | squirrel | bun | ent |
|---------|--------------|------|------|-----------|----------|-----|-----|
| Type Safety | Manual | Excellent | Good (better with v1.30 generics) | Excellent | Manual | Good | Excellent |
| SQL Control | Full | Full | Limited (hidden generation) | Good | Full | Good (explicit builders) | Limited (graph API) |
| Runtime Reflection | None | None | Heavy | None | None | Light | Light |
| Performance | Best | Best | Moderate | Good | Good | Good | Good |
| Schema Source | You | SQL files | Go structs | Live DB | n/a | Go structs | Go schema DSL |
| Learning Curve | Low | Low | Medium | Low | Low | Medium | Medium-High |
| Migrations | Manual | Manual (pair with golang-migrate) | Built-in (dev only) | Manual | Manual | Built-in | Atlas (built-in) |
| Relations | Manual | Manual | Built-in (Preload/Joins) | Built-in | Manual | Built-in (Relation) | Built-in (graph) |
| Code Gen | No | Yes (from SQL) | No | Yes (from DB) | No | No | Yes (from schema DSL) |
| 2026 fit | Micro-hot-paths | **Default for SQL-first teams** | Prototypes, admin CRUD | DB-first projects | Dynamic filters | Model-first with predictable SQL | Heavy relational graphs |

### When to Use What

**Use database/sql when** you need maximum performance on a hot path, your queries are simple and unlikely to change shape, or you want zero dependencies beyond the standard library. The tradeoff is manual row scanning and no compile-time type checking of column mappings.

**Use sqlc when** type safety matters and your team writes SQL comfortably. sqlc catches column mismatches at compile time, provides IDE autocompletion on generated methods, and adds no runtime overhead. It works best with stable schemas where queries are known ahead of time, dynamic filters require multiple query variants or a fallback to a query builder.

**Use GORM when** you need to move fast on CRUD-heavy features and the schema is still evolving. Auto-migrations, built-in hooks, and association loading reduce boilerplate. Teams familiar with Active Record or Django ORM will find the API intuitive. Watch for N+1 queries and soft-delete semantics as the application grows.

**Use SQLBoiler when** the database schema is the source of truth and you want generated, type-safe code without writing SQL query annotations. SQLBoiler is a strong fit for projects with complex existing schemas and many foreign key relationships. It requires a running database during code generation.

**Use squirrel when** your API needs dynamic query construction, search endpoints with optional filters, user-configurable sorting, and pagination. squirrel adds no model layer or migration system, so pair it with `database/sql` or another tool for schema management.

**Use bun when** you want ORM conveniences (relations, migrations, struct mapping) with more predictable SQL generation than GORM. bun's explicit builder methods (`NewSelect`, `NewInsert`) make it clear what query is being built, and its performance is closer to raw SQL than GORM due to less reliance on reflection. In the efectn/go-orm-benchmarks suite, bun typically sits within 1.5x of raw `database/sql` on common workloads and well ahead of GORM.

**Use ent when** your domain is a graph: deep relational traversals, many-to-many with edge attributes, polymorphism, or access control rules that span several hops. ent (originally from Meta/Facebook, now under the entgo.io umbrella) models the schema in Go code (`ent/schema/user.go`), generates a strongly typed client (`client.User.Query().Where(...).WithPosts().All(ctx)`), and integrates with Atlas for migrations. The upfront cost is a new DSL to learn. The payoff is that refactoring a field or edge becomes a compile-time operation rather than a grep-and-pray exercise. ent is a strong fit for large monoliths with heavy relational structure. It is overkill for a three-table CRUD service.

### 2026 Decision Tree

Use this as a starting point, then adapt to your team's constraints:

1. **Team writes SQL fluently and owns the schema?** -> `sqlc` + `pgx/v5`. This is the default answer in 2026 for new PostgreSQL services.
2. **Schema is legacy, comes from another team, or is managed by DBAs?** -> `sqlboiler` (database-first code generation).
3. **Rich domain graph, many edges, want compile-time query safety on associations?** -> `ent`.
4. **Want ORM ergonomics but explicit, predictable SQL?** -> `bun`.
5. **Need to move fast on CRUD with schema still in flux?** -> `GORM`, but put a repository interface in front so you can migrate later.
6. **Dynamic search API with many optional filters?** -> `squirrel` (or `goqu`) on top of `database/sql` or `pgx`, even if the rest of the app uses something else.
7. **Hot path where every microsecond counts?** -> hand-written `pgx` or `sqlc`, never a reflection-driven ORM.

Real production systems mix these. The healthy pattern is: sqlc for the 90% of queries that are stable and well-understood, squirrel for the 10% that are dynamic, and a single repository interface hiding which one serves each call.

### Junior → FAANG: Reading the Comparison Table Like an Engineer, Not a Shopper

The comparison table above looks like a shopping list, but tables do not make decisions, constraints do. The first-job skill is learning to translate a business constraint into a row in that table. "We onboard new engineers every two weeks" maps to "Learning Curve" and "SQL Control" columns. "We run on a 2 vCPU pod and p99 matters" maps to "Performance" and "Runtime Reflection." "The DBA team owns the schema" maps to "Schema Source." Reading the table as a senior means starting from the constraint and narrowing to a tool, not starting from a tool preference and rationalizing backward.

First-job trap. New engineers read "ent: Excellent type safety" and pitch ent in the sprint planning for a three-table admin service. The cost of ent is a schema DSL, a code-generation pipeline, and an Atlas migration workflow. For three tables, that is overhead your team pays forever for value you collect once. The rule I give juniors is "pick the simplest tool that meets today's constraints plus the next two quarters of known roadmap." If the roadmap has "add reporting dashboards" on it, sqlc + squirrel is the answer, not ent.

Interview worked example. "You are picking a data layer for a new payments service. What do you choose and why?" A strong answer walks the constraints. Payments need auditability, so every write must be reviewable, which favors sqlc over ORMs. Payments need correctness, so type safety matters, which again favors sqlc or ent over GORM. Payments need simple, stable queries (insert ledger entry, read ledger by account), not dynamic search, so squirrel is optional. Conclusion: sqlc + pgx, with golang-migrate for schema, and a repository interface to keep the service layer decoupled. That walk is the answer, the tool choice is the last sentence, not the first.

The "rewrite question." If an interviewer asks "would you rewrite our GORM service to sqlc," the senior answer is "show me the pain." Migrating 200 models costs a quarter of engineering time. Do it only if you can name the bug class it eliminates (performance SLO, auditability gap, recurring N+1 outages). Tool migration without a measured reason is resume-driven development.

### Senior @ FAANG: The Decision-Tree ADR, Team Seniority as a First-Class Input, and Polyglot Reality

Staff engineers do not pick tools, they write ADRs (Architecture Decision Records) that outlive them. The inputs to a data-layer ADR are not features, they are organizational constraints, and the decision tree above is only the skeleton. Fill it in with the following axes.

Greenfield versus legacy. On greenfield PostgreSQL services in 2026, sqlc + pgx is the industry default, and the ADR should say so without apology. A growing list of ex-Rails shops have publicly documented the move. On legacy services already running GORM at scale, the ADR should reject a rewrite unless there is a named pain point (p99 regression, auditability gap, repeated N+1 incidents). Incremental strangler-fig is the correct pattern. Put a repository interface in front of the existing ORM code, implement new features through the interface against sqlc, and let the ORM tail off over time. Never do a big-bang rewrite of the data layer, it is the highest-risk refactor class in any service.

Team seniority. This is the input most ADRs skip and it is the most important one. A team of 3 staff engineers can run raw pgx with no ORM and ship safely. A team of 30 engineers with a mix of seniors and juniors cannot, because every junior will introduce N+1s, injection surfaces, and leaked scans. For junior-heavy teams the correct choice is bun or ent, because the tool enforces patterns the reviewers would otherwise have to enforce by hand. The ADR bullet is "we choose bun over pgx because our team size exceeds our reviewer bandwidth for raw SQL, and bun's hooks give us observability without per-query instrumentation." Make team shape explicit. Tools that work at Stripe (where every engineer has SQL fluency) do not work at a 50-engineer shop hiring from bootcamps.

Migration frequency and schema stability. If the schema changes weekly (typical for early-stage product), GORM or bun with auto-migrate accelerate delivery. If the schema changes quarterly (typical for payments, identity, billing), sqlc with golang-migrate is correct because the slow, reviewed schema workflow is a feature. The ADR question is "how often does the schema change, and who approves changes." Match the tool to the cadence.

Polyglot needs. If the service talks to Postgres, MySQL, and ClickHouse, you cannot use sqlc uniformly (ClickHouse is poorly supported) and you cannot use bun uniformly (ClickHouse has its own bun-clickhouse driver but the dialect gaps are real). The pragmatic answer is one tool per store, chosen against each store's constraints, and a shared repository interface layer that hides the difference from the service layer. This is where the multi-repository pattern in the next section pays off.

The decision-tree ADR, full form. The skeleton I hand teams has six sections. Context (why are we deciding this, what constraints). Options considered (list with one-sentence pros and cons). Decision (the tool). Consequences (what becomes easy, what becomes hard). Review triggers (what events would cause us to revisit, such as "p99 over 80ms sustained" or "team grows past 40 engineers"). Ownership (who maintains the decision, who reviews migrations away from it). Without review triggers the ADR becomes a religious document and future engineers cannot evolve it. With review triggers it becomes a living contract.

Compile-time wiring as a sub-decision. Once the data-layer tool is chosen, the next ADR is how repositories are instantiated. Three options. google/wire generates code at build time, zero runtime cost, but every dependency change requires regenerating. uber/fx is runtime DI with lifecycle hooks, flexible but reflection-heavy. dig is fx's underlying container, lighter but without the lifecycle sugar. My default recommendation is wire for services under 50 types (most microservices) and fx for platforms and large monoliths. Juniors should not touch fx until they have shipped three services with wire, because fx's runtime errors are harder to debug than wire's compile-time errors.

Polyglot decision matrix for FAANG-scale shops. Postgres primary + Redis cache + ClickHouse analytics + Kafka event log is the canonical 2026 stack. The data-layer decisions are: sqlc for Postgres, raw go-redis (no ORM), bun or native ClickHouse driver for analytics, segmentio/kafka-go with schema registry for events. The cross-cutting repository interface must be thin enough that swapping any of these for a competitor is a week-long change, not a quarter-long one. If your repository leaks sqlc types into service code, you have failed the abstraction. If it leaks bun builders, same. The interface returns domain types. The implementation uses the tool. That is the contract.

Final staff lesson. Tool choice is the cheap decision. The expensive decision is the boundary between service code and data code, because you pay for a bad boundary every day forever. Put the tool choice in an ADR, then spend the real engineering budget on the repository interface and the unit-of-work pattern that makes it survive the tool change you will inevitably do in three years.

---
