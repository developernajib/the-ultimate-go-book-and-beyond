export default `## 3.9 Complete Migration Project: REST API Service

This section builds a complete REST API service that demonstrates the patterns from this chapter, structured for production deployment.

### Project Structure

A well-structured Go project separates concerns across predictable directories, making it immediately navigable to any Go developer. The following layout follows the widely adopted convention for Go module organization.

\`\`\`
userservice/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── handler/
│   │   ├── handler.go
│   │   └── handler_test.go
│   ├── middleware/
│   │   ├── logging.go
│   │   ├── recovery.go
│   │   └── auth.go
│   ├── model/
│   │   └── user.go
│   ├── repository/
│   │   ├── repository.go
│   │   ├── postgres.go
│   │   └── postgres_test.go
│   └── service/
│       ├── user.go
│       └── user_test.go
├── pkg/
│   └── apierror/
│       └── error.go
├── migrations/
│   ├── 001_create_users.up.sql
│   └── 001_create_users.down.sql
├── go.mod
├── go.sum
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── .github/
    └── workflows/
        └── ci.yml
\`\`\`

### Main Application Entry Point

The application entry point wires together all components, configures the server, and handles graceful shutdown. This file should remain thin, delegating business logic to internal packages.

\`\`\`go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/yourorg/userservice/internal/config"
    "github.com/yourorg/userservice/internal/handler"
    "github.com/yourorg/userservice/internal/middleware"
    "github.com/yourorg/userservice/internal/repository"
    "github.com/yourorg/userservice/internal/service"

    "go.uber.org/zap"
)

func main() {
    // Initialize logger
    logger, err := zap.NewProduction()
    if err != nil {
        fmt.Fprintf(os.Stderr, "failed to create logger: %v\\n", err)
        os.Exit(1)
    }
    defer logger.Sync()

    // Load configuration
    cfg, err := config.Load()
    if err != nil {
        logger.Fatal("failed to load config", zap.Error(err))
    }

    // Initialize database
    db, err := repository.NewPostgresDB(cfg.DatabaseURL)
    if err != nil {
        logger.Fatal("failed to connect to database", zap.Error(err))
    }
    defer db.Close()

    // Initialize repository
    userRepo := repository.NewPostgresUserRepository(db)

    // Initialize service
    userService := service.NewUserService(userRepo, logger)

    // Initialize handler
    userHandler := handler.NewUserHandler(userService, logger)

    // Build router with middleware
    router := buildRouter(userHandler, logger, cfg)

    // Create server
    server := &http.Server{
        Addr:         fmt.Sprintf(":%d", cfg.Port),
        Handler:      router,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Start server in goroutine
    serverErrors := make(chan error, 1)
    go func() {
        logger.Info("starting server", zap.Int("port", cfg.Port))
        serverErrors <- server.ListenAndServe()
    }()

    // Wait for interrupt signal
    shutdown := make(chan os.Signal, 1)
    signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-serverErrors:
        logger.Fatal("server error", zap.Error(err))
    case sig := <-shutdown:
        logger.Info("shutdown signal received", zap.String("signal", sig.String()))

        // Give outstanding requests 30 seconds to complete
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        if err := server.Shutdown(ctx); err != nil {
            logger.Error("graceful shutdown failed", zap.Error(err))
            server.Close()
        }
    }

    logger.Info("server stopped")
}

func buildRouter(h *handler.UserHandler, logger *zap.Logger, cfg *config.Config) http.Handler {
    mux := http.NewServeMux()

    // Health check
    mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(\`{"status":"healthy"}\`))
    })

    // User endpoints
    mux.HandleFunc("GET /api/v1/users", h.ListUsers)
    mux.HandleFunc("GET /api/v1/users/{id}", h.GetUser)
    mux.HandleFunc("POST /api/v1/users", h.CreateUser)
    mux.HandleFunc("PUT /api/v1/users/{id}", h.UpdateUser)
    mux.HandleFunc("DELETE /api/v1/users/{id}", h.DeleteUser)

    // Apply middleware (inside-out)
    var handler http.Handler = mux
    handler = middleware.Recovery(handler, logger)
    handler = middleware.Logging(handler, logger)
    handler = middleware.RequestID(handler)

    return handler
}
\`\`\`

### Configuration

Configuration is loaded from environment variables at startup, following the twelve-factor app methodology. This allows the same binary to run in development, staging, and production without modification.

\`\`\`go
// internal/config/config.go
package config

import (
    "fmt"
    "os"
    "strconv"
)

type Config struct {
    Port        int
    DatabaseURL string
    LogLevel    string
    Environment string
}

func Load() (*Config, error) {
    port, err := strconv.Atoi(getEnv("PORT", "8080"))
    if err != nil {
        return nil, fmt.Errorf("invalid PORT: %w", err)
    }

    dbURL := getEnv("DATABASE_URL", "")
    if dbURL == "" {
        return nil, fmt.Errorf("DATABASE_URL is required")
    }

    return &Config{
        Port:        port,
        DatabaseURL: dbURL,
        LogLevel:    getEnv("LOG_LEVEL", "info"),
        Environment: getEnv("ENVIRONMENT", "development"),
    }, nil
}

func getEnv(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}
\`\`\`

### Domain Model

The domain model defines the core data types and business rules, independent of any persistence or transport layer. Keeping domain types pure ensures they can be tested in isolation.

\`\`\`go
// internal/model/user.go
package model

import (
    "time"
)

type User struct {
    ID        int64     \`json:"id" db:"id"\`
    Email     string    \`json:"email" db:"email"\`
    Name      string    \`json:"name" db:"name"\`
    CreatedAt time.Time \`json:"created_at" db:"created_at"\`
    UpdatedAt time.Time \`json:"updated_at" db:"updated_at"\`
}

type CreateUserRequest struct {
    Email string \`json:"email"\`
    Name  string \`json:"name"\`
}

func (r CreateUserRequest) Validate() error {
    if r.Email == "" {
        return &ValidationError{Field: "email", Message: "is required"}
    }
    if r.Name == "" {
        return &ValidationError{Field: "name", Message: "is required"}
    }
    return nil
}

type UpdateUserRequest struct {
    Name string \`json:"name"\`
}

func (r UpdateUserRequest) Validate() error {
    if r.Name == "" {
        return &ValidationError{Field: "name", Message: "is required"}
    }
    return nil
}

type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("%s %s", e.Field, e.Message)
}
\`\`\`

### Repository Layer

The repository layer abstracts data access behind an interface, decoupling service logic from the specific storage mechanism and making it straightforward to add caching layers.

\`\`\`go
// internal/repository/repository.go
package repository

import (
    "context"

    "github.com/yourorg/userservice/internal/model"
)

// UserRepository defines the interface for user data access
type UserRepository interface {
    GetByID(ctx context.Context, id int64) (*model.User, error)
    GetByEmail(ctx context.Context, email string) (*model.User, error)
    List(ctx context.Context, limit, offset int) ([]*model.User, error)
    Create(ctx context.Context, user *model.User) error
    Update(ctx context.Context, user *model.User) error
    Delete(ctx context.Context, id int64) error
}

var ErrNotFound = errors.New("not found")
var ErrDuplicate = errors.New("duplicate entry")
\`\`\`

The PostgreSQL implementation of this interface handles query execution, row scanning, and database-specific error mapping. It translates PostgreSQL error codes (like unique constraint violations) into the domain-level sentinel errors defined above:

\`\`\`go
// internal/repository/postgres.go
package repository

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "time"

    "github.com/lib/pq"
    "github.com/yourorg/userservice/internal/model"
)

type postgresUserRepository struct {
    db *sql.DB
}

func NewPostgresUserRepository(db *sql.DB) UserRepository {
    return &postgresUserRepository{db: db}
}

func (r *postgresUserRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
    query := \`SELECT id, email, name, created_at, updated_at FROM users WHERE id = \$1\`

    var user model.User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &user.ID, &user.Email, &user.Name, &user.CreatedAt, &user.UpdatedAt,
    )

    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("querying user by id: %w", err)
    }

    return &user, nil
}

func (r *postgresUserRepository) GetByEmail(ctx context.Context, email string) (*model.User, error) {
    query := \`SELECT id, email, name, created_at, updated_at FROM users WHERE email = \$1\`

    var user model.User
    err := r.db.QueryRowContext(ctx, query, email).Scan(
        &user.ID, &user.Email, &user.Name, &user.CreatedAt, &user.UpdatedAt,
    )

    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("querying user by email: %w", err)
    }

    return &user, nil
}

func (r *postgresUserRepository) List(ctx context.Context, limit, offset int) ([]*model.User, error) {
    query := \`SELECT id, email, name, created_at, updated_at FROM users ORDER BY id LIMIT \$1 OFFSET \$2\`

    rows, err := r.db.QueryContext(ctx, query, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("listing users: %w", err)
    }
    defer rows.Close()

    var users []*model.User
    for rows.Next() {
        var user model.User
        if err := rows.Scan(&user.ID, &user.Email, &user.Name, &user.CreatedAt, &user.UpdatedAt); err != nil {
            return nil, fmt.Errorf("scanning user row: %w", err)
        }
        users = append(users, &user)
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterating user rows: %w", err)
    }

    return users, nil
}

func (r *postgresUserRepository) Create(ctx context.Context, user *model.User) error {
    query := \`
        INSERT INTO users (email, name, created_at, updated_at)
        VALUES (\$1, \$2, \$3, \$4)
        RETURNING id
    \`

    now := time.Now()
    user.CreatedAt = now
    user.UpdatedAt = now

    err := r.db.QueryRowContext(ctx, query, user.Email, user.Name, user.CreatedAt, user.UpdatedAt).Scan(&user.ID)

    if err != nil {
        var pqErr *pq.Error
        if errors.As(err, &pqErr) && pqErr.Code == "23505" {
            return ErrDuplicate
        }
        return fmt.Errorf("creating user: %w", err)
    }

    return nil
}

func (r *postgresUserRepository) Update(ctx context.Context, user *model.User) error {
    query := \`UPDATE users SET name = \$1, updated_at = \$2 WHERE id = \$3\`

    user.UpdatedAt = time.Now()

    result, err := r.db.ExecContext(ctx, query, user.Name, user.UpdatedAt, user.ID)
    if err != nil {
        return fmt.Errorf("updating user: %w", err)
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("getting rows affected: %w", err)
    }

    if rowsAffected == 0 {
        return ErrNotFound
    }

    return nil
}

func (r *postgresUserRepository) Delete(ctx context.Context, id int64) error {
    query := \`DELETE FROM users WHERE id = \$1\`

    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("deleting user: %w", err)
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("getting rows affected: %w", err)
    }

    if rowsAffected == 0 {
        return ErrNotFound
    }

    return nil
}
\`\`\`

### Service Layer

The service layer encapsulates business logic and orchestrates calls to the repository and external systems. It depends on repository interfaces rather than concrete types, enabling clean unit testing with mocks.

\`\`\`go
// internal/service/user.go
package service

import (
    "context"
    "errors"
    "fmt"

    "github.com/yourorg/userservice/internal/model"
    "github.com/yourorg/userservice/internal/repository"
    "go.uber.org/zap"
)

type UserService struct {
    repo   repository.UserRepository
    logger *zap.Logger
}

func NewUserService(repo repository.UserRepository, logger *zap.Logger) *UserService {
    return &UserService{
        repo:   repo,
        logger: logger,
    }
}

func (s *UserService) GetUser(ctx context.Context, id int64) (*model.User, error) {
    user, err := s.repo.GetByID(ctx, id)
    if err != nil {
        if errors.Is(err, repository.ErrNotFound) {
            return nil, &NotFoundError{Resource: "user", ID: id}
        }
        return nil, fmt.Errorf("getting user: %w", err)
    }
    return user, nil
}

func (s *UserService) ListUsers(ctx context.Context, limit, offset int) ([]*model.User, error) {
    if limit <= 0 {
        limit = 20
    }
    if limit > 100 {
        limit = 100
    }

    users, err := s.repo.List(ctx, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("listing users: %w", err)
    }
    return users, nil
}

func (s *UserService) CreateUser(ctx context.Context, req model.CreateUserRequest) (*model.User, error) {
    if err := req.Validate(); err != nil {
        return nil, err
    }

    // Check if email already exists
    existing, err := s.repo.GetByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, repository.ErrNotFound) {
        return nil, fmt.Errorf("checking existing user: %w", err)
    }
    if existing != nil {
        return nil, &ConflictError{Resource: "user", Field: "email"}
    }

    user := &model.User{
        Email: req.Email,
        Name:  req.Name,
    }

    if err := s.repo.Create(ctx, user); err != nil {
        return nil, fmt.Errorf("creating user: %w", err)
    }

    s.logger.Info("user created",
        zap.Int64("user_id", user.ID),
        zap.String("email", user.Email),
    )

    return user, nil
}

func (s *UserService) UpdateUser(ctx context.Context, id int64, req model.UpdateUserRequest) (*model.User, error) {
    if err := req.Validate(); err != nil {
        return nil, err
    }

    user, err := s.repo.GetByID(ctx, id)
    if err != nil {
        if errors.Is(err, repository.ErrNotFound) {
            return nil, &NotFoundError{Resource: "user", ID: id}
        }
        return nil, fmt.Errorf("getting user: %w", err)
    }

    user.Name = req.Name

    if err := s.repo.Update(ctx, user); err != nil {
        return nil, fmt.Errorf("updating user: %w", err)
    }

    s.logger.Info("user updated",
        zap.Int64("user_id", user.ID),
    )

    return user, nil
}

func (s *UserService) DeleteUser(ctx context.Context, id int64) error {
    if err := s.repo.Delete(ctx, id); err != nil {
        if errors.Is(err, repository.ErrNotFound) {
            return &NotFoundError{Resource: "user", ID: id}
        }
        return fmt.Errorf("deleting user: %w", err)
    }

    s.logger.Info("user deleted", zap.Int64("user_id", id))
    return nil
}

// Service-level errors
type NotFoundError struct {
    Resource string
    ID       int64
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s with id %d not found", e.Resource, e.ID)
}

type ConflictError struct {
    Resource string
    Field    string
}

func (e *ConflictError) Error() string {
    return fmt.Sprintf("%s with this %s already exists", e.Resource, e.Field)
}
\`\`\`

### HTTP Handler

HTTP handlers translate between the transport layer and the domain model. They parse and validate incoming requests, delegate to the service layer, and encode responses.

\`\`\`go
// internal/handler/handler.go
package handler

import (
    "encoding/json"
    "errors"
    "net/http"
    "strconv"

    "github.com/yourorg/userservice/internal/model"
    "github.com/yourorg/userservice/internal/service"
    "go.uber.org/zap"
)

type UserHandler struct {
    service *service.UserService
    logger  *zap.Logger
}

func NewUserHandler(s *service.UserService, logger *zap.Logger) *UserHandler {
    return &UserHandler{service: s, logger: logger}
}

func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
    limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
    offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

    users, err := h.service.ListUsers(r.Context(), limit, offset)
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.respondJSON(w, http.StatusOK, users)
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id")
    id, err := strconv.ParseInt(idStr, 10, 64)
    if err != nil {
        h.respondError(w, http.StatusBadRequest, "invalid user id")
        return
    }

    user, err := h.service.GetUser(r.Context(), id)
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.respondJSON(w, http.StatusOK, user)
}

func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req model.CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    user, err := h.service.CreateUser(r.Context(), req)
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.respondJSON(w, http.StatusCreated, user)
}

func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id")
    id, err := strconv.ParseInt(idStr, 10, 64)
    if err != nil {
        h.respondError(w, http.StatusBadRequest, "invalid user id")
        return
    }

    var req model.UpdateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.respondError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    user, err := h.service.UpdateUser(r.Context(), id, req)
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.respondJSON(w, http.StatusOK, user)
}

func (h *UserHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id")
    id, err := strconv.ParseInt(idStr, 10, 64)
    if err != nil {
        h.respondError(w, http.StatusBadRequest, "invalid user id")
        return
    }

    if err := h.service.DeleteUser(r.Context(), id); err != nil {
        h.handleError(w, r, err)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}

func (h *UserHandler) handleError(w http.ResponseWriter, r *http.Request, err error) {
    var notFound *service.NotFoundError
    var conflict *service.ConflictError
    var validation *model.ValidationError

    switch {
    case errors.As(err, &notFound):
        h.respondError(w, http.StatusNotFound, err.Error())
    case errors.As(err, &conflict):
        h.respondError(w, http.StatusConflict, err.Error())
    case errors.As(err, &validation):
        h.respondError(w, http.StatusBadRequest, err.Error())
    default:
        h.logger.Error("internal error", zap.Error(err))
        h.respondError(w, http.StatusInternalServerError, "internal server error")
    }
}

func (h *UserHandler) respondJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func (h *UserHandler) respondError(w http.ResponseWriter, status int, message string) {
    h.respondJSON(w, status, map[string]string{"error": message})
}
\`\`\`

### Middleware

Middleware wraps HTTP handlers to provide cross-cutting concerns such as logging, authentication, and panic recovery without cluttering individual handler implementations.

\`\`\`go
// internal/middleware/logging.go
package middleware

import (
    "net/http"
    "time"

    "go.uber.org/zap"
)

func Logging(next http.Handler, logger *zap.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Wrap response writer to capture status code
        wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

        next.ServeHTTP(wrapped, r)

        logger.Info("request completed",
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.Int("status", wrapped.status),
            zap.Duration("duration", time.Since(start)),
            zap.String("remote_addr", r.RemoteAddr),
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}
\`\`\`

The recovery middleware catches panics from any handler in the chain, logs the stack trace, and returns a 500 response instead of crashing the process:

\`\`\`go
// internal/middleware/recovery.go
package middleware

import (
    "net/http"
    "runtime/debug"

    "go.uber.org/zap"
)

func Recovery(next http.Handler, logger *zap.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                logger.Error("panic recovered",
                    zap.Any("error", err),
                    zap.String("stack", string(debug.Stack())),
                )
                http.Error(w, "internal server error", http.StatusInternalServerError)
            }
        }()

        next.ServeHTTP(w, r)
    })
}
\`\`\`

### Dockerfile

The Dockerfile uses a multi-stage build to produce a minimal production image. The first stage compiles the binary with full build tooling. The final stage copies only the compiled binary into a scratch or distroless base.

\`\`\`dockerfile
# Dockerfile
# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /server ./cmd/server

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

COPY --from=builder /server .

# Non-root user
RUN adduser -D -g '' appuser
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["./server"]
\`\`\`

### Docker Compose

The Docker Compose configuration defines all services needed for local development, including the application, database, and any supporting infrastructure.

\`\`\`yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DATABASE_URL=postgres://postgres:postgres@db:5432/userservice?sslmode=disable
      - LOG_LEVEL=info
      - ENVIRONMENT=development
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=userservice
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
\`\`\`

### Makefile

The Makefile provides a standard set of development commands that wrap common Go toolchain operations, ensuring consistent behavior across developer machines and CI environments.

\`\`\`makefile
# Makefile
.PHONY: build run test lint clean docker-build docker-run migrate

# Go parameters
GOCMD=go
GOBUILD=\$(GOCMD) build
GOTEST=\$(GOCMD) test
GOGET=\$(GOCMD) get
GOMOD=\$(GOCMD) mod
BINARY_NAME=server

# Build the application
build:
	\$(GOBUILD) -o \$(BINARY_NAME) -v ./cmd/server

# Run the application
run: build
	./\$(BINARY_NAME)

# Run tests
test:
	\$(GOTEST) -v -race -coverprofile=coverage.out ./...

# Run tests with coverage report
test-coverage: test
	\$(GOCMD) tool cover -html=coverage.out -o coverage.html

# Run linter
lint:
	golangci-lint run ./...

# Clean build artifacts
clean:
	rm -f \$(BINARY_NAME)
	rm -f coverage.out coverage.html

# Download dependencies
deps:
	\$(GOMOD) download
	\$(GOMOD) tidy

# Build Docker image
docker-build:
	docker build -t userservice:latest .

# Run with Docker Compose
docker-run:
	docker-compose up --build

# Run database migrations
migrate-up:
	migrate -path migrations -database "\$(DATABASE_URL)" up

migrate-down:
	migrate -path migrations -database "\$(DATABASE_URL)" down

# Generate mocks
generate:
	go generate ./...

# Run all checks before commit
pre-commit: lint test
	@echo "All checks passed!"
\`\`\`

### GitHub Actions CI

The CI pipeline runs tests, linting, security scanning, and builds the Docker image on every push, providing rapid feedback on code quality.

\`\`\`yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: userservice_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26'

      - name: Download dependencies
        run: go mod download

      - name: Run linter
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

      - name: Run tests
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/userservice_test?sslmode=disable
        run: go test -v -race -coverprofile=coverage.out ./...

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage.out

  build:
    runs-on: ubuntu-latest
    needs: test

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26'

      - name: Build
        run: go build -v ./...

      - name: Build Docker image
        run: docker build -t userservice:\${{ github.sha }} .
\`\`\`

### Read the Project Like a Reviewer

The user-service project above is a strong starting point and not a finished production system. A staff reviewer at a Go-heavy org would flag at least the following before approving the migration to production. Working through these is the most efficient way to internalise the gap between "follows the patterns from the chapter" and "ready for the org's traffic".

1. **Structured logging.** The project uses \`zap\` because it was the de facto choice for years. In 2026 the standard library's \`log/slog\` (added in 1.21) is the default for new services, because it ships with the toolchain, integrates with \`context.Context\`, and removes one external dependency. The migration is mechanical and worth doing.
2. **Configuration handling.** The \`config.Load()\` function reads environment variables and returns an error. For real services you also want validation (port ranges, URL well-formedness), defaulting (sensible production defaults plus a separate development-mode override), and a way to dump the resolved config at startup for incident debugging. Look at \`kelseyhightower/envconfig\` or, increasingly, the \`viper\`-shaped libraries with explicit struct tags.
3. **Database connection pool tuning.** The \`repository.NewPostgresDB\` call hides the fact that the default \`database/sql\` connection pool settings are usually wrong for production. Set \`SetMaxOpenConns\`, \`SetMaxIdleConns\`, and \`SetConnMaxLifetime\` based on the database's connection budget and the service's expected concurrency. The right values are workload-specific. The wrong default is "leave it alone".
4. **Migrations are not run.** The Makefile includes \`migrate-up\` but the application does not run migrations on startup. Decide whether migrations are a CD concern (run before deploy) or an application concern (run at startup with a leader-election lock). Either is valid. Not deciding is the bug.
5. **Observability beyond logging.** Real services need metrics (RED: rate, errors, duration) and traces. Wire up \`prometheus/client_golang\` and \`go.opentelemetry.io/otel\` early, because retrofitting them after an incident is expensive.
6. **Authentication and authorization.** The middleware directory has an \`auth.go\` placeholder but no implementation. For an internal service, mTLS plus client identity is the typical answer. For a public service, JWTs plus scope checks plus rate limiting are the typical answer. Both deserve their own chapter.
7. **Pagination correctness.** The \`ListUsers\` handler uses limit-offset pagination, which is correct for small datasets and quietly wrong for large ones (deep offsets become slow as the table grows). Switch to keyset pagination when the table is expected to grow past the millions.
8. **JSON output discipline.** The handler writes JSON with \`json.NewEncoder(w).Encode(data)\`, which is fine until you need to set status codes precisely. The \`Encode\` call does not return until the encoder has finished writing, and any error that happens mid-write is unrecoverable because the status header has already been sent. For services that need precise error handling on serialisation, encode to a buffer first.
9. **Graceful shutdown timing.** The 30-second shutdown grace period is reasonable for most services. For long-running streaming endpoints, it is too short. For most idempotent request handlers, it is too long. Tune to the workload, and document the choice.

### How to Reproduce This From a Blank File (Mid-Level Track)

The single most useful exercise after reading this chapter is to delete the project and rewrite it from a blank \`cmd/server/main.go\`, with no reference. The first attempt will take six to eight hours and produce a project with several of the issues above unfixed. The second attempt, after consulting the book where you got stuck, will take three to four hours. By the third attempt, the project takes ninety minutes and the muscle memory of "wire repository to service to handler with explicit dependency injection, structured logging, graceful shutdown" is in your fingers. This is the level of fluency a Go-team mid-level interview at Google, Meta, or Stripe expects.

A useful variation when you reach the second or third pass: change the storage backend. Re-implement \`UserRepository\` against an in-memory map, against SQLite, against a HTTP-backed remote service. The interface stays the same, the test suite stays the same, only the implementation moves. The reflection on which abstractions held up and which leaked is the real teaching.

### How to Use This in Onboarding (Senior Track)

For a Go onboarding programme, the user-service project above is the right shape for a week-one capstone. Day one the new hire types \`cmd/server/main.go\` and gets the server running. Day two they add the repository and service layers. Day three they wire up the database. Day four they add tests and the CI pipeline. Day five they ship a real PR against the team's actual codebase, scoped to a single, reversible change. By the end of week one they have written the project from scratch, broken it, fixed it, and shipped real code.

The migration project also doubles as the team's reference implementation. When a junior engineer has a question about "how do we wire up dependency injection in this team?" or "what is our error-wrapping discipline?", the answer is "go read the user-service project and follow the patterns there". Maintaining one canonical reference implementation is the single highest-leverage thing a senior engineer can do for a team's internal consistency.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in any real-world version of this kind of service:

1. **A handler that does business logic.** When the handler is more than a thin parse-validate-call-encode wrapper, the business logic has leaked out of the service layer. The fix is to push the logic into the service and keep the handler trivial. Handlers should be testable through HTTP, services should be testable through their interface.
2. **An interface with a single implementation that is never mocked.** If \`UserRepository\` is implemented by \`postgresUserRepository\` only, and the tests use a real Postgres rather than a mock, the interface is dead weight. Either delete it (the service depends directly on the concrete type) or commit to a second implementation (in-memory for fast tests, real DB for integration tests). The half-and-half is the worst of both worlds.
3. **Errors that are not actionable at the call site.** The service layer wraps errors with \`fmt.Errorf("getting user: %w", err)\`. The handler then has to use \`errors.As\` to extract typed errors. The discipline is consistent and works, but it is fragile to refactoring. Document the contract at the package level, lint for it in CI.

---
`;
