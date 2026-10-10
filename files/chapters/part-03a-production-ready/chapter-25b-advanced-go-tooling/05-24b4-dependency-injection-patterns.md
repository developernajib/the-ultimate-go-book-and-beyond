## 25B.4 Dependency Injection Patterns

### What is Dependency Injection?

Dependency Injection (DI) means providing dependencies (database connections, HTTP clients, loggers) to a component from the outside, rather than having the component create them internally. When a struct creates its own database connection, tests must spin up a real database. When that connection is passed in through a constructor, tests can substitute a mock that runs entirely in memory. The same principle applies to HTTP clients, loggers, and any other infrastructure dependency.

```go
// BAD: tight coupling - cannot test without a real database
type UserService struct{}

func (s *UserService) GetUser(id int64) (*User, error) {
    db, _ := sql.Open("postgres", os.Getenv("DATABASE_URL")) // hard-coded!
    row := db.QueryRow("SELECT * FROM users WHERE id=$1", id)
    // ...
}

// GOOD: dependency injection - database is provided from outside
type UserService struct {
    db  UserRepository // interface, not concrete type
    log *slog.Logger
}

func NewUserService(db UserRepository, log *slog.Logger) *UserService {
    return &UserService{db: db, log: log}
}

func (s *UserService) GetUser(id int64) (*User, error) {
    return s.db.GetByID(id)
}

// In tests: inject a mock
// In production: inject the real implementation
```

### Pattern 1: Manual DI (Recommended for Most Projects)

For most Go services, the simplest and most readable approach is to build the dependency graph explicitly in `main.go`, constructing each layer in order and passing concrete values down to the components that need them. There is no magic, no reflection, and no external tooling, the entire wiring is visible in one place, making it easy to understand startup order, spot missing dependencies at compile time, and trace how a value flows through the application.

```go
// file: cmd/server/main.go
package main

import (
    "database/sql"
    "log/slog"
    "net/http"
    "os"

    "myapp/internal/db"
    "myapp/internal/service"
    "myapp/internal/handler"
)

func main() {
    // Build the dependency graph manually - explicit and readable
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Infrastructure layer
    database, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Error("db open failed", "err", err)
        os.Exit(1)
    }
    defer database.Close()

    // Data layer
    userRepo := db.NewUserRepository(database)
    orderRepo := db.NewOrderRepository(database)

    // Service layer
    userSvc := service.NewUserService(userRepo, logger)
    orderSvc := service.NewOrderService(orderRepo, userRepo, logger)

    // Handler layer
    userHandler := handler.NewUserHandler(userSvc, logger)
    orderHandler := handler.NewOrderHandler(orderSvc, logger)

    // HTTP layer
    mux := http.NewServeMux()
    userHandler.Register(mux)
    orderHandler.Register(mux)

    logger.Info("starting server", "addr", ":8080")
    http.ListenAndServe(":8080", mux)
}
```

### Pattern 2: Functional Options for Flexible Construction

When a constructor has several optional or rarely-used parameters, a long positional argument list becomes a maintenance problem every time the signature changes. The functional options pattern, popularized by Dave Cheney, solves this by accepting a variadic slice of `Option` functions that each mutate a pre-initialized struct, letting callers supply only what they need while keeping sensible defaults for everything else.

```go
package service

import (
    "log/slog"
    "time"
)

// UserService with functional options
type UserService struct {
    repo         UserRepository
    log          *slog.Logger
    cacheTimeout time.Duration
    maxRetries   int
    metrics      MetricsClient
}

type Option func(*UserService)

func WithLogger(log *slog.Logger) Option {
    return func(s *UserService) { s.log = log }
}

func WithCacheTimeout(d time.Duration) Option {
    return func(s *UserService) { s.cacheTimeout = d }
}

func WithMaxRetries(n int) Option {
    return func(s *UserService) { s.maxRetries = n }
}

func WithMetrics(m MetricsClient) Option {
    return func(s *UserService) { s.metrics = m }
}

func NewUserService(repo UserRepository, opts ...Option) *UserService {
    s := &UserService{
        repo:         repo,
        log:          slog.Default(),
        cacheTimeout: 5 * time.Minute,
        maxRetries:   3,
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}

// Usage
// svc := NewUserService(repo,
//     WithLogger(myLogger),
//     WithCacheTimeout(10 * time.Minute),
//     WithMetrics(promClient),
// )
```

### Pattern 3: Google Wire (Code Generation for DI)

Google Wire takes a different approach from manual wiring: you declare which constructors exist and what they return, then run `wire gen` to produce a plain Go function that calls them in the correct order. The generated code has no reflection and no runtime overhead, it is exactly the manual wiring you would write by hand, but Wire maintains it for you as the dependency graph grows.

> **Senior track**: Wire is feature-complete and effectively in maintenance mode, shipping occasional releases (v0.7.0 landed in 2025) that are mostly module and security updates rather than new capability. That is not a problem, the tool is deliberately small and the generated output is plain Go you could have written by hand. Wire remains the de-facto compile-time DI choice for Go, favored precisely because there is nothing to drift out from under you. If Wire's quiet ecosystem concerns your team, the pragmatic alternative is to stop using a DI library altogether and write the `main.go` wiring explicitly, not to add a heavier runtime framework.

```bash
go install github.com/google/wire/cmd/wire@latest
```

```go
// file: wire.go - provider functions
package main

import (
    "database/sql"
    "os"

    "github.com/google/wire"
    "myapp/internal/db"
    "myapp/internal/service"
    "myapp/internal/handler"
)

// Wire set: tells Wire which providers to use
var AppSet = wire.NewSet(
    db.NewUserRepository,
    db.NewOrderRepository,
    service.NewUserService,
    service.NewOrderService,
    handler.NewUserHandler,
    handler.NewOrderHandler,
    NewDatabase,
)

func NewDatabase() (*sql.DB, error) {
    return sql.Open("postgres", os.Getenv("DATABASE_URL"))
}
```

Running `wire gen` reads the provider set and produces `wire_gen.go`, which contains a plain Go function that wires everything together. This file is checked into version control and compiled normally, Wire is only needed when the dependency graph changes.

The build constraint on the generated file is doing real work, and it comes in a pair. Wire emits both `//go:build !wireinject` and the legacy `// +build !wireinject`, kept in sync (gofmt maintains the pair). Your hand-written `wire.go`, the one holding the provider sets, carries the opposite constraint, `//go:build wireinject`. The two files declare the same function name, and the complementary tags are what stop them colliding: normal builds see only the generated version, and Wire itself builds with `-tags wireinject` to see only your declarations.

```go
// file: wire_gen.go - GENERATED by `wire gen` command, do not edit

//go:build !wireinject
// +build !wireinject

package main

func InitializeServer() (*Server, error) {
    database, err := NewDatabase()
    if err != nil {
        return nil, err
    }
    userRepository := db.NewUserRepository(database)
    orderRepository := db.NewOrderRepository(database)
    userService := service.NewUserService(userRepository)
    orderService := service.NewOrderService(orderRepository, userRepository)
    userHandler := handler.NewUserHandler(userService)
    orderHandler := handler.NewOrderHandler(orderService)
    return NewServer(userHandler, orderHandler), nil
}
```

### Pattern 4: Uber Dig/Fx (Reflection-Based DI Container)

`dig` and `fx` from Uber use reflection to resolve the dependency graph at runtime: you register constructor functions and `dig` matches their return types to the parameter types of other constructors automatically. `fx` builds on `dig` to add structured application lifecycle hooks (`OnStart`/`OnStop`), making it well-suited to large applications where wiring dozens of services by hand would be impractical, at the cost of moving type errors from compile time to startup.

> **Senior track (April 2026)**: Fx is actively maintained and the standard choice inside Uber-style microservice platforms where a single host process composes many modules with nontrivial start/stop ordering. The tradeoffs are real: reflection-based wiring means a missing provider surfaces as a panic at `app.Start()` rather than a compile error, stack traces through Fx become noisy, and the framework assumes control of your `main`, which some teams dislike. Rule of thumb: pick Wire when the graph is static and you want errors at `go build`, pick Fx when you need lifecycle hooks, module boundaries, or dynamic composition across a large service fleet. Do not pick `dig` directly, if you want a runtime container, pay the small additional surface area for Fx.

```go
// Uber Dig: reflection-based DI container
// Fx: application framework built on Dig

package main

import (
    "context"
    "fmt"
    "net/http"

    "go.uber.org/dig"
    "go.uber.org/fx"

    "myapp/internal/db"
    "myapp/internal/handler"
    "myapp/internal/service"
)

// With Dig directly
func useDig() error {
    container := dig.New()

    // Register providers (constructors).
    //
    // Provide returns an error, and it is not decorative: it fires on a
    // duplicate type, a non-function argument, or a constructor whose
    // signature dig cannot use. Dropping it, as `container.Provide(f)`
    // on its own does, defers the discovery to Invoke, where it surfaces
    // as a confusing "missing type" about something you thought you
    // registered.
    providers := []any{
        NewDatabase,
        db.NewUserRepository,
        service.NewUserService,
        handler.NewUserHandler,
    }
    for _, p := range providers {
        if err := container.Provide(p); err != nil {
            return fmt.Errorf("dig provide: %w", err)
        }
    }

    // Invoke runs a function, injecting dependencies automatically
    return container.Invoke(func(h *handler.UserHandler) {
        h.Register(http.DefaultServeMux)
    })
}

// With Fx (recommended over raw Dig)
func useFx() {
    app := fx.New(
        // Module groups
        fx.Provide(
            NewDatabase,
            db.NewUserRepository,
            service.NewUserService,
        ),
        fx.Invoke(func(lc fx.Lifecycle, svc *service.UserService) {
            lc.Append(fx.Hook{
                OnStart: func(ctx context.Context) error {
                    go svc.Start(ctx)
                    return nil
                },
                OnStop: func(ctx context.Context) error {
                    return svc.Stop(ctx)
                },
            })
        }),
    )
    app.Run()
}
```

### DI Pattern Comparison

The right choice depends on team size, the number of services being wired, and how much you value compile-time guarantees versus reduced boilerplate.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Dependency Injection Pattern Comparison                    │
├───────────────┬────────────────────┬────────────────────────────────────┤
│  Pattern      │  Pros              │  Cons                              │
├───────────────┼────────────────────┼────────────────────────────────────┤
│  Manual DI    │ Explicit, readable │ Verbose for large apps             │
│               │ Zero dependencies  │ Must update main.go on changes     │
│               │ Easy to debug      │                                    │
├───────────────┼────────────────────┼────────────────────────────────────┤
│  Google Wire  │ Type-safe          │ Requires running `wire gen`        │
│               │ Zero runtime cost  │ Generated code in repo             │
│               │ Compile-time check │ Learning curve for Wire syntax     │
├───────────────┼────────────────────┼────────────────────────────────────┤
│  Uber Dig/Fx  │ Minimal boilerplate│ Reflection = runtime errors        │
│               │ Rich lifecycle     │ Harder to debug wire errors        │
│               │ Good for large apps│ Performance overhead at startup    │
├───────────────┼────────────────────┼────────────────────────────────────┤
│  Choose when  │ < 20 services      │ > 50 services with complex graphs  │
│               │ Manual: always OK  │ Wire: medium/large, type-safety    │
│               │                    │ Fx: large apps, team consistency   │
└───────────────┴────────────────────┴────────────────────────────────────┘
```

### Staff Lens: DI Framework Is a Team Commitment

Adopting Wire or Fx is a multi-year commitment. The framework shapes how every service is written. Choose after a trial on a pilot service, and make sure the team wants the conventions before rolling out broadly.

For most Go services, manual DI is enough. The "simple main.go wires everything" pattern works at remarkable scale before needing a framework.

---
