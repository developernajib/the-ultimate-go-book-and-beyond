## 32.10 Complete Production Database Layer

This section assembles the patterns from earlier in the chapter into a complete, production-ready database layer that you can use as a foundation for any Go application.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
dbapp/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── database/
│   │   ├── database.go
│   │   ├── migrations.go
│   │   └── health.go
│   ├── model/
│   │   └── user.go
│   ├── repository/
│   │   ├── repository.go
│   │   └── user_repository.go
│   └── service/
│       └── user_service.go
├── migrations/
│   ├── 001_create_users.up.sql
│   └── 001_create_users.down.sql
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### Configuration (internal/config/config.go)

Configuration is expressed as a struct to provide compile-time type safety and enable validation at startup. Grouping all parameters in one place makes it easy to inject them from environment variables, config files, or command-line flags through a single construction path.

```go
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// DatabaseConfig holds database connection settings
type DatabaseConfig struct {
	Host            string
	Port            int
	User            string
	Password        string
	Database        string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// DSN returns the data source name for PostgreSQL
func (c *DatabaseConfig) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		c.Host, c.Port, c.User, c.Password, c.Database, c.SSLMode,
	)
}

// Load reads configuration from environment variables
func Load() (*DatabaseConfig, error) {
	port, err := strconv.Atoi(getEnv("DB_PORT", "5432"))
	if err != nil {
		return nil, fmt.Errorf("invalid DB_PORT: %w", err)
	}

	maxOpen, _ := strconv.Atoi(getEnv("DB_MAX_OPEN_CONNS", "25"))
	maxIdle, _ := strconv.Atoi(getEnv("DB_MAX_IDLE_CONNS", "5"))
	maxLifetime, _ := time.ParseDuration(getEnv("DB_CONN_MAX_LIFETIME", "5m"))
	maxIdleTime, _ := time.ParseDuration(getEnv("DB_CONN_MAX_IDLE_TIME", "1m"))

	return &DatabaseConfig{
		Host:            getEnv("DB_HOST", "localhost"),
		Port:            port,
		User:            getEnv("DB_USER", "postgres"),
		Password:        getEnv("DB_PASSWORD", ""),
		Database:        getEnv("DB_NAME", "app"),
		SSLMode:         getEnv("DB_SSLMODE", "disable"),
		MaxOpenConns:    maxOpen,
		MaxIdleConns:    maxIdle,
		ConnMaxLifetime: maxLifetime,
		ConnMaxIdleTime: maxIdleTime,
	}, nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
```

### Database Connection (internal/database/database.go)

The `DB` wrapper embeds `*sql.DB` and adds a structured logger, a transaction helper with panic recovery, and a retry loop for serialization failures. Calling `PingContext` during construction catches bad connection strings at startup rather than on the first user request.

```go
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"

	"dbapp/internal/config"
)

// DB wraps sql.DB with additional functionality
type DB struct {
	*sql.DB
	logger *slog.Logger
}

// New creates a new database connection pool
func New(cfg *config.DatabaseConfig, logger *slog.Logger) (*DB, error) {
	db, err := sql.Open("pgx", cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	logger.Info("database connected",
		"host", cfg.Host,
		"database", cfg.Database,
		"max_open_conns", cfg.MaxOpenConns,
	)

	return &DB{DB: db, logger: logger}, nil
}

// Close closes the database connection pool
func (db *DB) Close() error {
	db.logger.Info("closing database connection")
	return db.DB.Close()
}

// Transaction executes fn within a database transaction
func (db *DB) Transaction(ctx context.Context, opts *sql.TxOptions, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("rollback failed: %v (original error: %w)", rbErr, err)
		}
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}

// TransactionWithRetry executes fn with automatic retry on serialization failures
func (db *DB) TransactionWithRetry(ctx context.Context, maxRetries int, fn func(*sql.Tx) error) error {
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		err := db.Transaction(ctx, &sql.TxOptions{
			Isolation: sql.LevelSerializable,
		}, fn)

		if err == nil {
			return nil
		}

		if !isSerializationError(err) {
			return err
		}

		lastErr = err
		db.logger.Warn("serialization error, retrying",
			"attempt", attempt+1,
			"max_retries", maxRetries,
			"error", err,
		)

		// Exponential backoff with jitter
		backoff := time.Duration(1<<uint(attempt)) * 10 * time.Millisecond
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}

	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

func isSerializationError(err error) bool {
	// PostgreSQL error code for serialization_failure
	return err != nil && (
		containsErrorCode(err, "40001") || // serialization_failure
		containsErrorCode(err, "40P01"))   // deadlock_detected
}

func containsErrorCode(err error, code string) bool {
	if err == nil {
		return false
	}
	// Check for pgx PgError
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == code
	}
	return false
}
```

### Database Health (internal/database/health.go)

The health module exposes two capabilities: a point-in-time health check (ping latency plus pool statistics) for readiness probes, and a background monitoring loop that logs pool utilization on a fixed interval and warns when connections approach capacity.

```go
package database

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// HealthStatus represents database health information
type HealthStatus struct {
	Status          string        `json:"status"`
	Latency         time.Duration `json:"latency_ms"`
	OpenConnections int           `json:"open_connections"`
	InUse           int           `json:"in_use"`
	Idle            int           `json:"idle"`
	WaitCount       int64         `json:"wait_count"`
	WaitDuration    time.Duration `json:"wait_duration_ms"`
	MaxOpenConns    int           `json:"max_open_conns"`
	Error           string        `json:"error,omitempty"`
}

// Health performs a health check on the database
func (db *DB) Health(ctx context.Context) *HealthStatus {
	status := &HealthStatus{
		Status: "healthy",
	}

	// Measure ping latency
	start := time.Now()
	err := db.PingContext(ctx)
	status.Latency = time.Since(start)

	if err != nil {
		status.Status = "unhealthy"
		status.Error = err.Error()
	}

	// Get pool statistics
	stats := db.Stats()
	status.OpenConnections = stats.OpenConnections
	status.InUse = stats.InUse
	status.Idle = stats.Idle
	status.WaitCount = stats.WaitCount
	status.WaitDuration = stats.WaitDuration
	status.MaxOpenConns = stats.MaxOpenConns

	return status
}

// MonitorPool starts a background goroutine to monitor connection pool
func (db *DB) MonitorPool(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stats := db.Stats()
			db.logger.Info("database pool stats",
				"open_connections", stats.OpenConnections,
				"in_use", stats.InUse,
				"idle", stats.Idle,
				"wait_count", stats.WaitCount,
				"wait_duration", stats.WaitDuration,
				"max_idle_closed", stats.MaxIdleClosed,
				"max_lifetime_closed", stats.MaxLifetimeClosed,
			)

			// Alert if pool is near capacity
			utilization := float64(stats.InUse) / float64(stats.MaxOpenConns)
			if utilization > 0.8 {
				db.logger.Warn("database pool high utilization",
					"utilization", fmt.Sprintf("%.1f%%", utilization*100),
				)
			}
		}
	}
}

// JSON returns health status as JSON bytes
func (h *HealthStatus) JSON() []byte {
	data, _ := json.Marshal(h)
	return data
}
```

### Model (internal/model/user.go)

Domain models represent the core entities and value objects of the application. Keeping models free of framework annotations and database tags in the domain layer maintains a clean separation between business logic and infrastructure concerns.

```go
package model

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"
)

// User represents a user in the system
type User struct {
	ID        int64          `json:"id"`
	Email     string         `json:"email"`
	Name      string         `json:"name"`
	Status    string         `json:"status"`
	Metadata  JSONB          `json:"metadata,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt sql.NullTime   `json:"-"`
}

// IsActive returns true if the user account is active
func (u *User) IsActive() bool {
	return u.Status == "active" && !u.DeletedAt.Valid
}

// JSONB represents a PostgreSQL JSONB column
type JSONB map[string]any

// Scan implements sql.Scanner for JSONB
func (j *JSONB) Scan(value any) error {
	if value == nil {
		*j = nil
		return nil
	}

	bytes, ok := value.([]byte)
	if !ok {
		return fmt.Errorf("cannot scan %T into JSONB", value)
	}

	return json.Unmarshal(bytes, j)
}

// Value implements driver.Valuer for JSONB
func (j JSONB) Value() (driver.Value, error) {
	if j == nil {
		return nil, nil
	}
	return json.Marshal(j)
}

// UserFilter defines filters for user queries
type UserFilter struct {
	Status    *string
	Email     *string
	CreatedAfter *time.Time
	CreatedBefore *time.Time
	Limit     int
	Offset    int
}

// UserUpdate defines fields that can be updated
type UserUpdate struct {
	Name     *string
	Status   *string
	Metadata *JSONB
}
```

### Repository Interface (internal/repository/repository.go)

The interface definition below establishes the contract that all implementations must satisfy. Programming to this interface rather than a concrete type enables dependency injection, simplifies testing, and allows the implementation to be swapped without changing callers.

```go
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Common errors
var (
	ErrNotFound     = errors.New("record not found")
	ErrDuplicateKey = errors.New("duplicate key violation")
	ErrForeignKey   = errors.New("foreign key violation")
	ErrNullValue    = errors.New("null value violation")
)

// DBTX represents a database or transaction
type DBTX interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	PrepareContext(ctx context.Context, query string) (*sql.Stmt, error)
}

// HandleError converts database-specific errors to domain errors
func HandleError(err error) error {
	if err == nil {
		return nil
	}

	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}

	// Handle PostgreSQL specific errors
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return fmt.Errorf("%w: %s", ErrDuplicateKey, pgErr.Detail)
		case "23503": // foreign_key_violation
			return fmt.Errorf("%w: %s", ErrForeignKey, pgErr.Detail)
		case "23502": // not_null_violation
			return fmt.Errorf("%w: column %s", ErrNullValue, pgErr.ColumnName)
		}
	}

	return err
}
```

### User Repository (internal/repository/user_repository.go)

The repository implementation translates domain method calls into SQL queries, isolating the service layer from database-specific concerns. Each method accepts a context to propagate deadlines and cancellation into the query execution.

```go
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"dbapp/internal/model"
)

// UserRepository handles user data access
type UserRepository struct {
	db DBTX
}

// NewUserRepository creates a new user repository
func NewUserRepository(db DBTX) *UserRepository {
	return &UserRepository{db: db}
}

// WithTx returns a new repository using the given transaction
func (r *UserRepository) WithTx(tx *sql.Tx) *UserRepository {
	return &UserRepository{db: tx}
}

// Create inserts a new user
func (r *UserRepository) Create(ctx context.Context, user *model.User) error {
	query := `
		INSERT INTO users (email, name, status, metadata, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)
		RETURNING id
	`

	now := time.Now().UTC()
	err := r.db.QueryRowContext(ctx, query,
		user.Email,
		user.Name,
		user.Status,
		user.Metadata,
		now,
	).Scan(&user.ID)

	if err != nil {
		return HandleError(err)
	}

	user.CreatedAt = now
	user.UpdatedAt = now
	return nil
}

// GetByID retrieves a user by ID
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
	query := `
		SELECT id, email, name, status, metadata, created_at, updated_at, deleted_at
		FROM users
		WHERE id = $1 AND deleted_at IS NULL
	`

	var user model.User
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID,
		&user.Email,
		&user.Name,
		&user.Status,
		&user.Metadata,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.DeletedAt,
	)

	if err != nil {
		return nil, HandleError(err)
	}

	return &user, nil
}

// GetByEmail retrieves a user by email
func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	query := `
		SELECT id, email, name, status, metadata, created_at, updated_at, deleted_at
		FROM users
		WHERE email = $1 AND deleted_at IS NULL
	`

	var user model.User
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID,
		&user.Email,
		&user.Name,
		&user.Status,
		&user.Metadata,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.DeletedAt,
	)

	if err != nil {
		return nil, HandleError(err)
	}

	return &user, nil
}

// List retrieves users with filters
func (r *UserRepository) List(ctx context.Context, filter model.UserFilter) ([]*model.User, error) {
	var conditions []string
	var args []any
	argNum := 1

	conditions = append(conditions, "deleted_at IS NULL")

	if filter.Status != nil {
		conditions = append(conditions, fmt.Sprintf("status = $%d", argNum))
		args = append(args, *filter.Status)
		argNum++
	}

	if filter.Email != nil {
		conditions = append(conditions, fmt.Sprintf("email ILIKE $%d", argNum))
		args = append(args, "%"+*filter.Email+"%")
		argNum++
	}

	if filter.CreatedAfter != nil {
		conditions = append(conditions, fmt.Sprintf("created_at >= $%d", argNum))
		args = append(args, *filter.CreatedAfter)
		argNum++
	}

	if filter.CreatedBefore != nil {
		conditions = append(conditions, fmt.Sprintf("created_at < $%d", argNum))
		args = append(args, *filter.CreatedBefore)
		argNum++
	}

	query := fmt.Sprintf(`
		SELECT id, email, name, status, metadata, created_at, updated_at, deleted_at
		FROM users
		WHERE %s
		ORDER BY created_at DESC
		LIMIT $%d OFFSET $%d
	`, strings.Join(conditions, " AND "), argNum, argNum+1)

	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	args = append(args, limit, filter.Offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, HandleError(err)
	}
	defer rows.Close()

	var users []*model.User
	for rows.Next() {
		var user model.User
		if err := rows.Scan(
			&user.ID,
			&user.Email,
			&user.Name,
			&user.Status,
			&user.Metadata,
			&user.CreatedAt,
			&user.UpdatedAt,
			&user.DeletedAt,
		); err != nil {
			return nil, HandleError(err)
		}
		users = append(users, &user)
	}

	if err := rows.Err(); err != nil {
		return nil, HandleError(err)
	}

	return users, nil
}

// Update updates a user's fields
func (r *UserRepository) Update(ctx context.Context, id int64, update model.UserUpdate) error {
	var sets []string
	var args []any
	argNum := 1

	if update.Name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", argNum))
		args = append(args, *update.Name)
		argNum++
	}

	if update.Status != nil {
		sets = append(sets, fmt.Sprintf("status = $%d", argNum))
		args = append(args, *update.Status)
		argNum++
	}

	if update.Metadata != nil {
		sets = append(sets, fmt.Sprintf("metadata = $%d", argNum))
		args = append(args, *update.Metadata)
		argNum++
	}

	if len(sets) == 0 {
		return nil // Nothing to update
	}

	sets = append(sets, fmt.Sprintf("updated_at = $%d", argNum))
	args = append(args, time.Now().UTC())
	argNum++

	args = append(args, id)

	query := fmt.Sprintf(`
		UPDATE users
		SET %s
		WHERE id = $%d AND deleted_at IS NULL
	`, strings.Join(sets, ", "), argNum)

	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return HandleError(err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}

	if rowsAffected == 0 {
		return ErrNotFound
	}

	return nil
}

// Delete soft-deletes a user
func (r *UserRepository) Delete(ctx context.Context, id int64) error {
	query := `
		UPDATE users
		SET deleted_at = $1, updated_at = $1
		WHERE id = $2 AND deleted_at IS NULL
	`

	result, err := r.db.ExecContext(ctx, query, time.Now().UTC(), id)
	if err != nil {
		return HandleError(err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}

	if rowsAffected == 0 {
		return ErrNotFound
	}

	return nil
}

// HardDelete permanently deletes a user
func (r *UserRepository) HardDelete(ctx context.Context, id int64) error {
	query := `DELETE FROM users WHERE id = $1`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return HandleError(err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}

	if rowsAffected == 0 {
		return ErrNotFound
	}

	return nil
}

// Count returns the total number of users matching filter
func (r *UserRepository) Count(ctx context.Context, filter model.UserFilter) (int64, error) {
	var conditions []string
	var args []any
	argNum := 1

	conditions = append(conditions, "deleted_at IS NULL")

	if filter.Status != nil {
		conditions = append(conditions, fmt.Sprintf("status = $%d", argNum))
		args = append(args, *filter.Status)
		argNum++
	}

	query := fmt.Sprintf(`
		SELECT COUNT(*) FROM users WHERE %s
	`, strings.Join(conditions, " AND "))

	var count int64
	err := r.db.QueryRowContext(ctx, query, args...).Scan(&count)
	if err != nil {
		return 0, HandleError(err)
	}

	return count, nil
}

// BatchCreate inserts multiple users efficiently
func (r *UserRepository) BatchCreate(ctx context.Context, users []*model.User) error {
	if len(users) == 0 {
		return nil
	}

	// Build batch insert query
	var valueStrings []string
	var args []any

	now := time.Now().UTC()
	argNum := 1

	for _, user := range users {
		valueStrings = append(valueStrings,
			fmt.Sprintf("($%d, $%d, $%d, $%d, $%d, $%d)",
				argNum, argNum+1, argNum+2, argNum+3, argNum+4, argNum+5))
		args = append(args,
			user.Email,
			user.Name,
			user.Status,
			user.Metadata,
			now,
			now,
		)
		argNum += 6
	}

	query := fmt.Sprintf(`
		INSERT INTO users (email, name, status, metadata, created_at, updated_at)
		VALUES %s
		RETURNING id
	`, strings.Join(valueStrings, ", "))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return HandleError(err)
	}
	defer rows.Close()

	idx := 0
	for rows.Next() {
		if err := rows.Scan(&users[idx].ID); err != nil {
			return HandleError(err)
		}
		users[idx].CreatedAt = now
		users[idx].UpdatedAt = now
		idx++
	}

	return rows.Err()
}
```

### Main Application (cmd/server/main.go)

The entry point wires together configuration, database, repositories, and HTTP handlers. It starts pool monitoring in a background goroutine, registers routes using Go 1.22's method-based routing, and listens for OS signals to trigger a graceful shutdown that drains in-flight requests before closing the database.

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"dbapp/internal/config"
	"dbapp/internal/database"
	"dbapp/internal/model"
	"dbapp/internal/repository"
)

func main() {
	// Setup structured logging
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Connect to database
	db, err := database.New(cfg, logger)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Start pool monitoring
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go db.MonitorPool(ctx, 30*time.Second)

	// Create repositories
	userRepo := repository.NewUserRepository(db.DB)

	// Setup HTTP server
	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		status := db.Health(r.Context())
		w.Header().Set("Content-Type", "application/json")
		if status.Status != "healthy" {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		w.Write(status.JSON())
	})

	// User endpoints
	mux.HandleFunc("POST /users", createUserHandler(userRepo))
	mux.HandleFunc("GET /users/{id}", getUserHandler(userRepo))
	mux.HandleFunc("GET /users", listUsersHandler(userRepo))

	// Transaction example endpoint
	mux.HandleFunc("POST /users/batch", batchCreateHandler(db, userRepo))

	server := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		logger.Info("shutting down server")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("server shutdown error", "error", err)
		}
	}()

	logger.Info("starting server", "addr", server.Addr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}

func createUserHandler(repo *repository.UserRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		}

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		user := &model.User{
			Email:  input.Email,
			Name:   input.Name,
			Status: "active",
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		if err := repo.Create(ctx, user); err != nil {
			if err == repository.ErrDuplicateKey {
				http.Error(w, "email already exists", http.StatusConflict)
				return
			}
			slog.Error("failed to create user", "error", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(user)
	}
}

func getUserHandler(repo *repository.UserRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var userID int64
		fmt.Sscanf(id, "%d", &userID)

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		user, err := repo.GetByID(ctx, userID)
		if err != nil {
			if err == repository.ErrNotFound {
				http.Error(w, "user not found", http.StatusNotFound)
				return
			}
			slog.Error("failed to get user", "error", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}

func listUsersHandler(repo *repository.UserRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filter := model.UserFilter{
			Limit: 20,
		}

		if status := r.URL.Query().Get("status"); status != "" {
			filter.Status = &status
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		users, err := repo.List(ctx, filter)
		if err != nil {
			slog.Error("failed to list users", "error", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(users)
	}
}

func batchCreateHandler(db *database.DB, repo *repository.UserRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Users []struct {
				Email string `json:"email"`
				Name  string `json:"name"`
			} `json:"users"`
		}

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		var users []*model.User
		for _, u := range input.Users {
			users = append(users, &model.User{
				Email:  u.Email,
				Name:   u.Name,
				Status: "active",
			})
		}

		// Use transaction for batch insert
		err := db.Transaction(ctx, nil, func(tx *sql.Tx) error {
			txRepo := repo.WithTx(tx)
			return txRepo.BatchCreate(ctx, users)
		})

		if err != nil {
			slog.Error("failed to batch create users", "error", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(users)
	}
}
```

### Migrations (migrations/001_create_users.up.sql)

Schema migrations track the history of database changes as ordered, versioned scripts. A migration tool applies pending scripts in sequence and records their completion in a `schema_migrations` table, ensuring that each change is applied exactly once across all environments.

```sql
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for common queries
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_created_at ON users(created_at DESC) WHERE deleted_at IS NULL;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/server ./cmd/server

# Runtime image
FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/server .
COPY --from=builder /app/migrations ./migrations

EXPOSE 8080

ENTRYPOINT ["./server"]
```

### docker-compose.yml

The Compose file defines the application and its PostgreSQL dependency as co-located services. The `depends_on` condition with a health check ensures the database accepts connections before the application container starts. Mounting the migrations directory into the init script path lets PostgreSQL run the schema setup automatically on first boot.

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASSWORD: secret
      DB_NAME: app
      DB_SSLMODE: disable
      DB_MAX_OPEN_CONNS: 25
      DB_MAX_IDLE_CONNS: 5
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
.PHONY: build run test lint migrate docker-up docker-down

# Build the application
build:
	go build -o bin/server ./cmd/server

# Run locally
run:
	go run ./cmd/server

# Run tests
test:
	go test -v -race -cover ./...

# Run tests with coverage
test-coverage:
	go test -v -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

# Run linter
lint:
	golangci-lint run ./...

# Database migrations (requires golang-migrate)
migrate-up:
	migrate -path migrations -database "postgres://postgres:secret@localhost:5432/app?sslmode=disable" up

migrate-down:
	migrate -path migrations -database "postgres://postgres:secret@localhost:5432/app?sslmode=disable" down

# Docker commands
docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f app

# Generate mocks (requires mockgen)
mocks:
	mockgen -source=internal/repository/repository.go -destination=internal/repository/mocks/mock_repository.go

# Benchmark database operations
bench:
	go test -bench=. -benchmem ./internal/repository/...
```

### Junior → FAANG: What "Production Database Layer" Actually Means

A junior developer sees the reference layout above and thinks "that is a lot of folders for a CRUD app." The reason each folder exists is that production databases fail in ways a toy app never does, and the layout is defense in depth against those failure modes. The `config` package exists so the same binary runs in dev, staging, and prod without code changes. The `database` package exists so connection pooling, health, and transactions are one line to call and impossible to bypass. The `repository` package exists so you can write a unit test against the user service without a running Postgres. The `service` package exists so business rules are not smeared across HTTP handlers. First-job rule: if you are adding a feature, find the layer that already owns that concern and extend it, do not add it to the handler because the handler is nearest to hand. Interview entry point: "Walk me through a request from HTTP to Postgres and back, naming each layer it passes through and the reason that layer exists." A strong answer covers middleware (auth, request ID, timeout), handler (parse JSON, validate input), service (business rules, orchestration), repository (SQL, error mapping), `database/sql` pool (connection acquisition), driver (protocol encoding), network, Postgres. Juniors who can name each layer and its responsibility are ready for systems-level interviews.

A concrete junior pitfall hiding in the code above is the handler line `userRepo := repository.NewUserRepository(db.DB)` followed later by `repo.WithTx(tx)`. The `WithTx` pattern only works because both `*sql.DB` and `*sql.Tx` satisfy the `DBTX` interface. If you forget to use `WithTx` inside a transaction, your query runs outside the transaction silently, the row lock is not held, and concurrent writes corrupt data. Worked example the interview panel loves: "Why does this code produce inconsistent balances under load?" You point at the handler that opens a transaction then calls a bare repository method instead of a transactional one. The fix is either `WithTx` like here or a context-carrier pattern where the transaction travels in the context.Context and the repository pulls it out.

### Senior @ FAANG: Repository vs DAO vs Active Record, Observability Contracts, and DBM

Staff-level engineers defend a data-access pattern in an ADR, because the choice shapes testability, scaling, and hiring for years. The three mainstream options are Repository, Data Access Object (DAO), and Active Record. Repository (shown above) exposes domain-aligned methods like `GetByEmail` and `ListByStatus` and returns domain models, hiding the existence of SQL from callers. DAO is a thinner wrapper where each method maps one-to-one to a SQL statement and returns rows or record structs, common in Java shops and occasionally in Go codebases that use sqlc. Active Record puts persistence methods on the model itself (`user.Save()`, `user.Delete()`), common in Rails and GORM. In Go at scale, Repository wins for new systems because it keeps the domain model ignorant of persistence and enables interface-based mocking. DAO plus sqlc is a strong second choice when you have heavy SQL and want to avoid hand-written query builders. Active Record is actively discouraged at FAANG scale because it couples business rules to the ORM and makes N plus 1 queries trivial to write. The ADR you produce compares these on testability, query composability, transaction boundaries, performance ceiling, onboarding cost, and lock-in, and it names the concrete migration path if you ever need to switch. The decision is sticky because it shapes tens of thousands of call sites.

Observability contract is where a production database layer earns its keep. Every query gets a span with attributes `db.system = postgresql`, `db.statement` (normalized, with parameters redacted), `db.operation` (select, insert, update, delete), `db.sql.table`, `db.rows_affected`, and `db.duration_ms`. You emit four Prometheus metrics per query: a counter by `(operation, table, outcome)`, a histogram of duration by `(operation, table)` with sensible buckets (0.5, 1, 5, 10, 50, 100, 500, 1000ms), a gauge of `db_pool_in_use`, and a counter of `db_retries_total` by `(sqlstate)`. Slow-query logs fire at a threshold (often 100ms for OLTP) and include the full redacted query plus the span context so a trace ID correlates the slow log to the upstream request. You sample `pg_stat_statements` every 60 seconds into a time-series store so you see query-fingerprint-level regressions over time, and Datadog Database Monitoring, Honeycomb, or OpenTelemetry Postgres receiver closes the loop by ingesting `pg_stat_activity` and `pg_stat_statements` directly. The principal-level deliverable is the SLO doc that names four user-visible SLIs (request success rate, p95 latency, p99 latency, freshness for read replicas) and maps each to the database metrics that predict SLO burn.

Read-replica failover orchestration is the next staff-level topic. The production layer above talks to a single `*sql.DB` which hides whether you are hitting a primary or a replica. At scale you need at minimum two pools, one for writes (primary) and one for reads (replica fleet behind a load balancer or round-robin selector), with a policy that routes each query by role. Reads that must see their own writes (read-after-write) route to the primary, typically for a configurable TTL after a write like 500ms. Reads tolerant of a few hundred milliseconds of lag route to replicas. The failure mode you design for is replica lag exceeding a threshold (commonly 10 seconds of `pg_last_wal_receive_lsn` vs primary), at which point the read pool pulls that replica out of rotation and optionally trips a breaker that routes reads to the primary with a degraded-mode flag surfaced in responses. On primary failover you rely on the managed service (RDS, Cloud SQL, Aurora) to swing DNS, and your driver must re-resolve DNS on reconnection. pgx does this correctly, but stale DNS caching at the OS or container level is a classic incident cause, so you set a short TTL and verify that `GODEBUG=netdns=go+1` uses the Go resolver which respects TTL, rather than the cgo resolver which can cache indefinitely.

A principal deep cut is the load-shedding contract at pool exhaustion. The code above uses `SetMaxOpenConns(25)` and blocks on `WaitCount` with no explicit pool-wait budget, meaning under spike the request holds its HTTP timeout waiting for a connection. The production pattern is a tiered context: outer request deadline from the HTTP handler (5 seconds say), inner pool-acquire deadline (50ms say) enforced with `context.WithTimeout` just around `BeginTx` or `QueryContext`. When pool-acquire times out you return 503 with `Retry-After: 1` and a metric label `shed_reason=pool_exhausted`, which signals the load balancer to back off and preserves capacity for requests already in flight. Combine this with an outer circuit breaker per database role and you get graceful degradation instead of a uniform incident when the database is slow. This is the kind of detail that turns a senior project into a staff-level artifact, because the operational behavior under stress is designed rather than emergent.

Finally, the migration and rollout story. Schema migrations go out in two phases for every change: expand (add new column, dual-write, backfill) then contract (read from new column only, drop old column). The reason is that a rolling deploy runs old code and new code side by side for minutes to hours, so any migration that deletes or renames a column that old code reads produces errors for that window. The production layer above uses `golang-migrate` one-shot migrations which are fine for development but insufficient for zero-downtime production rollouts. The staff upgrade is a migration process that gates each migration on a feature flag, runs the expand step, waits for the new code to fully roll out, then runs the contract step in a later deploy. Write this up as a runbook, practice it in staging, and include it in the ADR.

---
