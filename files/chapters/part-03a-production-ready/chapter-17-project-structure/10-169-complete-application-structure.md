## 17.9 Complete Application Structure

The following directory tree shows a complete production-ready project structure for an e-commerce API. It combines every pattern covered in this chapter: the community layout, feature-based organization, dependency injection, configuration management, and a layered test setup. It is deliberately maximal, so read it as a reference rather than a starting point. A new service should grow into this, not begin here.

```
ecommerce-api/
├── cmd/
│   ├── api/
│   │   └── main.go
│   ├── worker/
│   │   └── main.go
│   └── migrate/
│       └── main.go
├── internal/
│   ├── api/
│   │   ├── handler/
│   │   │   ├── product.go
│   │   │   ├── order.go
│   │   │   └── user.go
│   │   ├── middleware/
│   │   │   ├── auth.go
│   │   │   ├── logging.go
│   │   │   ├── recovery.go
│   │   │   └── ratelimit.go
│   │   ├── router.go
│   │   └── server.go
│   ├── domain/
│   │   ├── product/
│   │   │   ├── model.go
│   │   │   ├── repository.go
│   │   │   ├── service.go
│   │   │   └── errors.go
│   │   ├── order/
│   │   │   ├── model.go
│   │   │   ├── repository.go
│   │   │   ├── service.go
│   │   │   └── errors.go
│   │   └── user/
│   │       ├── model.go
│   │       ├── repository.go
│   │       ├── service.go
│   │       └── errors.go
│   ├── platform/
│   │   ├── postgres/
│   │   │   ├── client.go
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   ├── redis/
│   │   │   └── client.go
│   │   ├── stripe/
│   │   │   └── client.go
│   │   └── email/
│   │       └── sendgrid.go
│   ├── config/
│   │   └── config.go
│   └── testutil/
│       ├── db.go
│       ├── fixtures.go
│       └── mocks/
├── pkg/
│   ├── validator/
│   │   └── validator.go
│   └── httputil/
│       └── response.go
├── api/
│   └── openapi.yaml
├── configs/
│   ├── config.yaml
│   ├── config.dev.yaml
│   └── config.prod.yaml
├── deployments/
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── kubernetes/
│       ├── deployment.yaml
│       ├── service.yaml
│       └── configmap.yaml
├── scripts/
│   ├── setup.sh
│   ├── migrate.sh
│   └── seed.sh
├── test/
│   ├── integration/
│   │   └── api_test.go
│   └── e2e/
│       └── checkout_test.go
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

### Main Entry Point

The `cmd/api/main.go` file is responsible for wiring the entire application together: loading configuration, establishing database and cache connections, constructing repositories and services, and handing control to the HTTP server. It also installs an OS signal handler to trigger graceful shutdown, so in-flight requests complete before the process exits.

Use `signal.NotifyContext` rather than hand-rolling a channel and a goroutine. The hand-rolled version calls `signal.Notify` inside the goroutine, which leaves a window between `main` starting the server and the goroutine actually registering the handler. A signal arriving in that window hits Go's default disposition and kills the process outright, with no graceful drain. The window is small, but a Kubernetes rollout that sends SIGTERM to a pod seconds after start will find it. `NotifyContext` registers before `Run` is ever called and collapses the whole block to two lines.

```go
// cmd/api/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "github.com/mycompany/ecommerce-api/internal/api"
    "github.com/mycompany/ecommerce-api/internal/config"
    "github.com/mycompany/ecommerce-api/internal/domain/order"
    "github.com/mycompany/ecommerce-api/internal/domain/product"
    "github.com/mycompany/ecommerce-api/internal/domain/user"
    "github.com/mycompany/ecommerce-api/internal/platform/postgres"
    "github.com/mycompany/ecommerce-api/internal/platform/redis"
    "github.com/mycompany/ecommerce-api/internal/platform/stripe"
)

var (
    version   = "dev"
    buildTime = "unknown"
)

func main() {
    // Setup structured logging
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    logger.Info("starting application",
        "version", version,
        "build_time", buildTime,
    )

    // Load configuration
    cfg, err := config.Load()
    if err != nil {
        logger.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    // Initialize dependencies
    db, err := postgres.Connect(cfg.Database)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    cache, err := redis.Connect(cfg.Redis)
    if err != nil {
        logger.Error("failed to connect to redis", "error", err)
        os.Exit(1)
    }
    defer cache.Close()

    stripeClient := stripe.NewClient(cfg.Stripe.SecretKey)

    // Initialize repositories
    userRepo := postgres.NewUserRepository(db)
    productRepo := postgres.NewProductRepository(db)
    orderRepo := postgres.NewOrderRepository(db)

    // Initialize services
    userService := user.NewService(userRepo)
    productService := product.NewService(productRepo, cache)
    orderService := order.NewService(orderRepo, productService, stripeClient)

    // Create and start server
    server := api.NewServer(
        cfg.Server,
        logger,
        db,
        userService,
        productService,
        orderService,
    )

    // Graceful shutdown. NotifyContext registers the handler synchronously,
    // before Run starts, so a SIGTERM arriving early cannot slip through.
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    if err := server.Run(ctx); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }

    logger.Info("application stopped")
}
```

### Server Setup

The `Server` struct in `internal/api/server.go` owns the `http.Server`, all service dependencies, and the middleware chain, separating HTTP lifecycle concerns from the application wiring in `main`. The `Run` method starts the listener in a goroutine and uses a `select` to handle both unexpected server errors and the graceful-shutdown context signal, giving the server up to 30 seconds to drain active connections.

```go
// internal/api/server.go
package api

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "time"

    "github.com/mycompany/ecommerce-api/internal/api/handler"
    "github.com/mycompany/ecommerce-api/internal/api/middleware"
    "github.com/mycompany/ecommerce-api/internal/config"
    "github.com/mycompany/ecommerce-api/internal/domain/order"
    "github.com/mycompany/ecommerce-api/internal/domain/product"
    "github.com/mycompany/ecommerce-api/internal/domain/user"
)

type Server struct {
    config         config.ServerConfig
    logger         *slog.Logger
    httpServer     *http.Server
    db             *sql.DB // readiness probe checks this
    userService    *user.Service
    productService *product.Service
    orderService   *order.Service
}

func NewServer(
    cfg config.ServerConfig,
    logger *slog.Logger,
    db *sql.DB,
    userSvc *user.Service,
    productSvc *product.Service,
    orderSvc *order.Service,
) *Server {
    return &Server{
        config:         cfg,
        logger:         logger,
        db:             db,
        userService:    userSvc,
        productService: productSvc,
        orderService:   orderSvc,
    }
}

func (s *Server) Run(ctx context.Context) error {
    // Create handlers
    userHandler := handler.NewUserHandler(s.userService)
    productHandler := handler.NewProductHandler(s.productService)
    orderHandler := handler.NewOrderHandler(s.orderService)

    // Setup router
    mux := http.NewServeMux()

    // Health check
    mux.HandleFunc("GET /healthz", s.healthCheck)
    mux.HandleFunc("GET /readyz", s.readinessCheck)

    // API routes
    mux.HandleFunc("POST /api/v1/users", userHandler.Create)
    mux.HandleFunc("GET /api/v1/users/{id}", userHandler.Get)
    mux.HandleFunc("PUT /api/v1/users/{id}", userHandler.Update)

    mux.HandleFunc("GET /api/v1/products", productHandler.List)
    mux.HandleFunc("GET /api/v1/products/{id}", productHandler.Get)
    mux.HandleFunc("POST /api/v1/products", productHandler.Create)

    mux.HandleFunc("POST /api/v1/orders", orderHandler.Create)
    mux.HandleFunc("GET /api/v1/orders/{id}", orderHandler.Get)
    mux.HandleFunc("GET /api/v1/users/{id}/orders", orderHandler.ListByUser)

    // Apply middleware. Named `root`, not `handler`: a variable called
    // `handler` would shadow the imported `handler` package for the rest
    // of this function. It compiles, because a := binding only takes
    // effect after the statement, but it is a trap for the next reader.
    root := middleware.Chain(
        mux,
        middleware.RequestID,
        middleware.Logging(s.logger),
        middleware.Recovery(s.logger),
        middleware.CORS(s.config.AllowedOrigins),
        middleware.RateLimit(100), // 100 requests per second
    )

    s.httpServer = &http.Server{
        Addr:         fmt.Sprintf(":%d", s.config.Port),
        Handler:      root,
        ReadTimeout:  s.config.ReadTimeout,
        WriteTimeout: s.config.WriteTimeout,
        IdleTimeout:  s.config.IdleTimeout,
    }

    // Start server in goroutine
    errCh := make(chan error, 1)
    go func() {
        s.logger.Info("starting server", "port", s.config.Port)
        if err := s.httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
            errCh <- err
        }
    }()

    // Wait for shutdown signal or error
    select {
    case err := <-errCh:
        return fmt.Errorf("server error: %w", err)
    case <-ctx.Done():
        s.logger.Info("shutting down server")
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        return s.httpServer.Shutdown(shutdownCtx)
    }
}

// healthCheck is liveness: is this process alive at all? It must NOT
// check dependencies. A liveness probe that fails when the database is
// down makes Kubernetes restart every pod during a database blip, which
// turns a recoverable outage into a crash loop.
func (s *Server) healthCheck(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// readinessCheck is readiness: should this pod receive traffic right now?
// This one DOES check dependencies, so a pod with a dead database is
// pulled from the load balancer without being killed.
func (s *Server) readinessCheck(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    if err := s.db.PingContext(ctx); err != nil {
        s.logger.Warn("readiness: database unreachable", "error", err)
        http.Error(w, "database unreachable", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("Ready"))
}
```

The liveness and readiness split is the part teams most often get wrong, and the two comments above are the whole lesson. Wiring a dependency check into liveness is actively dangerous: when the database has a hiccup, every replica fails its liveness probe at once, Kubernetes restarts all of them, and the restarts hammer the recovering database. The service cannot come back. Liveness answers "is this process wedged, should it be restarted", and for most Go services the honest answer is a static 200. Readiness answers "can I serve a request right now", and that is where the dependency check belongs, with a timeout so a hanging database cannot hang the probe too.

This is why `Server` holds `db` and `NewServer` accepts it. A readiness probe that means anything needs a handle on the things it checks.

### Complete Makefile

A well-structured `Makefile` gives the whole team a single, consistent interface for building, testing, linting, and deploying the application regardless of the developer's local setup. The variables at the top capture the Git-derived version tag and build timestamp and inject them as linker flags so every binary carries traceable version metadata at runtime.

```makefile
# Makefile
.PHONY: all build test lint run clean docker help

# Build variables
BINARY_NAME := ecommerce-api
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
# Commit time, not wall-clock time, so rebuilds are byte-identical (see 17.8).
SOURCE_DATE_EPOCH := $(shell git log -1 --pretty=%ct 2>/dev/null || echo 0)
BUILD_TIME := $(shell date -u -d "@$(SOURCE_DATE_EPOCH)" '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS := -ldflags "-X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

# Go variables
GOPATH := $(shell go env GOPATH)
GOBIN := $(GOPATH)/bin

# Default target
all: lint test build

## help: Show this help message
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@sed -n 's/^## //p' $(MAKEFILE_LIST) | column -t -s ':'

## build: Build the application
build:
	go build $(LDFLAGS) -o bin/$(BINARY_NAME) ./cmd/api

## build-all: Build for all platforms
build-all:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 ./cmd/api
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-linux-arm64 ./cmd/api
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-amd64 ./cmd/api
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-darwin-arm64 ./cmd/api

## test: Run unit tests
test:
	go test -race -cover -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out

## test-integration: Run integration tests
test-integration:
	go test -race -tags=integration ./test/integration/...

## test-e2e: Run end-to-end tests
test-e2e:
	go test -race -tags=e2e ./test/e2e/...

## lint: Run linter
lint:
	golangci-lint run ./...

## fmt: Format code
fmt:
	go fmt ./...
	goimports -w .

## vet: Run go vet
vet:
	go vet ./...

## run: Run the application locally
run:
	go run ./cmd/api

## run-dev: Run with hot reload (requires air)
run-dev:
	air

## migrate: Run database migrations
migrate:
	go run ./cmd/migrate up

## migrate-down: Rollback last migration
migrate-down:
	go run ./cmd/migrate down

## seed: Seed database with test data
seed:
	go run ./cmd/migrate seed

## docker-build: Build Docker image
docker-build:
	docker build -t $(BINARY_NAME):$(VERSION) -f deployments/docker/Dockerfile .

## docker-push: Push Docker image
docker-push:
	docker push $(BINARY_NAME):$(VERSION)

## docker-up: Start Docker Compose stack
docker-up:
	docker-compose -f deployments/docker/docker-compose.yml up -d

## docker-down: Stop Docker Compose stack
docker-down:
	docker-compose -f deployments/docker/docker-compose.yml down

## clean: Clean build artifacts
clean:
	rm -rf bin/
	rm -f coverage.out

## deps: Install dependencies
# Tools are pinned. `@latest` makes CI non-reproducible and lets a tool
# release break the build with no commit of yours. Note the /v2 on
# golangci-lint: the unversioned path silently resolves to the final v1.
deps:
	go mod download
	go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2
	go install github.com/air-verse/air@v1.65.3
	go install golang.org/x/tools/cmd/goimports@v0.48.0

## generate: Run go generate
generate:
	go generate ./...

## docs: Generate API documentation
docs:
	swag init -g cmd/api/main.go -o api/docs
```

### Staff Lens: Templates and Scaffolding

The complete application structure above is a useful template. At scale, turn it into a scaffold: a `cookiecutter` or Go-based generator that creates a new service with the agreed layout, CI config, Makefile, and Dockerfile. Every new service starts from the scaffold, so everything stays consistent.

The cost is one-time setup of the generator. The benefit is no more "how should I structure this?" debates for every new service, and new engineers know the layout from any service they open.

### Production Hardening Beyond the Template

The template covers structure. Production adds:

1. **Health checks.** `/healthz` (liveness) and `/readyz` (readiness).
2. **Metrics.** Prometheus `/metrics` endpoint.
3. **Tracing.** OpenTelemetry integration.
4. **Structured logging.** `slog` with correlation IDs.
5. **Graceful shutdown.** SIGTERM handling with bounded drain.
6. **Request middleware.** Recovery, logging, rate limiting, timeout.

Every production Go service has these. If the template does not include them, the team reinvents them per service. Include them in the template.

---
