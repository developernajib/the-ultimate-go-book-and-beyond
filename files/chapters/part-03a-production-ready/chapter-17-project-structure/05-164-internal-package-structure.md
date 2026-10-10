## 17.4 Internal Package Structure

### Model Definition

The model file is the single source of truth for what a `User` looks like in your domain, combining Go struct tags for both JSON serialization and database column mapping in one place. Keeping request DTOs (`CreateRequest`, `UpdateRequest`) alongside the domain model makes it easy to see which fields are user-supplied versus system-generated, and the `validate` tags express input constraints declaratively without scattering validation logic across handlers.

```go
// internal/user/model.go
package user

import "time"

type User struct {
    ID        int64     `json:"id" db:"id"`
    Email     string    `json:"email" db:"email"`
    Name      string    `json:"name" db:"name"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
}

type CreateRequest struct {
    Email string `json:"email" validate:"required,email"`
    Name  string `json:"name" validate:"required,min=2"`
}

type UpdateRequest struct {
    Name *string `json:"name,omitempty" validate:"omitempty,min=2"`
}
```

### Repository Pattern

The `Repository` interface lives in the `user` package, so the service layer depends on an abstraction rather than a concrete database driver. That is what makes the business logic testable with a mock or an in-memory implementation. The Postgres implementation lives in `internal/platform/postgres`, keeping infrastructure concerns out of domain logic while still satisfying the interface through Go's implicit interface satisfaction.

```go
// internal/user/repository.go
package user

import "context"

type Repository interface {
    Get(ctx context.Context, id int64) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, u *User) error
    Update(ctx context.Context, u *User) error
    Delete(ctx context.Context, id int64) error
    List(ctx context.Context, offset, limit int) ([]*User, error)
}
```

```go
// internal/platform/postgres/user_repository.go
package postgres

import (
    "context"
    "database/sql"
    "errors"
    "fmt"

    "myproject/internal/user"
)

type UserRepository struct {
    db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository {
    return &UserRepository{db: db}
}

func (r *UserRepository) Get(ctx context.Context, id int64) (*user.User, error) {
    var u user.User
    err := r.db.QueryRowContext(ctx,
        "SELECT id, email, name, created_at FROM users WHERE id = $1",
        id,
    ).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
    if errors.Is(err, sql.ErrNoRows) {
        return nil, user.ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("get user %d: %w", id, err)
    }
    return &u, nil
}
```

Two details in that method are worth more than they look.

**Use `errors.Is`, not `==`, against `sql.ErrNoRows`.** The two are equivalent only as long as nothing wraps the error. The moment a driver, a middleware layer, or your own retry helper returns `fmt.Errorf("query users: %w", sql.ErrNoRows)`, an `==` comparison stops matching, the sentinel escapes the repository, and a routine empty result surfaces to the caller as an opaque 500 rather than a clean `ErrNotFound`. `errors.Is` walks the wrap chain and keeps matching.

**Return `nil` for the value whenever you return an error.** The tempting one-liner `return &u, err` is wrong even though it compiles and reads fine. On a connection failure it hands the caller a non-nil pointer to a zero-value `User` alongside the error. The Go convention is that on a non-nil error the other return values are not meaningful, so return `nil` and make that unambiguous.

This is not a style nit, and the service layer later in this section shows why. Its `Create` checks uniqueness like this:

```go
existing, err := s.repo.GetByEmail(ctx, req.Email)
if err != nil && !errors.Is(err, ErrNotFound) {
    return nil, fmt.Errorf("check email: %w", err)
}
if existing != nil {
    return nil, ErrEmailExists
}
```

That logic is correct only because the repository returns `nil` together with `ErrNotFound`. Wire it to a repository that does `return &u, err` instead, and `existing` is non-nil for an email that does not exist, so every single new signup is rejected with `ErrEmailExists`. A one-character habit in the data layer silently breaks registration for the whole product, and the repository's own unit tests, which check the error, still pass.

Note also that `postgres` imports `user`, never the reverse. The interface is declared in the consuming package and the implementation depends on it, so the dependency arrow points inward at the domain and no cycle is possible.

### Service Layer

The service layer is where business rules live: it orchestrates validation, uniqueness enforcement, persistence, and event publication in a single transactional flow without knowing anything about HTTP or SQL. Injecting both `Repository` and `EventBus` as interfaces means you can swap out Postgres for a different store or replace the event bus with a no-op during tests without changing a line of business logic.

```go
// internal/user/service.go
package user

import (
    "context"
    "errors"
    "fmt"
    "time"

    "github.com/go-playground/validator/v10"
)

// validate is reused across calls. The validator caches struct
// reflection metadata, so constructing one per request is wasteful.
var validate = validator.New()

type Service struct {
    repo     Repository
    eventBus EventBus
}

func NewService(repo Repository, eventBus EventBus) *Service {
    return &Service{repo: repo, eventBus: eventBus}
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    // Validation
    if err := validate.Struct(req); err != nil {
        return nil, fmt.Errorf("validation: %w", err)
    }

    // Check uniqueness
    existing, err := s.repo.GetByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, ErrNotFound) {
        return nil, fmt.Errorf("check email: %w", err)
    }
    if existing != nil {
        return nil, ErrEmailExists
    }

    // Create user
    u := &User{
        Email:     req.Email,
        Name:      req.Name,
        CreatedAt: time.Now(),
    }
    if err := s.repo.Create(ctx, u); err != nil {
        return nil, fmt.Errorf("create: %w", err)
    }

    // Publish event
    s.eventBus.Publish("user.created", u)

    return u, nil
}
```

### HTTP Handler

The handler's only job is to translate between HTTP and the service layer: decode the request body, call the service, write a response. It holds no business logic of its own. Errors go to a shared `handleError` helper that maps domain errors like `ErrNotFound` onto status codes, which keeps the same switch statement from reappearing in every handler method.

```go
// internal/user/handler.go
package user

import (
    "encoding/json"
    "net/http"
)

type Handler struct {
    service *Service
}

func NewHandler(service *Service) *Handler {
    return &Handler{service: service}
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    var req CreateRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    user, err := h.service.Create(r.Context(), req)
    if err != nil {
        handleError(w, err)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}
```

### Staff Lens: Feature Package Boundaries

A feature package (like `user` above) should encapsulate its domain. External callers interact with it through a defined API: service methods, handlers, maybe an interface exposed for testing. Internal details (repository implementation, private helpers) are not exported.

This is the test: could you swap the `user` package's database implementation (Postgres to DynamoDB) without touching any other package? If yes, the boundaries are clean. If no, other packages are reaching into implementation details. Fix it.

---
