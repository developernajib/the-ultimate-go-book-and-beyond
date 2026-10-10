## 17.3 Dependency Management

### Dependency Injection

Dependency injection in Go is achieved by defining interfaces in the package that consumes them, then accepting those interfaces as constructor parameters. This keeps packages loosely coupled, the caller decides which concrete implementation to supply, making it straightforward to swap in a mock during testing or a different database driver in production.

```go
// Define interfaces in the package that uses them
// internal/user/service.go
package user

type Repository interface {
    Get(id int) (*User, error)
    Save(u *User) error
}

type Service struct {
    repo Repository
}

func NewService(repo Repository) *Service {
    return &Service{repo: repo}
}
```

```go
// Wire up in main
// cmd/api/main.go
func main() {
    db := postgres.Connect()
    userRepo := postgres.NewUserRepository(db)
    userService := user.NewService(userRepo)
    // ...
}
```

### Configuration Injection

Centralizing all runtime settings in a single `Config` struct makes configuration explicit and easy to validate at startup. Passing this struct, or targeted portions of it, into each subsystem via constructors ensures every component documents its settings requirements and avoids hidden global state.

```go
// internal/config/config.go
package config

import "time"

type Config struct {
    Server   ServerConfig
    Database DatabaseConfig
    Redis    RedisConfig
}

type ServerConfig struct {
    Port         int
    ReadTimeout  time.Duration
    WriteTimeout time.Duration
}

func Load() (*Config, error) {
    var cfg Config
    // Populate from env, file, flags, then validate.
    if err := cfg.Validate(); err != nil {
        return nil, err
    }
    return &cfg, nil
}
```

```go
// cmd/api/main.go
func main() {
    cfg, err := config.Load()
    if err != nil {
        log.Fatal(err)
    }

    server := api.NewServer(
        api.WithPort(cfg.Server.Port),
        api.WithTimeout(cfg.Server.ReadTimeout),
    )
}
```

### Wire for Complex DI

When a project has dozens of services, repositories, and infrastructure clients, wiring them manually in `main()` becomes verbose and error-prone. Google's Wire is a compile-time dependency injection tool that generates the wiring code for you based on provider functions. You declare what each constructor needs and produces, and Wire resolves the full dependency graph at build time, no reflection, no runtime cost.

```go
//go:build wireinject

package main

import (
    "github.com/google/wire"
    "myproject/internal/user"
    "myproject/internal/order"
)

func InitializeApp() (*App, error) {
    wire.Build(
        user.NewRepository,
        user.NewService,
        order.NewRepository,
        order.NewService,
        NewApp,
    )
    return nil, nil
}
```

### Manual DI Is Usually Enough

Most Go services have a few dozen dependencies, which can be wired manually in `main()` in 20-40 lines. Reaching for Wire, fx, or another DI framework adds a build-time dependency and a learning curve for new engineers.

Criteria for adopting a DI framework:

- The dependency graph is large and deep enough that hand-wiring it is genuinely error-prone, not merely tedious. In Go this is rarer than people expect.
- The graph changes constantly, so the churn of re-threading a new dependency through many constructors is a real tax.
- The team already uses the framework in other services, and consistency is worth more than the saved dependency.

Note what is not a criterion: cyclic dependencies. Wire does not rescue you from those, it reports them (`cycle for ...`) and refuses to generate. A cycle in your object graph is a design problem, and no DI tool will wire it for you. If you hit one, break it with an interface or a third package, exactly as you would by hand.

Otherwise, manual wiring is fine. Flag reaching for Wire without these criteria as potentially premature.

### Staff Lens: Keep the Composition Root Thin

`main.go` should be a wiring function: read config, construct dependencies, start server, register shutdown. Business logic does not belong in `main`. If `main.go` has grown past 200 lines with non-wiring code, refactor. A good `main.go` reads like a recipe: here are the ingredients (config, clients), here are the layers assembled (services, handlers), here is the result (running server).

---
