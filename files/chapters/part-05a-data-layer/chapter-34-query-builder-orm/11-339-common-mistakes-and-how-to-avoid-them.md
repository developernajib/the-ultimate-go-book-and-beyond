## 34.9 Common Mistakes and How to Avoid Them

### Mistake 1: N+1 Queries with ORMs

The N+1 problem occurs when code fetches a list of records (1 query), then loads a related record for each item in a loop (N queries). With 100 orders, that is 101 database round trips instead of 1 or 2. GORM's `Preload` solves this with a second query using `WHERE id IN (...)`, and `Joins` inlines the association as a SQL JOIN for even tighter control.

```go
// WRONG: N+1 query problem
func getOrdersWithUsers(db *gorm.DB) ([]Order, error) {
	var orders []Order
	db.Find(&orders)

	for i := range orders {
		db.First(&orders[i].User, orders[i].UserID) // N additional queries!
	}
	return orders, nil
}

// CORRECT: Use eager loading
func getOrdersWithUsers(db *gorm.DB) ([]Order, error) {
	var orders []Order
	err := db.Preload("User").Find(&orders).Error // Two queries (orders, then users WHERE id IN ...), no N+1
	return orders, err
}

// EVEN BETTER: Use explicit join for control
func getOrdersWithUsers(db *gorm.DB) ([]Order, error) {
	var orders []Order
	err := db.
		Joins("User"). // SQL JOIN
		Select("orders.*, users.name as user_name").
		Find(&orders).Error
	return orders, err
}
```

### Mistake 2: Not Using Transactions in GORM

When multiple related writes must succeed or fail together, skipping a transaction leaves the database in an inconsistent state if any step fails. In the wrong example below, a failed item insert leaves an orphaned order. GORM's `db.Transaction` callback handles `Begin`, `Commit`, and `Rollback` automatically, return a non-nil error and the entire block rolls back.

```go
// WRONG: No transaction for related operations
func createOrderWithItems(db *gorm.DB, order *Order, items []OrderItem) error {
	if err := db.Create(order).Error; err != nil {
		return err
	}

	for _, item := range items {
		item.OrderID = order.ID
		if err := db.Create(&item).Error; err != nil {
			// Order exists but items don't - inconsistent state!
			return err
		}
	}
	return nil
}

// CORRECT: Use transaction
func createOrderWithItems(db *gorm.DB, order *Order, items []OrderItem) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(order).Error; err != nil {
			return err // Transaction rolls back
		}

		for i := range items {
			items[i].OrderID = order.ID
		}

		return tx.CreateInBatches(items, 100).Error
	})
}
```

### Mistake 3: Leaking ORM Types to Domain Layer

Embedding `gorm.Model` in your domain struct couples your business logic to GORM. Every package that imports the domain type now transitively depends on the ORM, and you cannot test business logic without GORM on the import path. The fix is to maintain separate domain and persistence models, with the repository handling conversion between them.

```go
// WRONG: Domain model has ORM dependencies
type User struct {
	gorm.Model  // GORM-specific!
	Name  string
	Email string
}

// CORRECT: Separate domain and persistence models
// Domain model
type User struct {
	ID    int64
	Name  string
	Email string
}

// Persistence model
type UserEntity struct {
	gorm.Model
	Name  string
	Email string
}

// Repository handles conversion
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	var entity UserEntity
	if err := r.db.First(&entity, id).Error; err != nil {
		return nil, err
	}
	return entityToUser(&entity), nil
}
```

### Mistake 4: SQL Injection with Query Builders

Query builders parameterize values automatically, but they do not parameterize identifiers like column names or table names. If you interpolate user input into `OrderBy`, `Select`, or table references, the query builder passes it through verbatim, creating a SQL injection vector. Always validate dynamic identifiers against a whitelist.

```go
// WRONG: String concatenation
func searchUsers(db *sql.DB, search string) ([]User, error) {
	query := fmt.Sprintf("SELECT * FROM users WHERE name LIKE '%%%s%%'", search)
	// SQL injection vulnerability!
	return db.Query(query)
}

// CORRECT: Use parameterized queries
func searchUsers(db *sql.DB, search string) ([]User, error) {
	sql, args, _ := sq.Select("*").
		From("users").
		Where(sq.ILike{"name": "%" + search + "%"}). // Properly escaped
		ToSql()

	return db.Query(sql, args...)
}
```

### Mistake 5: Ignoring Context in Database Operations

Without a context, a database query cannot be canceled when the HTTP request is aborted or a deadline expires. The query runs to completion on the database server, holding a connection from the pool. In GORM, `WithContext(ctx)` attaches the context to the underlying `database/sql` call. In raw SQL, use `QueryContext` and `ExecContext`.

```go
// WRONG: Ignoring context
func (r *UserRepository) GetByID(id int64) (*User, error) {
	var user User
	err := r.db.First(&user, id).Error // No context - can't be canceled
	return &user, err
}

// CORRECT: Always use context
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	var user User
	err := r.db.WithContext(ctx).First(&user, id).Error
	return &user, err
}
```

### Junior -> FAANG: Prerequisite Gaps and the "Why Did This Fail?" Reflex

If the five mistakes above feel abstract, you are missing prerequisites. Before trying to avoid the N+1 problem, you need to know what a query plan is, what a round trip costs (roughly 0.2ms intra-AZ, 2ms cross-AZ, 50ms cross-region in April 2026 AWS numbers), and how `EXPLAIN ANALYZE` reports rows touched. Before trying to scope a transaction correctly, you need to know the four ANSI isolation levels and which one your database defaults to (PostgreSQL defaults to `READ COMMITTED`, MySQL InnoDB to `REPEATABLE READ`). Before escaping identifiers by hand, you need to know why PostgreSQL's `quote_ident` function exists.

Worked example for a first-job engineer. You inherit an endpoint that times out under load. You run it locally with `GORM_LOG_LEVEL=info` and see 1 `SELECT FROM orders` followed by 247 `SELECT FROM users WHERE id = ?`. That is the N+1 signature. The fix is one line (`Preload("User")`), but the reflex you need to build is: when latency spikes, always check query count before reaching for cache or a bigger instance. Ninety percent of "the database is slow" tickets at L3 are N+1, missing index, or a transaction held open across an HTTP call.

The "why did this fail?" reflex has a fixed order. First, is the error from the driver, the ORM, or the database? `pq: duplicate key value` is the database. `sql: transaction has already been committed or rolled back` is the driver. `record not found` in GORM is the ORM wrapping `sql.ErrNoRows`. Second, did the context die? A canceled context surfaces as `context deadline exceeded` from `QueryContext`, not as a timeout from the database. Third, read the query the ORM actually sent. `db.Debug()` in GORM prints it. Most "ORM bug" reports are the engineer misreading what they told the ORM to do.

Interview entry point for L3 and L4. Expect "here is a handler that is slow, find the bug." The bug is almost always one of: N+1 in a loop, missing `WithContext`, transaction opened and never committed on an error path, or a `SELECT *` pulling a TOASTed column the caller does not use. Name the category out loud before you type. Interviewers score the diagnostic vocabulary, not the typing speed.

### Senior @ FAANG: Governance, Review Checklists, and ADRs for the Data Access Layer

At staff and principal level these mistakes stop being individual bugs and become governance problems. A single engineer writing an N+1 is a code review catch. A hundred engineers writing N+1s across fifty services is a platform failure, and the fix is mechanical enforcement, not education.

N+1 detection in CI. The 2026 toolchain gives three real options. First, static analysis over `sqlc`-generated code: because every query is a named Go function, a linter can flag call sites where a `FindX` is invoked inside a range loop over the result of another `FindX`. We ship this as a `go vet` shim in the monorepo. Second, runtime detection with an instrumented driver (`ngrok/sqlmw` or `XSAM/otelsql` with a custom middleware) that counts queries per request context and fails the test when the count exceeds a per-endpoint budget declared in a YAML file next to the handler. Third, for GORM shops, a GORM callback that records the stack trace of every query and asserts no two queries share a parent frame inside a loop. All three belong in CI, not in a wiki.

Forbidden GORM hooks policy. `BeforeSave`, `AfterFind`, and friends are a governance disaster at scale because they hide side effects that break batch operations, transaction retries, and read replicas. The ADR reads: hooks are banned except for three whitelisted cases (audit column population, soft-delete timestamp, tenant-id stamping), each implemented in a shared `platform/gormhooks` package with tests. A CI lint rejects any other `Before*`/`After*` method on a model type. Violations require an architecture review, not a PR comment.

Context propagation review checklist. Every data access PR gets this checklist from the bar raiser. First, every exported repository method takes `ctx context.Context` as the first argument. Second, every call into `database/sql`, GORM, or the query builder uses that context. Third, no goroutine spawned inside the handler uses `context.Background()` without a documented reason. Fourth, cancellation is tested with a unit test that cancels the parent context and asserts the query returns `context.Canceled` within 10ms. Checklist items one and two are enforced by `contextcheck` in `golangci-lint`. Items three and four are human review.

Transaction boundary ADR. The decision record pins three rules. First, transactions are opened at the service layer, never inside repositories, because repositories must be composable inside a larger unit of work. Second, transactions never span an outbound network call to a non-database service, because holding a row lock across a 200ms Kafka publish is how you deadlock a fleet. Third, retry on serialization failure (`40001`) is centralized in a `txutil.Run` helper with exponential backoff and a max of three attempts, and any business code that needs different semantics requires a waiver.

Optimistic vs pessimistic locking ADR. The default is optimistic via a `version` column and `UPDATE ... WHERE version = ?` returning `RowsAffected`. Pessimistic `SELECT FOR UPDATE` is allowed only for monetary transfers where double-spend is catastrophic, reservations against scarce inventory, or queue-drain patterns. The ADR requires a capacity estimate because `FOR UPDATE` serializes writers and caps throughput at one transaction per contested row per round-trip. At 1ms round trips that is 1000 TPS per row, which sounds like a lot until a single hot seller takes the checkout path.

Review discipline for identifier injection. The query builder's parameterization protects values, not identifiers. We ship a `safesort.Column` type that wraps a string and is constructed only through a whitelist-checking factory, and the query builder's `OrderBy` signature takes `safesort.Column` instead of `string`. This turns "remember to validate" into "the compiler forbids the mistake." The same technique covers dynamic table names for sharding and dynamic column sets for projection APIs.

Promotion signal. An L6 engineer catches these mistakes in review. An L7 eliminates the category by shipping the tool, the lint, the ADR, and the migration path that removes the footgun from the codebase. "I wrote a doc" is L5. "I wrote the analyzer that fails the build" is L7.

---
