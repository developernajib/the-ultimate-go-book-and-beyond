## 34.10 Interview Questions

### Question 1: When would you choose sqlc over GORM?

**Answer**: Choose sqlc when:
- Type safety is critical (compile-time SQL validation)
- Team has strong SQL skills
- Performance is paramount (no reflection)
- Need full SQL power (CTEs, window functions, `RETURNING`, `COPY FROM`)
- Working with existing, stable schemas

Choose GORM when:
- Rapid prototyping needed
- Schema still evolving (auto-migrations)
- Team prefers ORM patterns
- Need built-in hooks and callbacks
- Standard CRUD operations

**What FAANG expects:** A mature answer frames this as a tradeoff between *where errors surface* and *where flexibility lives*. sqlc moves schema/query mismatches to compile time at the cost of dynamic query flexibility. GORM defers errors to runtime but handles dynamic shapes cheaply. Senior candidates cite concrete ORM failure modes (N+1 on `Preload`, zero-value filter dropping, hook recursion) and describe a hybrid: sqlc for stable hot paths, squirrel or raw pgx for dynamic search. Bonus points for mentioning that the canonical 2026 sqlc configuration is `sql_package: pgx/v5` and for knowing `:copyfrom` for bulk loads.

**Follow-ups:**
- How do you handle dynamic WHERE clauses in a sqlc-centric codebase? (Answer: multiple query variants for low-cardinality flags. Fall back to squirrel or pgx for open-ended filters. Never concat SQL.)
- What breaks in CI when a column is dropped from the schema? (Answer: `sqlc generate` either errors or produces code that fails `go build`. Add `git diff --exit-code` after generate so stale generated code blocks the PR.)
- Can sqlc queries and hand-written pgx calls share a transaction? (Answer: yes - `queries.WithTx(tx)` returns a `*Queries` bound to the transaction. You can interleave it with direct `tx.Exec` calls.)

### Question 2: How do you prevent N+1 queries?

**Answer**: Multiple strategies:

1. **Eager loading**: `db.Preload("Relation").Find(&items)`
2. **Batch loading**: Load IDs first, then fetch related in one query
3. **DataLoader pattern**: Cache and batch requests
4. **SQL JOINs**: Use explicit joins for complex relations

```go
// DataLoader pattern
type UserLoader struct {
	cache map[int64]*User
	batch []int64
}

func (l *UserLoader) Load(id int64) *User {
	if user, ok := l.cache[id]; ok {
		return user
	}
	l.batch = append(l.batch, id)
	return nil // Will be populated after batch
}

func (l *UserLoader) Execute(db *gorm.DB) {
	if len(l.batch) == 0 {
		return
	}
	var users []User
	db.Where("id IN ?", l.batch).Find(&users)
	for _, u := range users {
		l.cache[u.ID] = &u
	}
}
```

**What FAANG expects:** Candidates should distinguish *detection* from *fix*. Detection: query counters in integration tests (assert at most N queries for a request), SQL logs with request correlation IDs, APM traces showing fan-out. Fix options, in order of preference: (1) a single JOIN with a flat DTO, (2) a second `WHERE id IN (...)` followed by in-memory grouping, (3) DataLoader for GraphQL-style access patterns. Strong candidates warn that `Preload` in GORM is *itself* a second query (not a join), which surprises people who think eager loading means JOIN.

**Follow-ups:**
- Why is `Preload` sometimes better than a JOIN even though it costs an extra round-trip? (Answer: JOINs multiply row counts for one-to-many and duplicate parent columns, inflating bandwidth. A two-query `Preload` uses `WHERE IN` and keeps wire size minimal for has-many with wide parents.)
- How would you write a test that fails if a handler regresses into N+1? (Answer: wrap the pool with a driver that counts prepare/query calls, run the handler against fixtures with N parents, and assert query count is O(1) or O(depth), not O(N).)
- What is the DataLoader pattern's main benefit over eager loading? (Answer: it works *across* requests within a tick - ideal for GraphQL resolvers where the resolver cannot know the full object set up front.)

### Question 3: How do you handle database migrations in production?

**Answer**: Best practices:

1. **Version control migrations**: Each migration in separate file
2. **Forward-only**: Never modify applied migrations
3. **Test rollbacks**: Ensure down migrations work
4. **Blue-green deployments**: Migrations must be backwards compatible
5. **Small, frequent migrations**: Easier to review and rollback

```go
// Example migration strategy
type Migration struct {
	Version     int
	Description string
	Up          func(db *sql.DB) error
	Down        func(db *sql.DB) error
}

func RunMigrations(db *sql.DB, migrations []Migration) error {
	currentVersion := getCurrentVersion(db)

	for _, m := range migrations {
		if m.Version > currentVersion {
			if err := m.Up(db); err != nil {
				return fmt.Errorf("migration %d failed: %w", m.Version, err)
			}
			setCurrentVersion(db, m.Version)
		}
	}
	return nil
}
```

**What FAANG expects:** The heart of the answer is *expand-contract* (also called *online migrations*): every schema change is split into a sequence of backwards-compatible steps so the old and new code can coexist while deploys roll out. For a column rename: add the new column, dual-write in the app, backfill the old rows, switch reads, stop writing the old column, drop it in a later release. Candidates should name a real tool (golang-migrate, goose, or Atlas with declarative migrations), explain advisory locks to prevent two instances migrating at once, and flag that `ALTER TABLE ... ADD COLUMN NOT NULL DEFAULT` rewrites the whole table on older PostgreSQL versions (fixed in PG 11+ for constants, but still a landmine for volatile defaults).

**Follow-ups:**
- How do you migrate a table with a billion rows without downtime? (Answer: add new column nullable, backfill in batches with throttling, add NOT NULL with `VALIDATE CONSTRAINT` to avoid full-table lock, cut over reads, then drop old column in a later deploy.)
- What is wrong with letting GORM's `AutoMigrate` run in production? (Answer: it cannot drop columns, cannot rename, cannot express data migrations, and runs on every boot so crashes mid-schema change leave an ambiguous state. Use it for dev only.)
- How do you prevent two app instances racing the migration on boot? (Answer: PostgreSQL advisory lock via `pg_try_advisory_lock`, or a dedicated migration job in the deploy pipeline rather than app startup.)

### Question 4: What's the repository pattern and when should you use it?

**Answer**: Repository pattern abstracts data access:

```go
type UserRepository interface {
	Create(ctx context.Context, user *User) error
	GetByID(ctx context.Context, id int64) (*User, error)
}
```

Benefits:
- Swappable implementations (testing, migrations)
- Clean separation of concerns
- Domain logic doesn't depend on persistence

Use when:
- Large applications with complex domains
- Need to support multiple databases
- Want thorough unit testing with mock repositories
- Team uses DDD

Skip when:
- Small applications
- Simple CRUD
- Rapid prototyping

**What FAANG expects:** Seniors articulate the repository interface as a *seam* between the domain and the infrastructure, not as a generic "wrap the ORM" layer. The interface exposes domain concepts (`FindActiveUsersCreatedAfter(ctx, t)`), not CRUD primitives bolted onto an ORM. Candidates should warn about the anti-pattern of leaky repositories that return ORM-specific types (GORM's `*gorm.DB`, sqlc's generated row structs) - those leak persistence concerns into the service layer and defeat the point. Strong answers cite testability (fakes beat mocks for real logic coverage), swappability (swap sqlc for pgx without touching services), and read/write split (CQRS layered on top of the same interface).

**Follow-ups:**
- How do you test the service layer without spinning up a database? (Answer: in-memory fake implementation of the repository interface, exercised with the same test cases as the real one via a shared conformance test suite.)
- When is the repository pattern actively harmful? (Answer: single-table CRUD services where the "repository" becomes a trivial passthrough adding a layer of indirection with zero benefit. Skip it until you have two implementations or non-trivial business rules.)
- How do you expose transactions across multiple repositories? (Answer: pass a `*sql.Tx` / `pgx.Tx` into a `UnitOfWork` or a `WithTx(tx) UserRepository` method. Avoid exposing transactions in the domain interface directly.)

### Question 5: How do you optimize ORM performance?

**Answer**: Key optimizations:

1. **Indexes**: Create indexes for frequently queried columns
2. **Select specific columns**: `db.Select("id", "name").Find(&users)`
3. **Batch operations**: `db.CreateInBatches(users, 100)`
4. **Connection pooling**: Configure pool size appropriately
5. **Query logging**: Enable in development to catch slow queries
6. **Avoid Preload**: Use explicit JOINs for complex relations

```go
// Enable query logging
db, _ := gorm.Open(postgres.Open(dsn), &gorm.Config{
	Logger: logger.Default.LogMode(logger.Info),
})

// Profile slow queries
db.Callback().Query().After("gorm:query").Register("slow_query", func(d *gorm.DB) {
	if d.Statement.Context != nil && d.RowsAffected > 0 {
		elapsed := time.Since(d.Statement.Context.Value("start").(time.Time))
		if elapsed > 100*time.Millisecond {
			log.Printf("Slow query: %s (%v)", d.Statement.SQL.String(), elapsed)
		}
	}
})
```

**What FAANG expects:** Profile before you optimize. The expected sequence is: enable query logging in a staging environment, reproduce the workload with realistic data volumes (not the dev seed fixture), capture `EXPLAIN (ANALYZE, BUFFERS)` on the slowest 5% of queries, and only then reach for indexes or query shape changes. Senior candidates mention specific pathologies: unbounded `IN (...)` lists that blow the plan cache, `OFFSET` pagination that reads all skipped rows and is replaced by keyset/cursor pagination at scale, missing composite indexes when the `WHERE` clause spans multiple columns, and connection pool sizing set to match `max_connections / (app_instances * 1.2)` rather than an arbitrary default.

**Follow-ups:**
- Your endpoint got slow at 10x traffic. Where do you look first? (Answer: pool exhaustion - check `pg_stat_activity` and pool wait time. Then query plan regression from stale stats. Then locks from long-running transactions.)
- Why is `OFFSET 100000 LIMIT 20` slow and what replaces it? (Answer: PostgreSQL still scans and discards the first 100k rows. Replace with keyset pagination: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20`.)
- How do you size a connection pool? (Answer: enough to saturate CPU-bound workers, not so many that you starve other services. Typical start is `2 * num_cores` per app instance, capped so total connections across instances stays below ~60% of `max_connections`. Measure pool wait time and tune from there.)

### Junior -> FAANG: Interview Entry Point and First-Job Framing

These five questions cover what an L3 or L4 interviewer actually scores. A junior candidate's failure mode is answering at the level of "GORM has `Preload` and sqlc generates code." A passing candidate names the tradeoff and gives one concrete example. An excelling candidate also names the failure mode they have personally seen.

Worked example, Question 1 at L3. Wrong answer: "sqlc is faster so I would pick it." Passing answer: "sqlc pushes SQL errors to compile time because it type-checks queries against the live schema, which catches column renames before deploy. GORM is faster to prototype because it infers the schema from structs. On my last project we used sqlc for the checkout path because a silent bug there costs money, and raw `database/sql` for an admin dashboard with freeform filters." The passing answer cites a decision, not a feature list.

Worked example, Question 2 at L4. Wrong answer: "use `Preload`." Passing answer: "N+1 is O(N) queries where one parent query should be two at most. I detect it with a query counter in integration tests or by watching request traces in Datadog. I fix it with `Preload` for simple has-one, a second `WHERE id IN (...)` plus in-memory join for has-many with wide parents, or a single JOIN when I need to filter on the child. The trap with `Preload` is forgetting it is two queries, so for deeply nested graphs it becomes N queries again across levels."

First-job context for Question 3. When you arrive at a team, ask three questions before touching migrations. Which tool does CI run (golang-migrate, goose, Atlas, Flyway)? Who owns the on-call for failed migrations? Is there a documented rollback procedure, or is "forward fix only" the policy? At most places under 100 engineers the answer to the third is "we hope nothing breaks." Your job at L3 is not to fix the culture, it is to not be the engineer who dropped the column the old pods still read from.

The "why did this fail?" reflex for interview questions. Every follow-up is probing whether you have operated the thing or only read about it. If you cannot describe what `pg_stat_activity` looks like during pool exhaustion, you have not operated the thing. Read the DBA documentation of whichever database your team uses before the interview. One afternoon of reading `pg_stat_*` views moves you from L3 to L4 on database questions.

### Senior @ FAANG: Signal Ladders and Bar-Raiser Questions for the Data Access Layer

At L5 and above the interview shifts from "solve this bug" to "design and govern the data access layer for a 100-engineer organization." The signal ladder for "design the data access layer" runs as follows.

L3 signal. Picks one tool and can write correct CRUD with context propagation and parameterized queries. Knows what a transaction is and can open one. Reads the SQL logs when something breaks. Does not know the difference between `READ COMMITTED` and `REPEATABLE READ` and that is fine at this level.

L4 signal. Picks the tool for the team's constraints. Writes a repository interface that does not leak ORM types. Understands N+1, opens transactions at the service layer, uses `WithContext`, knows the default isolation level of their database. Can explain why `SELECT *` is a latency tax on wide tables and why `OFFSET` pagination breaks at scale.

L5 signal. Designs the seam between domain and persistence for a service their team owns. Picks expand-contract for migrations and can walk through the five steps of a column rename without notes. Writes the shared `txutil.Run` helper with retry on `40001`. Reviews PRs with a context-propagation checklist. Owns the decision of optimistic vs pessimistic locking for their service and can defend it.

L6 signal. Designs the data access layer for a platform used by ten teams. Ships the golden-path repository template, the query-counting test middleware, the forbidden-hooks lint. Writes the ADR that pins transaction boundaries, locking strategy, and migration tooling across the org. Identifies that three teams have independently invented soft delete and drives consolidation to one shared implementation. Mentors L5s through the "why did this fail in prod" postmortem process.

L7 signal. Sets the multi-year strategy. Answers "should we migrate from GORM to sqlc across the 100-engineer org" with a capacity-planned migration, a codemod, a shadow-traffic validation step, a cost model, and a rollback plan. Negotiates with the DBA org on `max_connections` budgets across services. Writes the internal paper on why the future evolution of the data layer is codegen plus a thin typed query DSL, and recruits the two principal engineers who will build it. Owns the outcome when the bet is wrong.

Bar-raiser question 1. "You are a new tech lead at a 100-engineer shop. The codebase is 60% ActiveRecord-style GORM with hooks everywhere. You want to migrate to sqlc. Walk me through the first 90 days." A weak answer starts writing migration scripts. A strong answer starts by measuring: how many models, how many hooks, how many call sites, what is the test coverage, what is the on-call volume attributable to hooks. Then proposes a dual-stack period where new code is sqlc, hooks are frozen behind a lint, and existing models migrate in priority order driven by incident frequency. Then proposes the tooling investment (a codemod, a schema-diff check in CI, a shadow-read comparison harness) that makes the migration mechanical rather than per-engineer. Then proposes the kill criteria: at 80% sqlc coverage the remaining GORM gets a deprecation owner, at 95% the GORM dependency is removed from the go.mod of the monorepo.

Bar-raiser question 2. "Show me how you would detect N+1 in a million-line legacy codebase where integration tests are slow and query counting in tests is not an option." Strong answer: attach an OpenTelemetry tracer to the driver, sample 1% of production traffic, aggregate spans per request path, and alert when a path's p95 query count exceeds a baseline by 3x. Backfill with a one-time analysis that groups spans by handler and ranks by query count, then drives remediation from the top. The point of the question is not the mechanics, it is whether the candidate reaches for production observability rather than adding work to the test suite.

Bar-raiser question 3. "Multi-tenant SaaS with 10000 tenants in one database. ORM or query builder? Defend the choice." There is no right answer, but the defensible answers share a structure. State the tenancy model first (shared table with tenant_id, schema-per-tenant, database-per-tenant). State the blast radius tolerance (one tenant's bad query impacts all, or isolated). State the team's SQL literacy. Then pick. My default in 2026 is sqlc plus a `tenant_id` predicate enforced by a row-level security policy in PostgreSQL, because it makes the "forgot the tenant filter" bug impossible by construction. A candidate who picks GORM and cites the ability to dynamically scope queries via a session variable with `db.Scopes(WithTenant(id))` is also defensible if they acknowledge the RLS fallback for defense in depth.

Bar-raiser question 4. "Your ORM is fine. Your team loves it. Explain why you would ever replace it." The trap is answering "I would not." The strong answer: I would replace it when the ORM becomes the bottleneck on a goal that matters more than the team's comfort. Examples: compile-time schema validation blocks a compliance audit, reflection cost blocks a latency SLO, hook side effects block a read-replica rollout. The principle is that tool choice serves outcomes, and no tool is load-bearing enough to block an outcome the business has committed to.

Promotion signal. The ladder from L5 to L7 on this topic is the ladder from "I picked the right tool" to "I set the policy that lets 100 engineers pick the right tool without asking me." Interviewers listen for whether the candidate's answers scale past their own keyboard.

---
