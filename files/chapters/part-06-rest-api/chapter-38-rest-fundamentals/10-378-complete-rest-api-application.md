## 38.8 Complete REST API Application

Here's a production-ready REST API implementation with all the patterns discussed:

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
rest-api/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── api/
│   │   ├── handler/
│   │   │   ├── user.go
│   │   │   └── health.go
│   │   ├── middleware/
│   │   │   ├── logging.go
│   │   │   ├── recovery.go
│   │   │   ├── cors.go
│   │   │   └── requestid.go
│   │   ├── response/
│   │   │   └── json.go
│   │   └── router.go
│   ├── domain/
│   │   └── user.go
│   └── repository/
│       └── user.go
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### Main Application (cmd/server/main.go)

The entry point wires together configuration, database connection, and repository before constructing the HTTP server with explicit read, write, and idle timeouts. Signal handling with `os.Signal` ensures in-flight requests drain on SIGINT or SIGTERM before the process exits, preventing dropped connections during rolling deploys.

```go
// ... imports: context, database/sql, fmt, log/slog, net/http, os, os/signal, syscall, time
// internal/api, internal/api/handler, internal/repository, github.com/lib/pq

type Config struct {
    Port            int
    DatabaseURL     string
    ReadTimeout     time.Duration
    WriteTimeout    time.Duration
    IdleTimeout     time.Duration
    ShutdownTimeout time.Duration
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    config := Config{
        Port:            getEnvInt("PORT", 8080),
        DatabaseURL:     getEnv("DATABASE_URL", "postgres://localhost/api?sslmode=disable"),
        ReadTimeout:     10 * time.Second,
        WriteTimeout:    30 * time.Second,
        IdleTimeout:     60 * time.Second,
        ShutdownTimeout: 30 * time.Second,
    }

    if err := run(config, logger); err != nil {
        logger.Error("application error", "error", err)
        os.Exit(1)
    }
}

func run(config Config, logger *slog.Logger) error {
    // Database connection
    db, err := sql.Open("postgres", config.DatabaseURL)
    if err != nil {
        return fmt.Errorf("failed to open database: %w", err)
    }
    defer db.Close()

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(5 * time.Minute)

    if err := db.Ping(); err != nil {
        return fmt.Errorf("failed to ping database: %w", err)
    }

    // Initialize repositories
    userRepo := repository.NewUserRepository(db)

    // Initialize handlers
    userHandler := handler.NewUserHandler(userRepo, logger)
    healthHandler := handler.NewHealthHandler(db)

    // Setup router
    router := api.NewRouter(api.RouterConfig{
        Logger:        logger,
        UserHandler:   userHandler,
        HealthHandler: healthHandler,
    })

    // Create server
    server := &http.Server{
        Addr:         fmt.Sprintf(":%d", config.Port),
        Handler:      router,
        ReadTimeout:  config.ReadTimeout,
        WriteTimeout: config.WriteTimeout,
        IdleTimeout:  config.IdleTimeout,
    }

    // Graceful shutdown
    shutdownChan := make(chan error)
    go func() {
        sigChan := make(chan os.Signal, 1)
        signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
        sig := <-sigChan

        logger.Info("received shutdown signal", "signal", sig.String())

        ctx, cancel := context.WithTimeout(context.Background(), config.ShutdownTimeout)
        defer cancel()

        shutdownChan <- server.Shutdown(ctx)
    }()

    logger.Info("starting server", "port", config.Port)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        return fmt.Errorf("server error: %w", err)
    }

    return <-shutdownChan
}

func getEnv(key, defaultVal string) string {
    if val := os.Getenv(key); val != "" {
        return val
    }
    return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
    if val := os.Getenv(key); val != "" {
        var i int
        fmt.Sscanf(val, "%d", &i)
        return i
    }
    return defaultVal
}
```

### User Handler (internal/api/handler/user.go)

The handler function processes the incoming request, delegates to the service layer for business logic, and writes a structured response. Keeping handlers thin (parsing input, calling services, formatting output) separates HTTP concerns from domain logic.

```go
// ... imports omitted for brevity

type UserRepository interface {
    List(ctx context.Context, params domain.ListParams) ([]domain.User, int64, error)
    Get(ctx context.Context, id string) (*domain.User, error)
    Create(ctx context.Context, user *domain.User) error
    Update(ctx context.Context, user *domain.User) error
    Delete(ctx context.Context, id string) error
}

type UserHandler struct {
    repo   UserRepository
    logger *slog.Logger
}

func NewUserHandler(repo UserRepository, logger *slog.Logger) *UserHandler {
    return &UserHandler{
        repo:   repo,
        logger: logger,
    }
}

// List handles GET /users
func (h *UserHandler) List(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    params := domain.ListParams{
        Page:     parseQueryInt(r, "page", 1),
        PageSize: parseQueryInt(r, "page_size", 20),
        SortBy:   r.URL.Query().Get("sort_by"),
        Order:    r.URL.Query().Get("order"),
    }

    // Validate page size
    if params.PageSize > 100 {
        params.PageSize = 100
    }

    users, total, err := h.repo.List(ctx, params)
    if err != nil {
        h.logger.Error("failed to list users", "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to list users")
        return
    }

    response.JSON(w, http.StatusOK, response.Paginated{
        Data: users,
        Meta: response.Meta{
            Page:       params.Page,
            PageSize:   params.PageSize,
            TotalCount: total,
            TotalPages: (int(total) + params.PageSize - 1) / params.PageSize,
        },
        Links: response.Links{
            Self: r.URL.String(),
        },
    })
}

// Get handles GET /users/{id}
func (h *UserHandler) Get(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    id := r.PathValue("id")

    user, err := h.repo.Get(ctx, id)
    if err != nil {
        if errors.Is(err, domain.ErrNotFound) {
            response.Error(w, http.StatusNotFound, "NOT_FOUND", "User not found")
            return
        }
        h.logger.Error("failed to get user", "id", id, "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get user")
        return
    }

    response.JSON(w, http.StatusOK, response.Single{
        Data: user,
        Links: response.Links{
            Self:  "/api/v1/users/" + id,
            Posts: "/api/v1/users/" + id + "/posts",
        },
    })
}

// Create handles POST /users
func (h *UserHandler) Create(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    var input struct {
        Name  string `json:"name"`
        Email string `json:"email"`
    }

    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        response.Error(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
        return
    }

    // Validate input
    var validationErrors []response.FieldError
    if input.Name == "" {
        validationErrors = append(validationErrors, response.FieldError{
            Field:   "name",
            Code:    "REQUIRED",
            Message: "Name is required",
        })
    }
    if input.Email == "" {
        validationErrors = append(validationErrors, response.FieldError{
            Field:   "email",
            Code:    "REQUIRED",
            Message: "Email is required",
        })
    }

    if len(validationErrors) > 0 {
        response.ValidationError(w, validationErrors)
        return
    }

    user := &domain.User{
        Name:      input.Name,
        Email:     input.Email,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }

    if err := h.repo.Create(ctx, user); err != nil {
        if errors.Is(err, domain.ErrDuplicate) {
            response.Error(w, http.StatusConflict, "DUPLICATE", "Email already exists")
            return
        }
        h.logger.Error("failed to create user", "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to create user")
        return
    }

    w.Header().Set("Location", "/api/v1/users/"+user.ID)
    response.JSON(w, http.StatusCreated, response.Single{
        Data: user,
        Links: response.Links{
            Self: "/api/v1/users/" + user.ID,
        },
    })
}

// Update handles PATCH /users/{id}
func (h *UserHandler) Update(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    id := r.PathValue("id")

    // Get existing user
    user, err := h.repo.Get(ctx, id)
    if err != nil {
        if errors.Is(err, domain.ErrNotFound) {
            response.Error(w, http.StatusNotFound, "NOT_FOUND", "User not found")
            return
        }
        h.logger.Error("failed to get user", "id", id, "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get user")
        return
    }

    // Parse patch
    var patch map[string]any
    if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
        response.Error(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
        return
    }

    // Apply patch
    if name, ok := patch["name"].(string); ok {
        user.Name = name
    }
    if email, ok := patch["email"].(string); ok {
        user.Email = email
    }
    user.UpdatedAt = time.Now()

    if err := h.repo.Update(ctx, user); err != nil {
        h.logger.Error("failed to update user", "id", id, "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to update user")
        return
    }

    response.JSON(w, http.StatusOK, response.Single{
        Data: user,
    })
}

// Delete handles DELETE /users/{id}
func (h *UserHandler) Delete(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    id := r.PathValue("id")

    if err := h.repo.Delete(ctx, id); err != nil {
        if errors.Is(err, domain.ErrNotFound) {
            response.Error(w, http.StatusNotFound, "NOT_FOUND", "User not found")
            return
        }
        h.logger.Error("failed to delete user", "id", id, "error", err)
        response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to delete user")
        return
    }

    w.WriteHeader(http.StatusNoContent)
}

func parseQueryInt(r *http.Request, key string, defaultVal int) int {
    if val := r.URL.Query().Get(key); val != "" {
        if i, err := strconv.Atoi(val); err == nil {
            return i
        }
    }
    return defaultVal
}
```

### Response Package (internal/api/response/json.go)

The response package wraps all payloads in a `data` envelope so clients can distinguish single-resource and paginated responses without inspecting raw arrays. The `_links` field carries HATEOAS navigation URLs, enabling clients to discover related endpoints without hardcoding paths.

```go
// ... imports omitted for brevity (encoding/json, net/http)

type Single struct {
    Data  any `json:"data"`
    Links Links       `json:"_links,omitempty"`
}

type Paginated struct {
    Data  any `json:"data"`
    Meta  Meta        `json:"meta"`
    Links Links       `json:"_links,omitempty"`
}

type Meta struct {
    Page       int   `json:"page"`
    PageSize   int   `json:"page_size"`
    TotalCount int64 `json:"total_count"`
    TotalPages int   `json:"total_pages"`
}

type Links struct {
    Self  string `json:"self,omitempty"`
    Next  string `json:"next,omitempty"`
    Prev  string `json:"prev,omitempty"`
    Posts string `json:"posts,omitempty"`
}

type APIError struct {
    Status  int          `json:"status"`
    Code    string       `json:"code"`
    Message string       `json:"message"`
    Errors  []FieldError `json:"errors,omitempty"`
}

type FieldError struct {
    Field   string `json:"field"`
    Code    string `json:"code"`
    Message string `json:"message"`
}

func JSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    if data != nil {
        json.NewEncoder(w).Encode(data)
    }
}

func Error(w http.ResponseWriter, status int, code, message string) {
    JSON(w, status, APIError{
        Status:  status,
        Code:    code,
        Message: message,
    })
}

func ValidationError(w http.ResponseWriter, errors []FieldError) {
    JSON(w, http.StatusUnprocessableEntity, APIError{
        Status:  http.StatusUnprocessableEntity,
        Code:    "VALIDATION_ERROR",
        Message: "Validation failed",
        Errors:  errors,
    })
}
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server ./cmd/server

# Runtime stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/server .

# Create non-root user
RUN addgroup -g 1000 app && \
    adduser -u 1000 -G app -s /bin/sh -D app && \
    chown -R app:app /app

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["/app/server"]
```

### docker-compose.yml

The Compose file defines the API service and its PostgreSQL dependency as a single deployable unit. The `depends_on` condition ensures the database passes its health check before the API container starts, preventing connection errors on first boot. Volume mounting for `postgres_data` persists database state across container restarts.

```yaml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DATABASE_URL=postgres://api:api@postgres:5432/api?sslmode=disable
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: api
      POSTGRES_PASSWORD: api
      POSTGRES_DB: api
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U api -d api"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
.PHONY: build run test lint docker-build docker-up docker-down

APP_NAME := rest-api
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

build:
	go build -ldflags="-X main.version=$(VERSION)" -o bin/$(APP_NAME) ./cmd/server

run:
	go run ./cmd/server

test:
	go test -v -race -cover ./...

test-integration:
	go test -v -tags=integration ./...

lint:
	golangci-lint run

docker-build:
	docker build -t $(APP_NAME):$(VERSION) .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down -v

migrate-up:
	migrate -path ./migrations -database $(DATABASE_URL) up

migrate-down:
	migrate -path ./migrations -database $(DATABASE_URL) down

generate:
	go generate ./...

.DEFAULT_GOAL := build
```

### Junior → FAANG: complete REST API prerequisites

A complete REST API is where everything from the preceding sections collides with operational reality. The first deployment of a new service is where junior engineers learn what "production" actually means, and it is almost always about failure modes that do not appear in unit tests.

The `cmd/internal/pkg` layout shown above is the Go community convention and not a language requirement. `internal/` is enforced by the compiler (packages under `internal/` can only be imported by code rooted in the parent of that `internal/`), which prevents accidental public API creation. `cmd/` is convention for main packages. `pkg/` is convention for exported libraries and is controversial (many projects skip it and put public packages at the repo root). For a first job, follow whatever layout your team uses, do not rewrite it.

Worked example of a first-deployment incident. Your service runs locally, passes all tests, deploys to staging. The first production-like load test shows requests failing at the 30-second mark of every run. You look at the code above and spot it: `WriteTimeout: 30 * time.Second` on the http.Server. Slow endpoints and slow clients exceed the write window, the server closes the connection mid-response, the client sees partial responses. The fix is to either raise the write timeout or (better) move to per-handler timeouts via middleware so long-polling endpoints can have different limits from CRUD endpoints. This is the kind of thing you only learn by shipping.

Four things to memorize before your first on-call shift. (1) Graceful shutdown is not optional. Without it, a rolling deploy drops in-flight requests and your error budget evaporates. The signal-handling pattern above is the correct shape. (2) Database connection pool sizing (MaxOpenConns, MaxIdleConns, ConnMaxLifetime) is a production concern that requires measurement, not guessing. Start with MaxOpenConns matching your database's max_connections divided by instance count, with headroom. (3) Health checks need to distinguish liveness from readiness. Liveness asks "is this process alive" (returns 200 unless the process is so broken it should be killed). Readiness asks "is this process ready to serve traffic" (returns 503 during startup, during shutdown, and when dependencies are down). Kubernetes needs both. (4) Structured logging with slog is the standard library answer and it is good enough. Do not adopt zap or zerolog unless you have benchmarked a real bottleneck.

### Senior @ FAANG: complete REST API at staff and principal scope

The handler code above is textbook. The interesting engineering is everywhere except the handler. A staff review of this codebase before it goes to a tier-1 service would produce about 30 comments, clustered in seven areas.

First, architecture. The handler-to-repository flow in the code above is anemic: handlers talk directly to repositories with no service layer. For a CRUD-only API that is defensible because the service layer would be a passthrough. For any real API with business invariants (cross-aggregate consistency, email-uniqueness-plus-audit-event, charge-card-plus-issue-receipt), the service layer is mandatory. The hexagonal (ports-and-adapters) shape is handler -> service -> repository -> database, with each arrow going through an interface owned by the consumer (the service defines the repository interface it needs, not the repository). This keeps the service testable with a fake repository and keeps domain logic independent of SQL. When a senior engineer says "hexagonal" in a design review, this is what they mean.

Second, error mapping. The handlers above use a pattern of `errors.Is(err, domain.ErrNotFound)` to map domain errors to HTTP status codes. That is correct at small scale. At staff scope the pattern is a central `response.FromError(err)` function that inspects the error chain and produces the right status, code, and message. This concentrates the mapping in one place, makes it auditable, and lets you add logging of unmapped errors (anything that falls through to 500) so you can find them in dashboards. Pair it with error wrapping discipline: every error crossing a layer boundary is wrapped with `fmt.Errorf("loading user %s: %w", id, err)` so the final log line reads top-to-bottom like a stack trace.

Third, observability. The code uses `slog` directly in handlers. At scale that is wrong because the log lines do not carry trace IDs, span context, or request IDs automatically. The correct pattern is a context-aware logger: a middleware injects a logger with pre-bound fields (request_id, trace_id, route, user_id) into the context, handlers pull it out with a small custom helper (the stdlib slog deliberately ships no context accessor), and every log line in the request automatically carries the correlation fields. Combine with OpenTelemetry: the `otelhttp.NewHandler` wrapper around the router provides spans for every request, `otelsql` wraps database calls, and `otelhttp.NewTransport` wraps outgoing HTTP clients. The result is that a single trace ID stitches together the HTTP span, database spans, downstream RPC spans, and every log line, and you can pivot from a slow request in your tracing UI to the exact log lines in seconds.

Fourth, graceful shutdown at k8s scale. The `server.Shutdown(ctx)` pattern above is necessary but not sufficient. The full shape for a k8s-hosted service is: (1) Kubernetes sends SIGTERM. (2) The preStop hook sleeps for 5 to 10 seconds before SIGTERM fires, because kube-proxy takes time to remove the pod from the service endpoints and in-flight requests are still arriving. (3) The readiness probe flips to unhealthy immediately on SIGTERM so kube-proxy stops sending new traffic. (4) The server finishes in-flight requests up to the shutdown timeout. (5) The database connection pool closes cleanly. (6) Any background workers (outbox processors, cache warmers) stop and flush. The common bug is skipping step 2, which causes a small fraction of requests to hit a closing server and return connection-refused. The preStop hook is configured in the pod spec, not in Go code, and every staff engineer learns this the hard way on their first k8s rollout.

Fifth, timeouts and context propagation. The code sets server-level Read and Write timeouts but does not set a per-request deadline inside the handler. The correct pattern is a Timeout middleware at the router level (not a raw `http.TimeoutHandler`, see section 38.7) that puts a deadline on `r.Context()`, then every downstream call (database, cache, RPC) uses that context. The repository methods show the right shape by accepting `ctx context.Context` as the first argument. What they do not show is that `database/sql` honors context cancellation on query execution only after Go 1.8, and on connection acquisition only if the driver supports it (pgx does, lib/pq has gaps). For production PostgreSQL use pgx directly via `pgxpool`, not `database/sql` with lib/pq. This is a meaningful production difference.

Sixth, the Create handler has a TOCTOU race on email uniqueness. The sequence is: parse input, validate, insert. Two concurrent requests with the same email both pass validation, both try to insert, one gets a unique-constraint violation. The code handles it by mapping `domain.ErrDuplicate` to 409, which is correct. But the pattern to know at staff level is that business-rule enforcement should always land at the database via constraints, not in application code. Application code should validate for UX (return 422 with field errors on obvious mistakes), the database guarantees correctness (returns the duplicate-key error, which the application maps to 409). Any business rule that lives only in application code is a race condition waiting to happen when you scale to multiple instances.

Seventh, the PATCH handler uses a `map[string]any` for the patch body. That is flexible but wrong. It cannot distinguish "field omitted" from "field set to null" (JSON null becomes an `any` with value `nil`, which `.(string)` would not match, but the code also would not delete the field). It cannot validate types before application. It cannot produce a clean audit log of what changed. The staff-level pattern is an explicit patch struct with `*string` pointers (nil means omitted, non-nil means set, empty string means set to empty), validated before application, producing a changeset that flows to the service layer for auditing. For standards compliance use JSON Merge Patch (RFC 7396) or JSON Patch (RFC 6902), and pick one per API, never both.

Eighth, pin the Dockerfile base image to the exact minor version you are testing against (this book uses `golang:1.27.1-alpine`), rebuild monthly on the latest patch, and run `govulncheck` in CI to catch CVEs in your dependency tree. Also note that CGO_ENABLED=0 gives you a static binary with no glibc dependency, which is correct for alpine. If you ever switch to distroless (recommended over alpine for production because alpine ships shells, package managers, and busybox that you do not need at runtime), CGO_ENABLED=0 is mandatory.

Ninth, configuration. The `getEnv` helpers shown above parse environment variables ad hoc. At any non-trivial scale adopt `github.com/caarlos0/env/v11` or `github.com/kelseyhightower/envconfig` to get struct-based config with validation, defaults, and required-field enforcement. Twelve-factor-app compliance (config via environment) is correct, but the parsing layer should produce a fully-validated struct before the server starts so a misconfiguration fails fast rather than failing on the first request that happens to hit the unparsed field.

Tenth, testing. The full app needs three layers of tests. Unit tests per package with mocked dependencies. Integration tests that spin up PostgreSQL via testcontainers-go and exercise real SQL. Contract tests against the OpenAPI schema so the router and the documentation cannot drift. E2E tests in staging that run a synthetic user journey on every deploy. Unit tests are cheap and fast, integration tests are slow but catch the bugs that matter, E2E tests are expensive but are the only ones that exercise the deployment pipeline. A staff engineer budgets CI time roughly 60 percent unit, 30 percent integration, 10 percent E2E, and aggressively kills flaky tests rather than retrying them.

---
