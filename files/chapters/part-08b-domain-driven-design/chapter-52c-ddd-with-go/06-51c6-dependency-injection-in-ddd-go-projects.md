## 52C.6 Dependency Injection in DDD Go Projects

### Manual DI: Wiring the Application

Go's approach to dependency injection is explicit: you construct your dependencies manually in `main.go` (or a dedicated wiring package). This is preferred over magic IoC containers:

```go
// cmd/server/main.go

package main

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    _ "github.com/lib/pq"
    orderdomain "github.com/yourorg/ecommerce/order-service/internal/domain/order"
    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    orderinfra "github.com/yourorg/ecommerce/order-service/internal/infrastructure/persistence"
    "github.com/yourorg/ecommerce/order-service/internal/infrastructure/messaging"
    httphandler "github.com/yourorg/ecommerce/order-service/interfaces/http"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // ── Infrastructure ────────────────────────────────────────────────
    dsn := os.Getenv("DATABASE_URL")
    if dsn == "" {
        logger.Error("DATABASE_URL environment variable is required")
        os.Exit(1)
    }

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        logger.Error("open database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(5 * time.Minute)

    if err := db.Ping(); err != nil {
        logger.Error("ping database", "error", err)
        os.Exit(1)
    }

    // Event bus (in-process)
    eventBus := orderdomain.NewEventBus()

    // ── Repository (Infrastructure) ───────────────────────────────────
    orderRepo := orderinfra.NewPostgresOrderRepository(db, eventBus)
    orderQueryRepo := orderinfra.NewPostgresOrderQueryRepository(db)

    // ── Application Services (Command/Query Handlers) ─────────────────
    placeOrderHandler    := orderapp.NewPlaceOrderHandler(orderRepo)
    cancelOrderHandler   := orderapp.NewCancelOrderHandler(orderRepo, nil) // nil idempotency for demo
    confirmOrderHandler  := orderapp.NewConfirmOrderHandler(orderRepo)
    fulfillOrderHandler  := orderapp.NewFulfillOrderHandler(orderRepo)
    getOrderHandler      := orderapp.NewGetOrderHandler(orderQueryRepo)

    // ── HTTP Interface ─────────────────────────────────────────────────
    orderHTTPHandler := httphandler.NewOrderHandler(
        placeOrderHandler,
        cancelOrderHandler,
        confirmOrderHandler,
        fulfillOrderHandler,
        getOrderHandler,
    )

    router := httphandler.NewRouter(orderHTTPHandler, logger)

    // ── Server ────────────────────────────────────────────────────────
    server := &http.Server{
        Addr:         ":" + getEnv("PORT", "8080"),
        Handler:      router,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Graceful shutdown
    done := make(chan os.Signal, 1)
    signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        logger.Info("starting HTTP server", "addr", server.Addr)
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            logger.Error("HTTP server error", "error", err)
            os.Exit(1)
        }
    }()

    <-done
    logger.Info("shutting down server")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        logger.Error("server forced shutdown", "error", err)
    }

    logger.Info("server stopped")
}

func getEnv(key, defaultVal string) string {
    if val := os.Getenv(key); val != "" {
        return val
    }
    return defaultVal
}
```

### Using Wire for Compile-Time DI

For larger applications where the manual wiring in `main.go` grows unwieldy, Google's Wire tool generates the wiring code at compile time. Wire analyzes your constructor signatures, resolves the dependency graph, and emits plain Go code with no runtime reflection.

```go
// wire.go (wire provider set definitions)
//go:build wireinject

package main

import (
    "database/sql"
    "github.com/google/wire"
    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    orderinfra "github.com/yourorg/ecommerce/order-service/internal/infrastructure/persistence"
    httphandler "github.com/yourorg/ecommerce/order-service/interfaces/http"
)

// InfrastructureSet contains infrastructure providers.
var InfrastructureSet = wire.NewSet(
    orderinfra.NewPostgresOrderRepository,
    orderinfra.NewPostgresOrderQueryRepository,
)

// ApplicationSet contains application service providers.
var ApplicationSet = wire.NewSet(
    orderapp.NewPlaceOrderHandler,
    orderapp.NewCancelOrderHandler,
    orderapp.NewConfirmOrderHandler,
    orderapp.NewFulfillOrderHandler,
    orderapp.NewGetOrderHandler,
)

// InterfaceSet contains interface layer providers.
var InterfaceSet = wire.NewSet(
    httphandler.NewOrderHandler,
    httphandler.NewRouter,
)

// InitializeApp wires the complete application.
func InitializeApp(db *sql.DB) (*http.Server, error) {
    wire.Build(InfrastructureSet, ApplicationSet, InterfaceSet, NewServer)
    return nil, nil
}
```

Wire runs `go generate` at build time and emits `wire_gen.go` - plain, debuggable Go with zero reflection. If a provider is missing or a cycle exists, the build fails. This is the right trade-off for DDD: layering mistakes become compile errors.

### Wire vs. Fx vs. Pure Manual DI

All three work. Picking between them is a scale and ergonomics question, not a correctness one.

| Approach | Startup cost | Debuggability | Best for |
|---------|--------------|---------------|----------|
| Manual (plain `main.go`) | Zero | Highest - it is just code | Single-service DDD projects up to ~30 components |
| Wire (Google) | `go generate` step | High - generated code is readable | Medium-to-large services, strong preference for compile-time safety |
| Fx (Uber) | Runtime reflection + lifecycle hooks | Lower - reflective stack traces | Large platforms with many optional modules, lifecycle graphs, and shared internal frameworks |

For DDD specifically, Wire is the natural fit. DDD values explicit boundaries and explicit dependencies. Compile-time wiring reinforces both. Fx shines when you also need application-lifecycle management (staggered startup, graceful shutdown, fx modules for each bounded context), which is why Uber's large internal monorepo standardizes on it. Plain manual wiring stays readable up to the point where `main.go` exceeds ~200 lines. At that point, extract into constructor packages per layer, and only adopt Wire or Fx if the boilerplate genuinely hurts.

Anti-pattern: `github.com/sarulabs/di` and similar service-locator containers. They hide the dependency graph behind string keys and push wiring errors to runtime. A DDD application is defined by its dependencies. hiding them is the wrong direction.

---

### Junior → FAANG: Manual DI is Not a Weakness

Developers who learned backend in Spring Boot or Rails are often uncomfortable with explicit manual wiring. "Where is the framework?" is a common question when reading a Go DDD `main.go` for the first time. The answer is: the framework is the language. Go's constructor functions are the DI mechanism, and `main.go` is the composition root.

The key habit to build: every struct that has external dependencies should have a constructor function (`NewXxx`) that takes those dependencies as parameters. Never use `init()` to set global state. Never use package-level variables as implicit singletons that different packages import and mutate. These patterns create hidden dependencies that cannot be swapped in tests.

A quick exercise: take any `main.go` you have written and draw the dependency graph by hand. Draw a box for each struct and an arrow from each box to the boxes its constructor takes as parameters. If the graph has more than 30 nodes, consider Wire. If you discover a cycle (A depends on B which depends on A), you have a design problem that wiring cannot solve: one of those dependencies needs to be inverted through an interface.

For interviews, be prepared to explain why a service-locator pattern is worse than constructor injection. The answer has two parts: discoverability (with constructor injection, you can see all dependencies in the function signature, while with a service locator, you cannot know what `container.Get("repo")` will return without reading the container configuration) and testability (with constructor injection, you can pass a fake, while with a service locator, you need to register a fake with the container, which is more setup and more fragile).

### Senior @ FAANG: Dependency Injection as an Architecture Enforcement Tool

At the staff level, the choice of DI strategy for a platform is not primarily about developer ergonomics: it is about what the DI strategy makes possible in terms of architectural enforcement, observability, and lifecycle management.

**Wire as an architecture linter.** When Wire generates the wiring code, it fails if a provider is missing. This means adding a new dependency to a handler without providing it is a build-time error, not a runtime panic. This property is architecturally valuable: it means you cannot "quietly" add a database dependency to a domain handler without the build system objecting. For DDD specifically, if a domain struct ever needs a database connection, the Wire provider graph will show it explicitly, making the violation visible in code review. Wire's generated `wire_gen.go` is also readable: a new engineer can look at it and understand the complete dependency graph without running the program.

**Fx module decomposition at organizational scale.** For platforms where each bounded context is a dynamically loaded module (a pattern used in large Uber-internal services), Fx's `fx.Module` provides a clean way to express that each bounded context contributes its own set of providers to the overall application. The Order module provides order handlers and repositories. The Payment module provides payment handlers and gateways. The application binary composes the modules. This enables feature-flag-controlled module loading (deploy without the Payment module in a region where payments are not live yet) and per-module lifecycle management (the Order module's database pool starts before the HTTP server, independently of when the Payment module's external API client becomes healthy). Wire cannot express this dynamism. Fx is the right tool for this specific problem.

**Wiring as documentation.** The `main.go` (or `wire.go`) is the most important file in the service for understanding what the service does and what it depends on. A Staff engineer insists on keeping it readable: use named constants for configuration values, add comments identifying the layer boundaries (`// -- Infrastructure --`, `// -- Application --`, `// -- Interface --`), and do not inline complex initialization logic. If the Postgres pool initialization is more than 10 lines, extract it to a `newPostgresPool(cfg Config) (*sql.DB, error)` function. The composition root should read like an architecture diagram, not a procedural initialization script.

**Lifecycle management as an operational concern.** The graceful shutdown sequence in `main.go` is not just Go boilerplate. In a production DDD service, the shutdown order matters: stop accepting new requests first, wait for in-flight handlers to complete, flush the outbox worker, close the database pool last. Doing this in the wrong order causes lost events, incomplete transactions, or goroutine leaks. A Staff engineer codifies the correct shutdown sequence in the service template, ensuring every new service gets it right without thinking. Fx's `fx.Hook` mechanism enforces this at the framework level, which is one reason large organizations standardize on it even for services that do not need dynamic modules.

---
