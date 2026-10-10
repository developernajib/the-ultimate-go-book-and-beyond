## Section 2: Database Integration Testing

### 2.1 Test Containers for Real Database Testing

Testcontainers-go spins up a real Postgres (or any Docker image) container during `TestMain`, runs the test suite against it, and tears it down afterward, eliminating the behavioral gap between production database behavior and in-memory SQLite or mock substitutes. Real database tests catch issues that mocks miss: transaction isolation, index use, constraint violations, and driver-specific serialization edge cases. The test setup below uses testcontainers to start Postgres, applies the application's migration scripts to ensure schema parity, and exposes the DSN to all tests in the package.

```go
package dbintegration_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	_ "github.com/lib/pq"
)

// PostgresContainer manages a throwaway Postgres instance.
type PostgresContainer struct {
	container testcontainers.Container
	DSN       string
	DB        *sql.DB
}

// NewPostgresContainer spins up a Postgres container and applies schema.
func NewPostgresContainer(ctx context.Context, t *testing.T) *PostgresContainer {
	t.Helper()

	// testcontainers-go v0.42+ uses the module-level Run() function.
	// Earlier versions used RunContainer() - prefer Run() going forward.
	pgContainer, err := postgres.Run(ctx,
		"postgres:18-alpine",
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}

	t.Cleanup(func() {
		if err := pgContainer.Terminate(ctx); err != nil {
			t.Logf("terminate postgres: %v", err)
		}
	})

	dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("get connection string: %v", err)
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}

	// Apply schema
	if err := applySchema(ctx, db); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	return &PostgresContainer{
		container: pgContainer,
		DSN:       dsn,
		DB:        db,
	}
}

func applySchema(ctx context.Context, db *sql.DB) error {
	schema := `
		CREATE TABLE users (
			id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email       TEXT UNIQUE NOT NULL,
			name        TEXT NOT NULL,
			role        TEXT NOT NULL DEFAULT 'user',
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE TABLE orders (
			id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			status      TEXT NOT NULL DEFAULT 'pending',
			total_cents BIGINT NOT NULL,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE INDEX idx_orders_user_id ON orders(user_id);
		CREATE INDEX idx_orders_status ON orders(status);
	`
	_, err := db.ExecContext(ctx, schema)
	return err
}

// TestSuite bundles shared test infrastructure.
type TestSuite struct {
	DB  *sql.DB
	DSN string
}

// SetupTestSuite creates a shared database for a test suite. The container
// is torn down by the t.Cleanup registered in NewPostgresContainer.
func SetupTestSuite(t *testing.T) *TestSuite {
	t.Helper()
	ctx := context.Background()
	pg := NewPostgresContainer(ctx, t)
	return &TestSuite{DB: pg.DB, DSN: pg.DSN}
}
```

### 2.2 Transaction-Based Test Isolation

Wrapping each test in a database transaction that rolls back at the end gives every test a clean database state without the cost of truncating and re-seeding tables between tests. This approach requires that the code under test accepts a `*sql.Tx` or a DB abstraction interface so the test can inject the transaction. Repositories that open their own connections cannot participate in the outer test transaction. The pattern below shows a `RunInTx` helper that opens a transaction, hands it to the test body, and rolls back unconditionally in a deferred call. The rollback is deferred rather than run at the end of the function body on purpose: when the test body calls `t.Fatalf`, the runtime unwinds the goroutine and deferred calls still run, so the transaction is never left open.

```go
package dbintegration_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TxTestDB wraps a DB and provides automatic transaction rollback per test.
// Each test runs in its own transaction, ensuring complete isolation.
type TxTestDB struct {
	parent *sql.DB
}

// NewTxTestDB creates a wrapper that uses transactions for test isolation.
func NewTxTestDB(db *sql.DB) *TxTestDB {
	return &TxTestDB{parent: db}
}

// RunInTx runs fn in a transaction, rolling back after fn completes.
// This ensures tests never leave data behind.
func (t *TxTestDB) RunInTx(ctx context.Context, tb testing.TB, fn func(ctx context.Context, tx *sql.Tx)) {
	tb.Helper()
	tx, err := t.parent.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		tb.Fatalf("begin tx: %v", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			tb.Logf("rollback: %v", err)
		}
	}()
	fn(ctx, tx)
}

// UserRepository is the real repository under test.
type UserRepository struct {
	db interface {
		QueryRowContext(context.Context, string, ...any) *sql.Row
		ExecContext(context.Context, string, ...any) (sql.Result, error)
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	}
}

type User struct {
	ID        string
	Email     string
	Name      string
	Role      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (r *UserRepository) Create(ctx context.Context, email, name, role string) (*User, error) {
	var user User
	err := r.db.QueryRowContext(ctx,
		`INSERT INTO users (email, name, role)
		 VALUES ($1, $2, $3)
		 RETURNING id, email, name, role, created_at, updated_at`,
		email, name, role,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return &user, nil
}

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
	var user User
	err := r.db.QueryRowContext(ctx,
		`SELECT id, email, name, role, created_at, updated_at
		 FROM users WHERE email = $1`,
		email,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find user: %w", err)
	}
	return &user, nil
}

func (r *UserRepository) CountByRole(ctx context.Context, role string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users WHERE role = $1`, role,
	).Scan(&count)
	return count, err
}

// TestUserRepository_Integration tests the real repository against Postgres.
func TestUserRepository_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}

	ctx := context.Background()
	suite := SetupTestSuite(t)
	txDB := NewTxTestDB(suite.DB)

	t.Run("create and find user", func(t *testing.T) {
		txDB.RunInTx(ctx, t, func(ctx context.Context, tx *sql.Tx) {
			repo := &UserRepository{db: tx}

			created, err := repo.Create(ctx, "alice@example.com", "Alice", "admin")
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			if created.ID == "" {
				t.Error("expected non-empty ID")
			}

			found, err := repo.FindByEmail(ctx, "alice@example.com")
			if err != nil {
				t.Fatalf("find: %v", err)
			}
			if found == nil {
				t.Fatal("user not found")
			}
			if found.Name != "Alice" {
				t.Errorf("want Name=Alice, got %s", found.Name)
			}
			if found.Role != "admin" {
				t.Errorf("want Role=admin, got %s", found.Role)
			}
		})
	})

	t.Run("unique email constraint", func(t *testing.T) {
		txDB.RunInTx(ctx, t, func(ctx context.Context, tx *sql.Tx) {
			repo := &UserRepository{db: tx}

			_, err := repo.Create(ctx, "bob@example.com", "Bob", "user")
			if err != nil {
				t.Fatalf("first create: %v", err)
			}

			_, err = repo.Create(ctx, "bob@example.com", "Bob2", "user")
			if err == nil {
				t.Fatal("expected error for duplicate email")
			}
			if !strings.Contains(err.Error(), "unique") && !strings.Contains(err.Error(), "duplicate") {
				t.Errorf("unexpected error: %v", err)
			}
		})
	})

	t.Run("count by role returns accurate results", func(t *testing.T) {
		txDB.RunInTx(ctx, t, func(ctx context.Context, tx *sql.Tx) {
			repo := &UserRepository{db: tx}

			for i := 0; i < 5; i++ {
				_, err := repo.Create(ctx,
					fmt.Sprintf("user%d@example.com", i),
					fmt.Sprintf("User %d", i),
					"member",
				)
				if err != nil {
					t.Fatalf("create user %d: %v", i, err)
				}
			}

			count, err := repo.CountByRole(ctx, "member")
			if err != nil {
				t.Fatalf("count: %v", err)
			}
			if count != 5 {
				t.Errorf("want count=5, got %d", count)
			}
		})
	})
}
```

### 2.3 Test Data Builder Pattern

The test data builder pattern constructs realistic domain objects for tests using a fluent API that sets only the fields relevant to the test under examination and uses sensible defaults for everything else. This prevents tests from being polluted with irrelevant setup code and ensures that adding a required field to a domain type only requires updating the builder's default, not every test that constructs that type. The builders below use chained `With...` methods that each return the builder, so a test names only the fields it cares about. Randomized-but-unique defaults come from `math/rand/v2`, which is enough to keep the unique email constraint from colliding across tests. A library like `github.com/brianvoe/gofakeit/v7` is worth adding only when you need realistic-looking names and addresses, for example when test output doubles as a demo fixture.

These builders continue the `dbintegration_test` package from the previous listings, so they reuse the `User`, `Order`, and `UserRepository` declarations already defined there.

```go
package dbintegration_test

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"
)

// Order is the second domain type used by the scenario builders.
type Order struct {
	ID         string
	UserID     string
	Status     string
	TotalCents int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// UserBuilder constructs test users with sensible defaults.
type UserBuilder struct {
	email string
	name  string
	role  string
}

func NewUser() *UserBuilder {
	id := rand.IntN(999999)
	return &UserBuilder{
		email: fmt.Sprintf("user-%d@example.com", id),
		name:  fmt.Sprintf("Test User %d", id),
		role:  "user",
	}
}

func (b *UserBuilder) WithEmail(email string) *UserBuilder {
	b.email = email
	return b
}

func (b *UserBuilder) WithName(name string) *UserBuilder {
	b.name = name
	return b
}

func (b *UserBuilder) WithRole(role string) *UserBuilder {
	b.role = role
	return b
}

// Build inserts the user into the database and returns the created record.
func (b *UserBuilder) Build(ctx context.Context, db *sql.DB) (*User, error) {
	repo := &UserRepository{db: db}
	return repo.Create(ctx, b.email, b.name, b.role)
}

// MustBuild fails the test if the build fails, keeping test setup short.
func (b *UserBuilder) MustBuild(ctx context.Context, t testing.TB, db *sql.DB) *User {
	t.Helper()
	user, err := b.Build(ctx, db)
	if err != nil {
		t.Fatalf("build user: %v", err)
	}
	return user
}

// OrderBuilder constructs test orders.
type OrderBuilder struct {
	userID     string
	status     string
	totalCents int64
}

func NewOrder(userID string) *OrderBuilder {
	return &OrderBuilder{
		userID:     userID,
		status:     "pending",
		totalCents: 9999,
	}
}

func (b *OrderBuilder) WithStatus(status string) *OrderBuilder {
	b.status = status
	return b
}

func (b *OrderBuilder) WithTotalCents(totalCents int64) *OrderBuilder {
	b.totalCents = totalCents
	return b
}

func (b *OrderBuilder) MustBuild(ctx context.Context, t testing.TB, db *sql.DB) *Order {
	t.Helper()
	var order Order
	err := db.QueryRowContext(ctx,
		`INSERT INTO orders (user_id, status, total_cents)
		 VALUES ($1, $2, $3)
		 RETURNING id, user_id, status, total_cents, created_at, updated_at`,
		b.userID, b.status, b.totalCents,
	).Scan(&order.ID, &order.UserID, &order.Status, &order.TotalCents, &order.CreatedAt, &order.UpdatedAt)
	if err != nil {
		t.Fatalf("build order: %v", err)
	}
	return &order
}

// ScenarioBuilder creates complex multi-entity scenarios.
type ScenarioBuilder struct {
	db *sql.DB
}

type UserWithOrders struct {
	User   *User
	Orders []*Order
}

func NewScenarioBuilder(db *sql.DB) *ScenarioBuilder {
	return &ScenarioBuilder{db: db}
}

// AdminWithOrders creates an admin user with N orders in various states.
func (sb *ScenarioBuilder) AdminWithOrders(ctx context.Context, t testing.TB, n int) *UserWithOrders {
	t.Helper()
	user := NewUser().WithRole("admin").MustBuild(ctx, t, sb.db)

	statuses := []string{"pending", "processing", "completed", "failed"}
	orders := make([]*Order, n)
	for i := 0; i < n; i++ {
		orders[i] = NewOrder(user.ID).
			WithStatus(statuses[i%len(statuses)]).
			WithTotalCents(int64(i+1) * 1000).
			MustBuild(ctx, t, sb.db)
	}

	return &UserWithOrders{User: user, Orders: orders}
}
```

> **Senior track**: Transaction-based isolation is fast but does not catch bugs that depend on *committed* state, triggers that read via a second connection, `LISTEN/NOTIFY`, materialized views, replication lag, or cross-session advisory locks. For those, use schema-per-test (`CREATE SCHEMA test_<uuid>`) with a connection-pool setting that pins the search_path. Reuse a single testcontainers instance across the whole package via `TestMain`, and prefer `testcontainers-go` reuse (`TESTCONTAINERS_RYUK_DISABLED=true` plus a well-known container name) only on developer machines, never in CI where every build should be hermetic.

### 2.4 Schema fidelity: match production exactly

The most common failure mode in database integration testing is schema drift between test and production. A migration that runs cleanly in CI fails in production because the test environment was on Postgres 16 while production runs 18. A test that validates a query execution plan is meaningless if the test schema lacks the indexes that production has. Four fidelity rules to enforce. First, use the exact same Postgres/MySQL major version as production. Pin it in the testcontainers image tag, not a floating `latest`. Second, apply the exact same migrations as production, from the first migration forward, via your migration tool (`golang-migrate`, `goose`, `atlas`). Do not maintain a separate "test schema." Third, load representative data volumes for any test that measures performance or query plans. A 100-row test table exercises sequential scan, while production's 10-million-row table exercises index scan. Fourth, match production extensions and collations. A `citext` column that exists in production must exist in the test database. These four rules are the difference between integration tests that predict production behavior and integration tests that lie.

### 2.5 Junior → FAANG: the repository interface pattern

When you write a repository, always accept a narrow DB interface rather than `*sql.DB` directly:

```go
type DBTX interface {
    ExecContext(context.Context, string, ...any) (sql.Result, error)
    QueryContext(context.Context, string, ...any) (*sql.Rows, error)
    QueryRowContext(context.Context, string, ...any) *sql.Row
}

type UserRepository struct {
    db DBTX
}
```

This lets your tests inject either `*sql.DB`, `*sql.Tx`, or a mock. Transaction-based test isolation becomes trivial because the same repository code runs against a `*sql.Tx` in tests that a `*sql.DB` uses in production. This is a small interface discipline that pays back every time you write a test. Adopt it from day one of any project you start, and you will thank yourself for it on the first production incident that requires understanding transactional semantics.

### 2.6 Senior @ FAANG: the migration safety contract

At staff level, database migrations are a platform concern with a written safety contract. The contract: every migration runs in CI against a real database of production shape before merging. Every migration has a rollback path tested in CI. Every migration that adds a NOT NULL column on a large table must use a two-phase approach (add nullable, backfill, add constraint). Every migration that drops a column waits one release cycle to ensure no running code still references it. Every migration touching more than 1 million rows has a documented runtime estimate and a plan for long-running locks. Teams that codify and enforce this contract rarely cause migration-related incidents. Teams that do not ship the occasional migration that takes an outage. The staff-engineer artifact is the written contract, the CI checks that enforce it, and the post-incident updates when a new failure mode shows you something the contract missed.

---
