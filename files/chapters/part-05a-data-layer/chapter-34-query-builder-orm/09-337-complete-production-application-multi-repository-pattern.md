## 34.7 Complete Production Application: Multi-Repository Pattern

This section builds a complete application with three interchangeable repository implementations, sqlc, GORM, and raw SQL with squirrel, all satisfying the same `UserRepository` interface. The service layer depends only on the interface, so you can swap the data access strategy per deployment without changing business logic.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
multidb/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── database/
│   │   ├── postgres.go
│   │   └── queries/
│   │       └── users.sql
│   ├── repository/
│   │   ├── interface.go
│   │   ├── sqlc_repository.go
│   │   ├── gorm_repository.go
│   │   └── raw_repository.go
│   └── service/
│       └── user_service.go
├── sqlc.yaml
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

### Repository Interface (internal/repository/interface.go)

The interface definition below establishes the contract that all implementations must satisfy. Programming to this interface rather than a concrete type enables dependency injection, simplifies testing, and allows the implementation to be swapped without changing callers.

```go
package repository

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned when a requested entity does not exist
var ErrNotFound = errors.New("entity not found")

// User represents a user in the system
type User struct {
	ID        int64
	Email     string
	Name      string
	Status    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// UserFilter defines query filters
type UserFilter struct {
	Status       *string
	EmailPattern *string
	CreatedAfter *time.Time
	Limit        int
	Offset       int
	SortBy       string
	SortDir      string
}

// UserRepository defines user data access interface
type UserRepository interface {
	Create(ctx context.Context, user *User) error
	GetByID(ctx context.Context, id int64) (*User, error)
	GetByEmail(ctx context.Context, email string) (*User, error)
	List(ctx context.Context, filter UserFilter) ([]*User, int64, error)
	Update(ctx context.Context, user *User) error
	Delete(ctx context.Context, id int64) error
	BatchCreate(ctx context.Context, users []*User) error
}
```

### sqlc Implementation (internal/repository/sqlc_repository.go)

The repository implementation translates domain method calls into SQL queries, isolating the service layer from database-specific concerns. Each method accepts a context to propagate deadlines and cancellation into the query execution.

```go
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"multidb/internal/database/db"
)

// SQLCUserRepository implements UserRepository using sqlc
type SQLCUserRepository struct {
	queries *db.Queries
	pool    *sql.DB
}

// NewSQLCUserRepository creates a new sqlc-based repository
func NewSQLCUserRepository(pool *sql.DB) *SQLCUserRepository {
	return &SQLCUserRepository{
		queries: db.New(pool),
		pool:    pool,
	}
}

func (r *SQLCUserRepository) Create(ctx context.Context, user *User) error {
	result, err := r.queries.CreateUser(ctx, db.CreateUserParams{
		Email:  user.Email,
		Name:   user.Name,
		Status: user.Status,
	})
	if err != nil {
		return fmt.Errorf("creating user: %w", err)
	}

	user.ID = result.ID
	user.CreatedAt = result.CreatedAt
	user.UpdatedAt = result.UpdatedAt
	return nil
}

func (r *SQLCUserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	result, err := r.queries.GetUserByID(ctx, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("getting user: %w", err)
	}

	return &User{
		ID:        result.ID,
		Email:     result.Email,
		Name:      result.Name,
		Status:    result.Status,
		CreatedAt: result.CreatedAt,
		UpdatedAt: result.UpdatedAt,
	}, nil
}

func (r *SQLCUserRepository) GetByEmail(ctx context.Context, email string) (*User, error) {
	result, err := r.queries.GetUserByEmail(ctx, email)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("getting user by email: %w", err)
	}

	return dbUserToModel(result), nil
}

func (r *SQLCUserRepository) List(ctx context.Context, filter UserFilter) ([]*User, int64, error) {
	// sqlc works best with fixed queries, so we need multiple query variants
	// or fall back to raw SQL for dynamic filters

	status := "active"
	if filter.Status != nil {
		status = *filter.Status
	}

	limit := int32(filter.Limit)
	if limit <= 0 {
		limit = 20
	}

	results, err := r.queries.ListUsers(ctx, db.ListUsersParams{
		Status: status,
		Limit:  limit,
		Offset: int32(filter.Offset),
	})
	if err != nil {
		return nil, 0, fmt.Errorf("listing users: %w", err)
	}

	users := make([]*User, len(results))
	for i, result := range results {
		users[i] = dbUserToModel(result)
	}

	count, err := r.queries.CountUsersByStatus(ctx, status)
	if err != nil {
		return nil, 0, fmt.Errorf("counting users: %w", err)
	}

	return users, count, nil
}

func (r *SQLCUserRepository) Update(ctx context.Context, user *User) error {
	err := r.queries.UpdateUser(ctx, db.UpdateUserParams{
		ID:    user.ID,
		Name:  user.Name,
		Email: user.Email,
	})
	if err != nil {
		return fmt.Errorf("updating user: %w", err)
	}
	return nil
}

func (r *SQLCUserRepository) Delete(ctx context.Context, id int64) error {
	err := r.queries.DeleteUser(ctx, id)
	if err != nil {
		return fmt.Errorf("deleting user: %w", err)
	}
	return nil
}

func (r *SQLCUserRepository) BatchCreate(ctx context.Context, users []*User) error {
	// Use transaction for batch insert
	tx, err := r.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	qtx := r.queries.WithTx(tx)

	for _, user := range users {
		result, err := qtx.CreateUser(ctx, db.CreateUserParams{
			Email:  user.Email,
			Name:   user.Name,
			Status: user.Status,
		})
		if err != nil {
			return fmt.Errorf("creating user in batch: %w", err)
		}
		user.ID = result.ID
		user.CreatedAt = result.CreatedAt
		user.UpdatedAt = result.UpdatedAt
	}

	return tx.Commit()
}

func dbUserToModel(u db.User) *User {
	return &User{
		ID:        u.ID,
		Email:     u.Email,
		Name:      u.Name,
		Status:    u.Status,
		CreatedAt: u.CreatedAt,
		UpdatedAt: u.UpdatedAt,
	}
}
```

### GORM Implementation (internal/repository/gorm_repository.go)

The GORM implementation defines its own `GORMUser` persistence model with GORM struct tags and soft-delete support. Each method converts between the domain `User` and the GORM-specific `GORMUser`, keeping ORM types out of the service layer. GORM's `WithContext` propagates the caller's context into every query.

```go
package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// GORMUser is the GORM model
type GORMUser struct {
	ID        int64          `gorm:"primarykey"`
	Email     string         `gorm:"uniqueIndex;size:255;not null"`
	Name      string         `gorm:"size:255;not null"`
	Status    string         `gorm:"size:50;default:active"`
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}

func (GORMUser) TableName() string {
	return "users"
}

// GORMUserRepository implements UserRepository using GORM
type GORMUserRepository struct {
	db *gorm.DB
}

// NewGORMUserRepository creates a new GORM-based repository
func NewGORMUserRepository(db *gorm.DB) *GORMUserRepository {
	return &GORMUserRepository{db: db}
}

func (r *GORMUserRepository) Create(ctx context.Context, user *User) error {
	gormUser := &GORMUser{
		Email:  user.Email,
		Name:   user.Name,
		Status: user.Status,
	}

	if err := r.db.WithContext(ctx).Create(gormUser).Error; err != nil {
		return fmt.Errorf("creating user: %w", err)
	}

	user.ID = gormUser.ID
	user.CreatedAt = gormUser.CreatedAt
	user.UpdatedAt = gormUser.UpdatedAt
	return nil
}

func (r *GORMUserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	var gormUser GORMUser
	if err := r.db.WithContext(ctx).First(&gormUser, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("getting user: %w", err)
	}

	return gormUserToModel(&gormUser), nil
}

func (r *GORMUserRepository) GetByEmail(ctx context.Context, email string) (*User, error) {
	var gormUser GORMUser
	if err := r.db.WithContext(ctx).Where("email = ?", email).First(&gormUser).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("getting user by email: %w", err)
	}

	return gormUserToModel(&gormUser), nil
}

func (r *GORMUserRepository) List(ctx context.Context, filter UserFilter) ([]*User, int64, error) {
	query := r.db.WithContext(ctx).Model(&GORMUser{})

	// Apply filters dynamically
	if filter.Status != nil {
		query = query.Where("status = ?", *filter.Status)
	}

	if filter.EmailPattern != nil {
		query = query.Where("email ILIKE ?", "%"+*filter.EmailPattern+"%")
	}

	if filter.CreatedAfter != nil {
		query = query.Where("created_at > ?", *filter.CreatedAfter)
	}

	// Count total
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("counting users: %w", err)
	}

	// Apply sorting
	sortBy := "created_at"
	if filter.SortBy != "" {
		sortBy = filter.SortBy
	}
	sortDir := "DESC"
	if filter.SortDir == "asc" {
		sortDir = "ASC"
	}
	query = query.Order(fmt.Sprintf("%s %s", sortBy, sortDir))

	// Apply pagination
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	query = query.Limit(limit).Offset(filter.Offset)

	var gormUsers []GORMUser
	if err := query.Find(&gormUsers).Error; err != nil {
		return nil, 0, fmt.Errorf("listing users: %w", err)
	}

	users := make([]*User, len(gormUsers))
	for i := range gormUsers {
		users[i] = gormUserToModel(&gormUsers[i])
	}

	return users, total, nil
}

func (r *GORMUserRepository) Update(ctx context.Context, user *User) error {
	result := r.db.WithContext(ctx).Model(&GORMUser{}).
		Where("id = ?", user.ID).
		Updates(map[string]any{
			"email": user.Email,
			"name":  user.Name,
		})

	if result.Error != nil {
		return fmt.Errorf("updating user: %w", result.Error)
	}

	if result.RowsAffected == 0 {
		return ErrNotFound
	}

	return nil
}

func (r *GORMUserRepository) Delete(ctx context.Context, id int64) error {
	result := r.db.WithContext(ctx).Delete(&GORMUser{}, id)
	if result.Error != nil {
		return fmt.Errorf("deleting user: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *GORMUserRepository) BatchCreate(ctx context.Context, users []*User) error {
	gormUsers := make([]GORMUser, len(users))
	for i, u := range users {
		gormUsers[i] = GORMUser{
			Email:  u.Email,
			Name:   u.Name,
			Status: u.Status,
		}
	}

	if err := r.db.WithContext(ctx).CreateInBatches(gormUsers, 100).Error; err != nil {
		return fmt.Errorf("batch creating users: %w", err)
	}

	for i := range gormUsers {
		users[i].ID = gormUsers[i].ID
		users[i].CreatedAt = gormUsers[i].CreatedAt
		users[i].UpdatedAt = gormUsers[i].UpdatedAt
	}

	return nil
}

func gormUserToModel(u *GORMUser) *User {
	return &User{
		ID:        u.ID,
		Email:     u.Email,
		Name:      u.Name,
		Status:    u.Status,
		CreatedAt: u.CreatedAt,
		UpdatedAt: u.UpdatedAt,
	}
}
```

### Dynamic Query Builder with squirrel (internal/repository/raw_repository.go)

A query builder constructs SQL programmatically from typed method calls, providing compile-time checking of field names and preventing SQL injection without the overhead of a full ORM. Libraries like `Masterminds/squirrel` produce parameterized queries compatible with `database/sql`.

```go
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
)

// RawUserRepository implements UserRepository using raw SQL with squirrel
type RawUserRepository struct {
	db      *sql.DB
	builder sq.StatementBuilderType
}

// NewRawUserRepository creates a new raw SQL repository
func NewRawUserRepository(db *sql.DB) *RawUserRepository {
	return &RawUserRepository{
		db:      db,
		builder: sq.StatementBuilder.PlaceholderFormat(sq.Dollar),
	}
}

func (r *RawUserRepository) Create(ctx context.Context, user *User) error {
	now := time.Now().UTC()

	err := r.builder.
		Insert("users").
		Columns("email", "name", "status", "created_at", "updated_at").
		Values(user.Email, user.Name, user.Status, now, now).
		Suffix("RETURNING id").
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&user.ID)

	if err != nil {
		return fmt.Errorf("creating user: %w", err)
	}

	user.CreatedAt = now
	user.UpdatedAt = now
	return nil
}

func (r *RawUserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	var user User

	err := r.builder.
		Select("id", "email", "name", "status", "created_at", "updated_at").
		From("users").
		Where(sq.Eq{"id": id}).
		Where("deleted_at IS NULL").
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&user.ID, &user.Email, &user.Name, &user.Status, &user.CreatedAt, &user.UpdatedAt)

	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("getting user: %w", err)
	}

	return &user, nil
}

func (r *RawUserRepository) GetByEmail(ctx context.Context, email string) (*User, error) {
	var user User

	err := r.builder.
		Select("id", "email", "name", "status", "created_at", "updated_at").
		From("users").
		Where(sq.Eq{"email": email}).
		Where("deleted_at IS NULL").
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&user.ID, &user.Email, &user.Name, &user.Status, &user.CreatedAt, &user.UpdatedAt)

	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("getting user by email: %w", err)
	}

	return &user, nil
}

func (r *RawUserRepository) List(ctx context.Context, filter UserFilter) ([]*User, int64, error) {
	// Build base query
	baseQuery := r.builder.Select().From("users").Where("deleted_at IS NULL")

	// Apply filters
	if filter.Status != nil {
		baseQuery = baseQuery.Where(sq.Eq{"status": *filter.Status})
	}
	if filter.EmailPattern != nil {
		baseQuery = baseQuery.Where(sq.ILike{"email": "%" + *filter.EmailPattern + "%"})
	}
	if filter.CreatedAfter != nil {
		baseQuery = baseQuery.Where(sq.Gt{"created_at": *filter.CreatedAfter})
	}

	// Count query
	countQuery := baseQuery.Column("COUNT(*)")
	var total int64
	err := countQuery.RunWith(r.db).QueryRowContext(ctx).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("counting users: %w", err)
	}

	// Data query
	dataQuery := baseQuery.
		Columns("id", "email", "name", "status", "created_at", "updated_at")

	// Sorting
	sortBy := "created_at"
	if filter.SortBy != "" {
		// Whitelist allowed sort columns
		allowed := map[string]bool{"id": true, "email": true, "name": true, "created_at": true}
		if allowed[filter.SortBy] {
			sortBy = filter.SortBy
		}
	}
	sortDir := "DESC"
	if filter.SortDir == "asc" {
		sortDir = "ASC"
	}
	dataQuery = dataQuery.OrderBy(fmt.Sprintf("%s %s", sortBy, sortDir))

	// Pagination
	limit := uint64(filter.Limit)
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	dataQuery = dataQuery.Limit(limit).Offset(uint64(filter.Offset))

	rows, err := dataQuery.RunWith(r.db).QueryContext(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("listing users: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Email, &user.Name, &user.Status, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, 0, fmt.Errorf("scanning user: %w", err)
		}
		users = append(users, &user)
	}

	return users, total, rows.Err()
}

func (r *RawUserRepository) Update(ctx context.Context, user *User) error {
	result, err := r.builder.
		Update("users").
		Set("email", user.Email).
		Set("name", user.Name).
		Set("updated_at", time.Now().UTC()).
		Where(sq.Eq{"id": user.ID}).
		Where("deleted_at IS NULL").
		RunWith(r.db).
		ExecContext(ctx)

	if err != nil {
		return fmt.Errorf("updating user: %w", err)
	}

	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}

	return nil
}

func (r *RawUserRepository) Delete(ctx context.Context, id int64) error {
	// Soft delete
	result, err := r.builder.
		Update("users").
		Set("deleted_at", time.Now().UTC()).
		Where(sq.Eq{"id": id}).
		Where("deleted_at IS NULL").
		RunWith(r.db).
		ExecContext(ctx)

	if err != nil {
		return fmt.Errorf("deleting user: %w", err)
	}

	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}

	return nil
}

func (r *RawUserRepository) BatchCreate(ctx context.Context, users []*User) error {
	if len(users) == 0 {
		return nil
	}

	now := time.Now().UTC()
	insert := r.builder.
		Insert("users").
		Columns("email", "name", "status", "created_at", "updated_at")

	for _, user := range users {
		insert = insert.Values(user.Email, user.Name, user.Status, now, now)
	}

	insert = insert.Suffix("RETURNING id")

	rows, err := insert.RunWith(r.db).QueryContext(ctx)
	if err != nil {
		return fmt.Errorf("batch creating users: %w", err)
	}
	defer rows.Close()

	i := 0
	for rows.Next() {
		if err := rows.Scan(&users[i].ID); err != nil {
			return fmt.Errorf("scanning id: %w", err)
		}
		users[i].CreatedAt = now
		users[i].UpdatedAt = now
		i++
	}

	return rows.Err()
}
```

### Junior → FAANG: Why Three Implementations Behind One Interface

Your first reaction to this section might be "this is overkill, just pick one." That reaction is correct for a weekend project and wrong for a service your team will ship against for three years. The `UserRepository` interface is not about having three implementations at once. It is about being able to replace the one you have without rewriting the service layer. That replacement happens more often than juniors expect. You start on GORM because it was fast to prototype, hit a p99 wall at 10k rps, and migrate to sqlc in the next quarter. With the interface, that migration touches `repository/` only. Without it, the migration touches every handler.

First-job rule. The interface returns domain types (`*User`, `UserFilter`), never ORM types (`*gorm.DB`, `db.Queries`). If a reviewer sees `gorm.ErrRecordNotFound` in your service layer, you have leaked the abstraction and the whole pattern collapses. The `ErrNotFound` sentinel in the repository package is the translation layer. Every implementation maps its native "not found" error to `ErrNotFound` at the boundary.

Worked example for interviews. "Walk me through how you would add a Redis cache in front of this repository." The answer is the decorator pattern, not a new field on the struct. You write a `CachingUserRepository` that wraps any `UserRepository`, reads from Redis first, falls back to the inner repo on miss, and writes through on mutations. The service layer continues to depend on the interface and does not know a cache exists. If an interviewer hears "I would add a Redis client to the GORM repository," they know you do not yet think in layers. If they hear "I would add a decorator implementing the same interface," they know you do.

Context propagation. Every method on the interface takes `context.Context` as the first argument. That is not a style preference, it is a correctness requirement. Cancellation, deadlines, request-scoped values (tenant ID, trace ID), and transaction handles all travel through context. The first production incident juniors cause with this pattern is a background goroutine that calls the repository without a context and ignores the deadline, holding a DB connection open past a client timeout. Always pass the caller's context, never `context.Background()` from inside a request path.

### Senior @ FAANG: Hexagonal Ports, Unit of Work Without DI Frameworks, and Decorator Stacks

At staff level this section is where you establish the contract between the domain and everything outside it. The three pillars are hexagonal ports per aggregate, a context-carrying unit of work, and a decorator stack for cross-cutting concerns. Each has a canonical failure mode that ruins codebases, and each has a Go idiom that fixes it.

Hexagonal ports per aggregate. The common mistake is one giant `Repository` interface with 40 methods spanning users, orders, payments, and notifications. That is not hexagonal, that is a database god-object with a different name. The rule is one port per aggregate root. `UserRepository`, `OrderRepository`, `PaymentRepository`, each defined in the package that owns the aggregate (often `internal/user`, `internal/order`), with the implementations living in an adapter package (`internal/adapter/postgres`). The test for correctness is "can I delete the adapter package and still compile the domain package." If yes, the dependency arrow points the right way. If no, the domain depends on the infrastructure and you have a hexagonal violation. This is the single most common architecture mistake in mid-sized Go codebases and the one staff engineers should fix first.

Unit of Work in Go without a DI framework. Spring and .NET have unit-of-work baked in via their DI containers. Go does not, and that is fine, because Go has `context.Context` and explicit composition. The pattern is a `Tx` abstraction that carries a transaction handle through context:

```go
type txKey struct{}

func WithTx(ctx context.Context, tx *sql.Tx) context.Context {
    return context.WithValue(ctx, txKey{}, tx)
}

func fromCtx(ctx context.Context) (*sql.Tx, bool) {
    tx, ok := ctx.Value(txKey{}).(*sql.Tx)
    if ok { return tx, true }
    return nil, false
}
```

Each repository method does `db := r.pool; if tx, ok := fromCtx(ctx); ok { db = tx }` and proceeds. A `UnitOfWork` service method opens the tx, calls `WithTx(ctx, tx)`, passes the new context to every repository call, and commits or rolls back. No DI framework required, no ambient state, and the transaction scope is explicit in the call tree. This is how most sqlc-first Go shops do it in 2026. The anti-patterns to reject are (a) a `*gorm.DB` stored on the repository and mutated per request, which breaks concurrent safety, and (b) a thread-local style pattern with a global map keyed by goroutine ID, which is not even a real thing in Go.

Compile-time wiring. google/wire is the right default for this pattern because the wire generator emits a plain Go function that constructs `(pool, queries, repositories, services, handlers)` in the correct order with no reflection. Your `cmd/server/main.go` calls one function, `InitializeAPI(cfg)`, and gets back a fully wired app. When a new decorator enters the stack (a caching layer, a metrics layer), you edit the wire provider set and regenerate. For larger platforms, uber/fx with lifecycle hooks gives you OnStart/OnStop sugar that wire does not have, at the cost of runtime errors being less friendly. The ADR question is "is our service lifecycle complex enough to justify fx." For a stateless HTTP service, no. For a service with background workers, schedulers, and leader-elected singletons, yes.

Decorator pattern for repositories, fully spelled out. Three decorators are standard in a production Go service. First, a caching decorator that wraps the repo, caches `GetByID` and `GetByEmail` in Redis with a TTL, and invalidates on `Update` and `Delete`. The subtle part is cache consistency under transactions. If an update happens inside a tx that later rolls back, you must not have written to Redis. The fix is to defer cache writes until after commit, either by collecting them in a context-scoped buffer or by invalidating rather than writing through. Second, a metrics decorator that records per-method latency histograms and error counters into Prometheus. The counter labels are method name and error class, never error message (cardinality explosion). Third, an audit decorator that emits a structured log for every mutation with actor ID from context, entity type, entity ID, and before/after summary. This is the decorator that satisfies SOC 2 requirements on write operations. Stack order matters. From outside in: audit, metrics, cache, base. Audit sees the real caller intent, metrics sees cache hits as fast paths, cache reduces load on the base. Invert this order and you are caching audit log entries, which is wrong.

Transaction propagation ADR. Decide once per service whether nested transactions are allowed. Postgres and MySQL both support savepoints, but the semantics are subtle and most application-level code does not need them. My default recommendation is "transactions are opened at the service layer, repositories join the ambient tx if one exists in context, and no repository opens its own tx." This flat model is easier to reason about and easier to audit in review. The alternative, savepoint-based nesting, belongs only in frameworks that are explicitly modeling sagas or long-running workflows, in which case you probably want a real workflow engine (Temporal, Cadence) instead of nested tx.

Decorator interaction with context-carrying tx. The caching decorator must check for an ambient tx in context and skip the cache read if present, because a read inside a tx should see uncommitted writes from the same tx, not a stale cache entry. Same for the metrics decorator, which should record the tx state (inside-tx, outside-tx) as a label. Mis-layering this produces "why does my integration test see stale data" bugs that take a week to track down.

Testing the pattern. Because the service depends on the interface, your unit tests mock the interface with a handwritten struct that implements the methods (not gomock, which is overkill for 10 methods). Your integration tests run against a real Postgres (testcontainers-go) with the real sqlc implementation, exercising the full stack. Do not write integration tests against the GORM implementation if sqlc is your primary, because you are not actually testing the prod path. The anti-pattern to avoid is "we have 80% coverage" where every test runs through mocks and the adapter code is never exercised. Coverage on adapters is the coverage that matters, because that is where drivers, network, and SQL semantics live.

Final staff lesson. The multi-repository pattern is not about supporting multiple databases at once, it is about paying a small upfront cost (one interface file, one adapter package) to buy unlimited optionality on the data layer forever. Every team that skipped it and wrote directly against GORM paid for it later with a quarter-long migration. Every team that adopted it swapped ORMs over a weekend. That asymmetry is why this pattern is non-negotiable at FAANG scale.

---
