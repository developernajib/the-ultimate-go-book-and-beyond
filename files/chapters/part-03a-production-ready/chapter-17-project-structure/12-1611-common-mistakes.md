## 17.11 Common Mistakes

### Mistake 1: Circular Dependencies

Circular imports are a compile error in Go, but the underlying design problem, mutual dependency between packages, appears first as a code smell and must be resolved architecturally. The standard fix is to define an interface in the dependent package that the depended-on package can satisfy without importing back, breaking the cycle by depending on an abstraction rather than a concrete type.

```go
// BAD: Circular import
// package user imports package order
// package order imports package user

// user/service.go
package user

import "myapp/internal/order"

type Service struct {
    orderSvc *order.Service // Imports order
}

// order/service.go
package order

import "myapp/internal/user"

type Service struct {
    userSvc *user.Service // Imports user - CIRCULAR!
}
```

**Fix: Use interfaces defined at point of use**

The subtle part: the interface alone is not enough, because its method signature would still mention the other package's types. Define a local view of the data alongside it. The `order` package declares what a customer looks like *to order processing*, and any type with a matching method satisfies the interface, including an adapter over the real `user.Service`.

```go
// order/service.go
package order

// Local view of the data this package needs. No user import.
type Customer struct {
    ID    int64
    Email string
}

type CustomerGetter interface {
    GetCustomer(id int64) (Customer, error)
}

type Service struct {
    customers CustomerGetter // cycle broken
}

func NewService(c CustomerGetter) *Service { return &Service{customers: c} }
```

The adapter is the piece that makes this real, and it lives at the composition root, where knowing about both packages is the entire job:

```go
// cmd/api/adapter.go
package main

import (
    "myapp/internal/order"
    "myapp/internal/user"
)

// userAdapter satisfies order.CustomerGetter over the real user.Service.
type userAdapter struct{ svc *user.Service }

func (a userAdapter) GetCustomer(id int64) (order.Customer, error) {
    u, err := a.svc.Get(id)
    if err != nil {
        return order.Customer{}, err
    }
    return order.Customer{ID: u.ID, Email: u.Email}, nil
}

// wiring:
//   orderSvc := order.NewService(userAdapter{svc: user.NewService()})
```

You can verify the cycle is gone rather than take it on faith. Ask the toolchain what `order` actually depends on:

```
$ go list -deps ./internal/order | grep myapp
myapp/internal/order
```

Only itself. The `order` package no longer references `user` at all, so the two can be compiled, tested, and reasoned about independently, and `main` absorbs the knowledge that they are related. That is the trade: cycles do not vanish, they get pushed to the one place that is allowed to know everything.

### Mistake 2: Everything in `pkg/`

The `pkg/` directory is a Go convention for code that is intentionally exported and intended for use by external consumers of the module. Placing internal business logic there removes the compiler's enforcement of privacy: any other Go module can import it, which makes refactoring harder and exposes implementation details that were never meant to be public API.

```
BAD: business logic parked in pkg/

pkg/
├── user/
├── order/
└── database/     <- any module on the internet can now import these
```

**Fix: Use `internal/` for private code**

```
internal/         <- the toolchain refuses external imports
├── user/
├── order/
└── database/

pkg/              <- only genuinely reusable libraries, if you use pkg/ at all
└── validator/
```

### Mistake 3: Giant Packages

Consolidating all application code into a single package eliminates Go's package-level encapsulation and turns every unexported identifier into shared mutable state across the whole codebase. As file count grows, compilation times increase and it becomes impossible to test components in isolation because everything is visible to everything else within the same package.

```
BAD: everything in one package

internal/
└── app/
    ├── user_model.go
    ├── user_service.go
    ├── user_handler.go
    ├── order_model.go
    ├── order_service.go
    ├── order_handler.go
    └── ... (50 more files)
```

**Fix: Split by feature**

```
internal/
├── user/
│   ├── model.go
│   ├── service.go
│   └── handler.go
└── order/
    ├── model.go
    ├── service.go
    └── handler.go
```

### Mistake 4: Leaking Implementation Details

Embedding database-specific types like `sql.NullString` or `pgtype.Timestamp` directly in domain models couples the entire codebase to the persistence technology: changing the database then requires changing the domain. The repository pattern solves this by mapping between a clean domain model and an internal persistence row type within the repository implementation, keeping the domain layer infrastructure-agnostic.

```go
// BAD: Exposing database types in domain
type User struct {
    ID        int64          `db:"id"`           // Database tag
    Email     sql.NullString `db:"email"`        // SQL type!
    CreatedAt pgtype.Timestamp                    // Postgres type!
}
```

**Fix: Separate domain from infrastructure**

```go
// internal/domain/user/model.go
type User struct {
    ID        int64
    Email     string
    CreatedAt time.Time
}

// internal/platform/postgres/user_repository.go
type userRow struct {
    ID        int64          `db:"id"`
    Email     sql.NullString `db:"email"`
    CreatedAt pgtype.Timestamp
}

func (r *Repository) Get(id int64) (*user.User, error) {
    var row userRow
    // ... query
    return row.toDomain(), nil
}
```

### Mistake 5: Configuration in Code

Hardcoding connection strings, credentials, or environment-specific settings directly in source code makes it impossible to deploy the same binary to multiple environments without rebuilding, and risks committing secrets to version control. Accepting configuration as structured parameters received at startup, loaded from environment variables or a config file, keeps secrets out of the codebase and makes each environment's behavior explicit and auditable.

```go
// BAD: Hardcoded configuration
func Connect() *sql.DB {
    db, _ := sql.Open("postgres",
        "host=localhost port=5432 user=admin password=secret")
    return db
}
```

**Fix: Externalize configuration**

```go
func Connect(cfg DatabaseConfig) (*sql.DB, error) {
    dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s",
        cfg.Host, cfg.Port, cfg.User, cfg.Password)
    return sql.Open("postgres", dsn)
}
```

### Additional Mistakes to Flag

1. **Import cycles between layers.** If `domain` imports `infrastructure`, the layering is wrong. The arrow points inward.
2. **Unit tests exiled to a separate directory.** A test for `foo.go` belongs in `foo_test.go` beside it, where it can reach unexported identifiers and where nobody has to go looking for it. Integration and end-to-end suites are the exception and may reasonably live under `test/`, as 17.7 covers, but that is about the environment they need, not about hiding them.
3. **Huge `main.go` with business logic.** `main` should be wiring only. Move logic to internal packages.
4. **No go.mod at the project root.** A module is defined by its `go.mod`, so nesting a second one inside a repo splits it into two independently versioned units, and the parent no longer builds the child with `./...`. That is occasionally what you want (a `tools/` module, an `examples/` module that pulls heavy dependencies). Usually it is an accident, and it is worth being sure which one you are doing.

**A non-mistake worth naming, because it gets flagged in review by people who mean well: exported identifiers inside `internal/`.** These are not a contradiction, they are the entire mechanism. `internal/` restricts *who may import the package*, and export restricts *what they see once they may*. The two controls are independent and you need both:

```go
// internal/user/service.go
package user

type Service struct{ ... }        // exported: cmd/api must construct it
func NewService() *Service        // exported: same
type hidden struct{}              // unexported: private even inside the module
```

If you kept `internal/user` fully unexported, nothing could use it, including the `cmd/api` it exists to serve:

```
cmd/api/main2.go:5:14: undefined: user.hidden
```

The rule is simply the ordinary one: export what the rest of *your module* legitimately needs, keep the rest unexported, and let `internal/` guarantee that "the rest of your module" is where it stops. Moving a package to `pkg/` to justify its exports gets it exactly backwards, since that is the change that actually does make it public API you now owe the world compatibility on.

### Staff Lens: Structure-Drift Detection

A codebase's structure drifts as new code arrives. Over months, layered projects accumulate cross-layer violations, feature-based projects accumulate god packages, and every project accumulates dead code. The staff-level intervention: annual or semi-annual structural review. Check: does the current layout still match the service? Are there violations? Is there dead code? Schedule the cleanup, make it a team priority, measure the improvement.

---
