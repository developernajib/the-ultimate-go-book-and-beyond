## 17.13 Exercises with Solutions

### Exercise 1: Refactor a Flat Structure

**Problem**: Refactor this flat structure to follow best practices:

```
myapp/
├── main.go
├── user.go
├── order.go
├── database.go
├── handler.go
└── config.go
```

**Solution**:
```
myapp/
├── cmd/
│   └── api/
│       └── main.go
├── internal/
│   ├── api/
│   │   ├── handler/
│   │   │   ├── user.go
│   │   │   └── order.go
│   │   └── server.go
│   ├── domain/
│   │   ├── user/
│   │   │   ├── model.go
│   │   │   ├── service.go
│   │   │   └── repository.go
│   │   └── order/
│   │       ├── model.go
│   │       ├── service.go
│   │       └── repository.go
│   ├── platform/
│   │   └── postgres/
│   │       └── client.go
│   └── config/
│       └── config.go
├── go.mod
└── Makefile
```

### Exercise 2: Implement Dependency Injection

**Problem**: Implement DI for this service without a framework:

```go
type OrderService struct {
    // Needs: UserRepository, ProductRepository, PaymentGateway, EmailSender
}
```

**Solution**:
```go
// internal/domain/order/service.go
package order

import (
    "context"
    "fmt"
    "log/slog"
)

// Define interfaces at point of use
type UserRepository interface {
    Get(ctx context.Context, id int64) (*User, error)
}

type ProductRepository interface {
    Get(ctx context.Context, id int64) (*Product, error)
    UpdateStock(ctx context.Context, id int64, delta int) error
}

type PaymentGateway interface {
    Charge(ctx context.Context, amount int64, source string) (*Charge, error)
}

type EmailSender interface {
    Send(ctx context.Context, to, subject, body string) error
}

// Service with dependencies
type Service struct {
    users    UserRepository
    products ProductRepository
    payments PaymentGateway
    emails   EmailSender
}

// Constructor with dependency injection
func NewService(
    users UserRepository,
    products ProductRepository,
    payments PaymentGateway,
    emails EmailSender,
) *Service {
    return &Service{
        users:    users,
        products: products,
        payments: payments,
        emails:   emails,
    }
}

func (s *Service) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    user, err := s.users.Get(ctx, req.UserID)
    if err != nil {
        return nil, fmt.Errorf("get user: %w", err)
    }

    product, err := s.products.Get(ctx, req.ProductID)
    if err != nil {
        return nil, fmt.Errorf("get product: %w", err)
    }

    charge, err := s.payments.Charge(ctx, product.PriceCents, req.PaymentSource)
    if err != nil {
        return nil, fmt.Errorf("charge: %w", err)
    }

    if err := s.products.UpdateStock(ctx, product.ID, -1); err != nil {
        return nil, fmt.Errorf("update stock: %w", err)
    }

    ord := &Order{
        UserID:   user.ID,
        ChargeID: charge.ID,
        Total:    product.PriceCents,
    }

    // Email failure must not fail the order: the money is already taken.
    // Log it and move on, or hand it to a retry queue.
    if err := s.emails.Send(ctx, user.Email, "Order confirmed", ord.Receipt()); err != nil {
        slog.WarnContext(ctx, "order confirmation email failed",
            "order_id", ord.ID, "error", err)
    }

    return ord, nil
}
```

```go
// cmd/api/main.go - Wire everything together
func main() {
    db := postgres.Connect(cfg.Database)

    // Create implementations
    userRepo := postgres.NewUserRepository(db)
    productRepo := postgres.NewProductRepository(db)
    paymentGateway := stripe.NewClient(cfg.Stripe)
    emailSender := sendgrid.NewClient(cfg.SendGrid)

    // Inject dependencies
    orderService := order.NewService(
        userRepo,
        productRepo,
        paymentGateway,
        emailSender,
    )
}
```

### Exercise 3: Design Error Handling

**Problem**: Create a consistent error handling system that:
- Defines domain errors
- Maps to HTTP status codes
- Provides structured responses

**Solution**:
```go
// internal/domain/errors.go
package domain

import (
    "errors"
    "fmt"
)

// Sentinel errors
var (
    ErrNotFound      = errors.New("not found")
    ErrConflict      = errors.New("conflict")
    ErrUnauthorized  = errors.New("unauthorized")
    ErrForbidden     = errors.New("forbidden")
    ErrValidation    = errors.New("validation error")
    ErrInternal      = errors.New("internal error")
)

// DomainError with additional context
type DomainError struct {
    Err     error
    Code    string
    Message string
    Details map[string]string
}

func (e *DomainError) Error() string {
    return e.Message
}

func (e *DomainError) Unwrap() error {
    return e.Err
}

// Constructors
func NewNotFoundError(resource string) *DomainError {
    return &DomainError{
        Err:     ErrNotFound,
        Code:    "NOT_FOUND",
        Message: fmt.Sprintf("%s not found", resource),
    }
}

func NewValidationError(field, message string) *DomainError {
    return &DomainError{
        Err:     ErrValidation,
        Code:    "VALIDATION_ERROR",
        Message: "Validation failed",
        Details: map[string]string{field: message},
    }
}
```

```go
// internal/api/errors.go
package api

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"

    "myapp/internal/domain"
)

type ErrorResponse struct {
    Code    string            `json:"code"`
    Message string            `json:"message"`
    Details map[string]string `json:"details,omitempty"`
}

func HandleError(w http.ResponseWriter, err error) {
    var domainErr *domain.DomainError
    if errors.As(err, &domainErr) {
        status := mapErrorToStatus(domainErr.Err)
        writeJSON(w, status, ErrorResponse{
            Code:    domainErr.Code,
            Message: domainErr.Message,
            Details: domainErr.Details,
        })
        return
    }

    // Unknown error - log and return generic response
    slog.Error("unhandled error", "error", err)
    writeJSON(w, http.StatusInternalServerError, ErrorResponse{
        Code:    "INTERNAL_ERROR",
        Message: "An unexpected error occurred",
    })
}

func mapErrorToStatus(err error) int {
    switch {
    case errors.Is(err, domain.ErrNotFound):
        return http.StatusNotFound
    case errors.Is(err, domain.ErrConflict):
        return http.StatusConflict
    case errors.Is(err, domain.ErrUnauthorized):
        return http.StatusUnauthorized
    case errors.Is(err, domain.ErrForbidden):
        return http.StatusForbidden
    case errors.Is(err, domain.ErrValidation):
        return http.StatusBadRequest
    default:
        return http.StatusInternalServerError
    }
}

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(v)
}
```

---

## Project Structure Pitfalls: Real-World Horror Stories

This section covers the most devastating project structure mistakes that teams encounter in production, based on real incidents and lessons learned from companies of all sizes.

### The Monolithic Internal Package

**The Setup**: A team puts everything in `internal/` to "hide implementation details."

```
project/
├── cmd/
│   └── api/
│       └── main.go
└── internal/
    ├── user.go
    ├── order.go
    ├── payment.go
    ├── database.go
    ├── cache.go
    ├── email.go
    ├── auth.go
    ├── config.go
    ├── handlers.go
    ├── middleware.go
    ├── validators.go
    ├── utils.go        // 🚨 Red flag
    └── helpers.go      // 🚨 Red flag
```

**The Problem**: a year or two in, `internal/` is tens of thousands of lines in one package and every identifier is reachable from every file. The design damage is the real cost, but there is a mechanical cost too, and it is easy to measure. Go's unit of compilation is the **package**, which has two consequences: a package cannot be compiled in parallel with itself, and touching any file in it recompiles all of it.

Splitting the same code into cohesive packages therefore buys real time. The same 12,000 generated functions, as one package versus thirty:

| | one package | thirty packages |
|---|---|---|
| Cold build | 20.6s | 8.9s |
| Rebuild after a one-file edit | 832ms | 272ms |

The cold build roughly halves because thirty packages compile concurrently. The incremental rebuild drops by about 3x because only the edited package is recompiled rather than all 12,000 functions. Both gaps widen as the package grows, which is why this failure mode is slow-boiling: it never hurts on the day you introduce it.

Do not over-read the numbers. They come from a synthetic benchmark on one machine, and splitting for its own sake also costs something (more packages means more link work, and a very fine split can be slower than a coarse one at small scale). The point is the direction and the mechanism, not the exact ratio.

```go
// internal/user.go
package internal

// Freely reaches into order, payment, email, cache, database...
// No import needed: they are all the same package.

// internal/order.go
package internal

// Reaches straight back into user. Also no import needed.

// There are no imports between these files, and that is the problem,
// not the consolation. Same-package files cannot import each other,
// so the compiler's cycle check has nothing to check. Every tangle
// you would have seen as "import cycle not allowed" is now legal.
// Cognitive complexity is ENORMOUS and nothing warns you.
```

**The Fix**: Break into cohesive packages by domain:

```
project/
├── cmd/
│   └── api/
│       └── main.go
└── internal/
    ├── user/
    │   ├── user.go
    │   ├── repository.go
    │   └── service.go
    ├── order/
    │   ├── order.go
    │   ├── repository.go
    │   └── service.go
    ├── platform/
    │   ├── database/
    │   ├── cache/
    │   └── email/
    └── api/
        ├── handler/
        └── middleware/
```

### The Cyclic Import Death Spiral

**The Pattern**: a team reaches a point where adding almost any feature triggers a circular import error, and engineers spend more time rearranging packages than writing code. It is a common way for a feature-based layout to go wrong, because feature packages are exactly the ones that want to reference each other.

```go
// WRONG: Circular import waiting to happen

// internal/user/user.go
package user

import "myapp/internal/order"  // User needs to see user's orders

type User struct {
    ID     int64
    Orders []order.Order  // 🚨 Direct dependency on order package
}

// internal/order/order.go
package order

import "myapp/internal/user"  // Order needs user info

type Order struct {
    ID     int64
    User   user.User  // 🚨 Direct dependency on user package
}

// COMPILE ERROR: import cycle not allowed
```

**The Root Cause**: Packages that model real-world relationships tend to create cycles because the real world has bidirectional relationships.

**The Solutions**:

```go
// SOLUTION 1: Interface at point of use

// internal/order/order.go
package order

// Define what we need from users
type UserInfo interface {
    GetID() int64
    GetName() string
}

type Order struct {
    ID       int64
    UserInfo UserInfo  // Interface, not concrete type
}

// SOLUTION 2: Separate shared types package

// internal/domain/types.go
package domain

// Shared types that both packages need
type UserID int64
type OrderID int64

// internal/user/user.go
package user

import "myapp/internal/domain"

type User struct {
    ID     domain.UserID
    Name   string
}

// internal/order/order.go
package order

import "myapp/internal/domain"

type Order struct {
    ID     domain.OrderID
    UserID domain.UserID  // Reference by ID, not embedding
}

// SOLUTION 3: Dependency Inversion (most flexible)

// internal/user/user.go
package user

type User struct {
    ID   int64
    Name string
}

// Repository interface defined here (where it's used)
type Repository interface {
    GetByID(id int64) (*User, error)
    Save(*User) error
}

// OrderService interface for what user package needs
type OrderService interface {
    GetOrdersForUser(userID int64) ([]OrderSummary, error)
}

type OrderSummary struct {
    ID          int64
    AmountCents int64 // integer minor units, never float64 for money
}

// Service uses interfaces, not concrete types
type Service struct {
    repo   Repository
    orders OrderService
}
```

### The God Config Anti-Pattern

**The Problem**: One config struct that knows about everything, passed everywhere.

```go
// WRONG: God config that every package imports

// config/config.go
package config

type Config struct {
    // Database
    DBHost     string
    DBPort     int
    DBUser     string
    DBPassword string
    DBName     string

    // Redis
    RedisHost     string
    RedisPassword string

    // Kafka
    KafkaBrokers []string
    KafkaTopics  []string

    // HTTP Server
    HTTPPort    int
    HTTPTimeout time.Duration

    // Feature Flags
    EnableNewCheckout bool
    EnableBetaFeature bool

    // Third Party Services
    StripeAPIKey    string
    SendGridAPIKey  string
    TwilioSID       string
    TwilioAuthToken string

    // ... 50 more fields
}

// Every package imports config
// Changes to ANY config field rebuilds EVERYTHING
// Testing requires constructing entire Config struct
```

**The Fix**: Config per domain with interfaces:

```go
// CORRECT: Domain-specific config

// internal/database/config.go
package database

type Config struct {
    Host     string
    Port     int
    User     string
    Password string
    Name     string
}

// internal/cache/config.go
package cache

type Config struct {
    Host     string
    Password string
    DB       int
}

// internal/payment/config.go
package payment

type Config struct {
    StripeAPIKey string
    WebhookSecret string
}

// cmd/api/main.go - Wire everything together
func main() {
    // Parse environment once
    dbConfig := database.Config{
        Host: os.Getenv("DB_HOST"),
        // ...
    }

    cacheConfig := cache.Config{
        Host: os.Getenv("REDIS_HOST"),
    }

    // Each package only knows its own config
    db := database.New(dbConfig)
    cache := cache.New(cacheConfig)
}
```

### The Leaky Infrastructure Pattern

**The Problem**: Database types leak into your domain, coupling business logic to storage decisions.

```go
// WRONG: Domain polluted with infrastructure

// internal/user/user.go
package user

import (
    "database/sql"
    "github.com/lib/pq"
)

type User struct {
    ID        int64          `db:"id"`
    Name      string         `db:"name"`
    Email     string         `db:"email"`
    CreatedAt pq.NullTime    `db:"created_at"`  // 🚨 DB-specific type
    DeletedAt sql.NullTime   `db:"deleted_at"`  // 🚨 DB-specific type
    Metadata  pq.StringArray `db:"metadata"`    // 🚨 Postgres-specific
}

// Now your domain type can't be used with MongoDB, DynamoDB, or in-memory testing
// Tests require postgres-specific handling
// Switching databases means rewriting domain code
```

**The Fix**: Clean domain types, infrastructure adapters:

```go
// CORRECT: Clean domain types

// internal/domain/user/user.go
package user

import "time"

type User struct {
    ID        int64
    Name      string
    Email     string
    CreatedAt time.Time
    DeletedAt *time.Time  // nil = not deleted
    Metadata  []string
}

// Repository is interface in domain
type Repository interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    Save(ctx context.Context, user *User) error
    Delete(ctx context.Context, id int64) error
}

// internal/infrastructure/postgres/user_repo.go
package postgres

import (
    "database/sql"
    "github.com/lib/pq"
    "myapp/internal/domain/user"
)

// Internal type for Postgres
type userRow struct {
    ID        int64          `db:"id"`
    Name      string         `db:"name"`
    Email     string         `db:"email"`
    CreatedAt pq.NullTime    `db:"created_at"`
    DeletedAt sql.NullTime   `db:"deleted_at"`
    Metadata  pq.StringArray `db:"metadata"`
}

type Repository struct {
    db *sql.DB
}

func (r *Repository) GetByID(ctx context.Context, id int64) (*user.User, error) {
    var row userRow
    // Query and scan into row...
    return r.toDomain(&row), nil
}

func (r *Repository) toDomain(row *userRow) *user.User {
    u := &user.User{
        ID:       row.ID,
        Name:     row.Name,
        Email:    row.Email,
        Metadata: []string(row.Metadata),
    }
    if row.CreatedAt.Valid {
        u.CreatedAt = row.CreatedAt.Time
    }
    if row.DeletedAt.Valid {
        u.DeletedAt = &row.DeletedAt.Time
    }
    return u
}
```

### The Missing Wire-Up: Where Dependencies Actually Connect

**A common failure**: Developers create beautiful interfaces and domain models but forget that something needs to wire everything together.

```go
// WRONG: No clear composition root

// Scattered "New" functions that create their own dependencies
func NewUserHandler() *UserHandler {
    db := database.Connect()  // 🚨 Creates its own DB connection
    cache := redis.Connect()  // 🚨 Creates its own Redis connection
    return &UserHandler{
        repo:  NewUserRepo(db),
        cache: NewUserCache(cache),
    }
}

func NewOrderHandler() *OrderHandler {
    db := database.Connect()  // 🚨 Different DB connection!
    cache := redis.Connect()  // 🚨 Different Redis connection!
    return &OrderHandler{
        repo:  NewOrderRepo(db),
        cache: NewOrderCache(cache),
    }
}

// Result: Multiple database connections, multiple Redis connections
// Connection pool exhaustion, inconsistent state, resource leaks
```

**The Fix**: Single composition root in main:

```go
// CORRECT: Clear composition root

// cmd/api/main.go
func main() {
    // Create shared infrastructure ONCE
    db, err := database.Connect(cfg.Database)
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    cache, err := redis.Connect(cfg.Redis)
    if err != nil {
        log.Fatal(err)
    }
    defer cache.Close()

    // Wire up all dependencies explicitly
    userRepo := postgres.NewUserRepository(db)
    userCache := redis.NewUserCache(cache)
    userService := user.NewService(userRepo, userCache)
    userHandler := api.NewUserHandler(userService)

    orderRepo := postgres.NewOrderRepository(db)
    orderService := order.NewService(orderRepo, userService)
    orderHandler := api.NewOrderHandler(orderService)

    // Build router with all handlers
    router := api.NewRouter(userHandler, orderHandler)

    // Start server
    server := &http.Server{
        Addr:    cfg.HTTP.Addr,
        Handler: router,
    }
    log.Fatal(server.ListenAndServe())
}
```

### The Test File Explosion

**The Problem**: Every implementation file has its own test file, but they all test the same things differently.

```
internal/
├── user/
│   ├── user.go
│   ├── user_test.go           // Tests User struct
│   ├── service.go
│   ├── service_test.go        // Tests service with mocks
│   ├── repository.go
│   ├── repository_test.go     // Tests repo with mocks
│   ├── handler.go
│   └── handler_test.go        // Tests handler with mocks
```

**The Real Problem**: When you change `User` struct, you need to update 4 test files. Mock definitions are duplicated. Test setup code is scattered. No integration between layers.

**Better Approach**: Test layers together where it makes sense:

```go
// internal/user/user_test.go - Combined tests

package user_test  // External test package for black-box testing

import (
    "testing"
    "myapp/internal/user"
    "myapp/internal/testutil"
)

// TestUserService tests the service with real repository (in-memory)
func TestUserService(t *testing.T) {
    // Use in-memory implementation for fast tests
    repo := testutil.NewInMemoryUserRepo()
    service := user.NewService(repo)
    ctx := t.Context() // cancelled automatically when the test ends

    t.Run("create and retrieve user", func(t *testing.T) {
        created, err := service.Create(ctx, user.CreateInput{
            Name:  "Alice",
            Email: "alice@example.com",
        })
        if err != nil {
            t.Fatalf("create failed: %v", err)
        }

        retrieved, err := service.GetByID(ctx, created.ID)
        if err != nil {
            t.Fatalf("retrieve failed: %v", err)
        }

        if retrieved.Email != "alice@example.com" {
            t.Errorf("email mismatch: got %s", retrieved.Email)
        }
    })
}

```

Integration tests go in their own file behind a build tag. The tag must be the
first thing in the file, followed by a blank line, then the package clause. Get
that order wrong and it is not a silent no-op: `go vet` reports
`misplaced //go:build comment` and the build fails.

```go
//go:build integration

// internal/user/integration_test.go
package user_test

import (
    "testing"

    "myapp/internal/domain/user"
    "myapp/internal/infrastructure/postgres"
    "myapp/internal/testutil"
)

func TestUserServiceIntegration(t *testing.T) {
    db := testutil.SetupTestDB(t)
    repo := postgres.NewUserRepository(db)
    service := user.NewService(repo)

    // Same assertions as the in-memory test above, real database underneath.
    // Running the same suite against both implementations is the point:
    // it proves the in-memory fake and Postgres actually agree.
    _ = service
}
```

### Quick Reference: Project Structure Red Flags

| Red Flag | Why It's Bad | Fix |
|----------|--------------|-----|
| `utils/` or `helpers/` package | Dumping ground, no cohesion | Move to where it's used |
| Everything in `internal/` | One giant package | Split by domain |
| `models/` package | Anemic domain, leaked types | Define types where used |
| Global variables for deps | Hard to test, implicit state | Explicit dependency injection |
| Config struct everywhere | Tight coupling, rebuild all | Per-domain config |
| Database types in domain | Infrastructure lock-in | Adapter pattern |
| Circular import errors | Wrong package boundaries | Interface at point of use |

### Staff / Principal Track

8. **Service-scaffold generator.** Build a template (via cookiecutter, a custom generator, or a documented procedure) that produces a new Go service matching your org's standard. Pilot on three new services. Measure time-to-first-commit.

9. **Structure audit.** For five services in your org, assess structural conformance against the standard. Produce a report. Recommend specific refactors for each. Drive the top three.

10. **Structure convention doc.** Write the one-page guide: what layout, when to deviate, how to justify. Publish. Socialise with the senior pool.

11. **Module boundary decision.** For a repository that has grown to multiple Go modules (or is considering it), document the decision criteria: when to split, when to unify. Apply to one real case.

12. **Layout evolution retrospective.** If your team has changed project layouts over the years, write up the retrospective: what worked, what did not, what triggered each change. Teaching material for future evolution decisions.

---
