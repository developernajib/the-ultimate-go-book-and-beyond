## 17.14 Package Naming and Documentation Mistakes

This section covers naming, documentation, and structural mistakes that silently degrade code quality and team velocity. These traps are especially insidious because the code compiles and runs fine while accumulating confusion that compounds over months.

### Ignoring Package Name Collisions

One of the most common mistakes in Go projects is naming your package the same as a standard library package. A local package named `http`, `errors`, `sync`, or `context` collides with the standard library one, and the moment a file needs both, it is forced into awkward aliased imports.

Be precise about the mechanism, because the folklore version is wrong. An import does **not** bind the last segment of the import path. It binds the name in the package's `package` clause. The two match by convention, and tooling nudges you to keep them matching, but the language does not require it:

```go
// myapp/internal/errors/errors.go
package apperror // clause disagrees with the directory name
```

```go
import (
    "errors"                 // stdlib
    "myapp/internal/errors"  // path ends in /errors ...
)

// ... but this compiles with no alias, because the clause bound `apperror`:
e := apperror.New(404, "not found")
_ = errors.New("stdlib errors still reachable")
```

`go list` confirms which name actually got bound:

```
$ go list -f '{{.ImportPath}} -> package {{.Name}}' ./internal/errors
myapp/internal/errors -> package apperror
```

This matters for the fix. The collision is caused by the `package` clause, so renaming only the directory changes nothing, and a mismatched clause is its own trap: readers and tooling expect the name to follow the path, so anyone importing `myapp/internal/errors` will reasonably write `errors.New(...)` and get a confusing failure. Rename both together.

```go
// BAD: Your project has a package named "errors"
// myapp/internal/errors/errors.go
package errors

// Custom error types for the application
type AppError struct {
    Code    int
    Message string
}

func New(code int, msg string) *AppError {
    return &AppError{Code: code, Message: msg}
}
```

Now every file that needs both your `errors` package and the standard library `errors` package has to do this:

```go
// internal/user/service.go
package user

import (
    stderrors "errors"                  // Awkward alias for stdlib
    apperrors "myapp/internal/errors"   // Awkward alias for your package
)

func (s *Service) GetUser(id int64) (*User, error) {
    u, err := s.repo.Get(id)
    if err != nil {
        if stderrors.Is(err, sql.ErrNoRows) {   // Which errors is this?
            return nil, apperrors.New(404, "user not found")
        }
        return nil, err
    }
    return u, nil
}
```

Every developer reading this code has to mentally track two `errors` packages. Import aliases accumulate inconsistently across the codebase, one file uses `stderrors`, another uses `goerrors`, a third uses `liberrors`. The cognitive tax is real and grows linearly with every file.

**The fix is straightforward**: name your packages by what they provide, not by a generic concept that overlaps with the standard library.

```go
// GOOD: Descriptive name that avoids collision
// myapp/internal/apperror/apperror.go
package apperror

// AppError represents a structured application error with an error code.
type AppError struct {
    Code    int
    Message string
}

// New creates an AppError with the given code and message.
func New(code int, msg string) *AppError {
    return &AppError{Code: code, Message: msg}
}
```

```go
// internal/user/service.go
package user

import (
    "errors"                        // Standard library, no alias needed
    "myapp/internal/apperror"       // Clear, no collision
)

func (s *Service) GetUser(id int64) (*User, error) {
    u, err := s.repo.Get(id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, apperror.New(404, "user not found")
        }
        return nil, err
    }
    return u, nil
}
```

No aliases, no confusion. The code reads naturally.

**Standard library packages you must never shadow:**

| Package | Why It's Dangerous |
|---------|-------------------|
| `errors` | Used everywhere for `errors.Is()`, `errors.As()`, `errors.New()` |
| `context` | Every function with I/O takes `context.Context` |
| `http` | Core of any web application |
| `sync` | Mutexes, WaitGroups, Once, used in any concurrent code |
| `log` | Logging is pervasive |
| `io` | Readers, Writers, Closers, foundational interfaces |
| `fmt` | String formatting appears in nearly every file |
| `strings` | String manipulation is ubiquitous |
| `time` | Timestamps, durations, tickers, used everywhere |
| `testing` | Every test file imports it |
| `net` | Networking primitives |
| `os` | File system, environment, process management |
| `sort` | Sorting collections |
| `math` | Numeric operations |

**Package names to avoid entirely:** `types`, `models`, `common`, `base`, `core` (when used generically). These names say nothing about what the package does and frequently collide with mental models of standard library concepts.

### Creating Utility and Helper Packages

Packages named `utils`, `helpers`, `common`, `misc`, or `shared` are anti-patterns in Go. They are a symptom of not thinking about package design, a grab bag where unrelated functions accumulate until the package violates every principle of cohesion.

```go
// BAD: The classic "utils" dumping ground
// internal/utils/utils.go
package utils

import (
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "net/mail"
    "strings"
    "time"
    "unicode"
)

func FormatTime(t time.Time) string {
    return t.Format("2006-01-02 15:04:05")
}

func ValidateEmail(email string) bool {
    _, err := mail.ParseAddress(email)
    return err == nil
}

func GenerateID() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func Slugify(s string) string {
    s = strings.ToLower(s)
    // ... 30 more lines
    return s
}

func TruncateString(s string, maxLen int) string {
    if len(s) <= maxLen {
        return s
    }
    return s[:maxLen] + "..."
}

func IsAlphanumeric(s string) bool {
    for _, r := range s {
        if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
            return false
        }
    }
    return true
}

func FormatCurrency(amount int64) string {
    return fmt.Sprintf("$%.2f", float64(amount)/100)
}
```

This package has seven functions that do seven unrelated things. It imports seven different standard library packages. It will only grow. In six months it will have forty functions, and every package in the project will import it, creating a dependency bottleneck that triggers rebuilds on every change.

The core problem: `utils` tells you nothing about what the package provides. It is named for what it *is* (a utility) rather than what it *does*. Go packages should be named by their purpose.

**The fix**: distribute functions to packages named by their domain.

```go
// GOOD: Package named by purpose

// internal/timefmt/timefmt.go
package timefmt

import "time"

// Format renders a time value in the application's standard display format.
func Format(t time.Time) string {
    return t.Format("2006-01-02 15:04:05")
}

// FormatDate renders only the date portion.
func FormatDate(t time.Time) string {
    return t.Format("2006-01-02")
}
```

```go
// internal/validation/email.go
package validation

import "net/mail"

// Email checks whether the given string is a valid email address
// according to RFC 5322.
func Email(email string) bool {
    _, err := mail.ParseAddress(email)
    return err == nil
}
```

```go
// internal/slug/slug.go
package slug

import "strings"

// From converts a human-readable string into a URL-safe slug.
func From(s string) string {
    s = strings.ToLower(s)
    // ... conversion logic
    return s
}
```

```go
// internal/currency/format.go
package currency

import "fmt"

// Format converts a cent amount to a human-readable dollar string.
func Format(cents int64) string {
    return fmt.Sprintf("$%.2f", float64(cents)/100)
}
```

Now each package has a clear purpose, minimal surface area, and only the imports it needs. Callers read naturally: `timefmt.Format(t)`, `validation.Email(addr)`, `slug.From(title)`, `currency.Format(amount)`.

**When utility packages are acceptable:** test helpers are a legitimate exception. A `testutil` or `testhelper` package used only in `*_test.go` files is fine because its scope is narrow and its audience is well defined:

```go
// internal/testutil/db.go
package testutil

import (
    "database/sql"
    "testing"

    _ "github.com/lib/pq" // registers the "postgres" driver
)

// SetupTestDB opens a verified test database connection and registers cleanup.
func SetupTestDB(t *testing.T) *sql.DB {
    t.Helper()
    db, err := sql.Open("postgres", "postgres://test:test@localhost/testdb?sslmode=disable")
    if err != nil {
        t.Fatalf("open test db: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    // sql.Open is lazy: it parses the DSN but never dials. Without this
    // Ping, a down database is not reported here, it surfaces later as a
    // baffling error inside whichever query happens to run first.
    if err := db.PingContext(t.Context()); err != nil {
        t.Fatalf("ping test db: %v", err)
    }
    return db
}
```

**Decision framework for "where does this function belong?":**

| Question | If Yes |
|----------|--------|
| Does it operate on a specific domain type? | Put it in that domain package |
| Is it a pure transformation (string, time, money)? | Create a focused package named by subject |
| Is it used by exactly one caller? | Put it in the caller's package (unexported) |
| Is it a test helper? | Put it in `testutil` |
| Is it generic infrastructure (logging, metrics)? | Create a dedicated infrastructure package |

### Missing Code Documentation

Go has a documentation system built into the language. The `go doc` tool and `pkg.go.dev` generate browsable documentation directly from source code comments. When exported types, functions, methods, constants, and variables lack doc comments, the generated documentation is empty, and developers relying on your package have to read the source to understand it.

The convention is simple: a doc comment starts with the name of the thing it documents.

```go
// BAD: Missing and incorrect documentation

// this package handles users
package user

// The struct for users
type User struct {
    ID    int64
    Email string
    Name  string
}

// creates a new user
func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    // ...
}

// this validates the request
func validateRequest(req CreateRequest) error {
    // ...
}
```

Every comment above violates Go conventions. The package comment does not start with "Package user". The type comment does not start with "User". The method comment does not start with "Create".

It is worth being accurate about the consequence, because it is often overstated. These comments **do** render. `go doc` attaches whatever comment precedes a declaration, so the bad version produces:

```
$ go doc ./bad
package user // import "d/bad"

this package handles users
```

Nothing errors, `gofmt` is silent, and `go vet` is clean, because vet does not check doc-comment prose. That is exactly why this decays: no tool stops you.

The cost is in the reading. Doc comments are extracted and shown out of context, in a list, next to the identifier they describe. A reader scanning `pkg.go.dev` sees "creates a new user" floating beside `Create` and learns nothing the signature did not already say, whereas "Create registers a new user with the given email address" survives being read alone. Starting with the identifier's name is what makes a sentence work in that setting, and it also makes the docs greppable: searching for `Create` finds the sentence about `Create`. Convention here is not ceremony, it is what makes generated docs legible.

If you want the rule enforced rather than merely encouraged, that is a linter's job: `revive`'s `exported` rule and `staticcheck`'s ST1000/ST1020/ST1021 checks flag exactly these.

**Properly documented code:**

```go
// Package user provides domain logic for user account management,
// including creation, authentication, and profile operations.
package user

import (
    "context"
    "errors"
    "time"
)

// ErrNotFound is returned when a requested user does not exist.
var ErrNotFound = errors.New("user not found")

// ErrEmailExists is returned when attempting to create a user
// with an email address that is already registered.
var ErrEmailExists = errors.New("email already exists")

// MaxNameLength is the maximum allowed length for a user's display name.
const MaxNameLength = 100

// User represents a registered user in the system.
type User struct {
    // ID is the unique identifier assigned at creation.
    ID int64

    // Email is the user's email address, used for authentication.
    Email string

    // Name is the user's display name.
    Name string

    // CreatedAt is the timestamp when the account was created.
    CreatedAt time.Time
}

// Repository defines the data access contract for user persistence.
type Repository interface {
    // Get retrieves a user by ID. Returns ErrNotFound if the user
    // does not exist.
    Get(ctx context.Context, id int64) (*User, error)

    // GetByEmail retrieves a user by email address. Returns ErrNotFound
    // if no user with that email exists.
    GetByEmail(ctx context.Context, email string) (*User, error)

    // Save persists a new or updated user record.
    Save(ctx context.Context, u *User) error
}

// Service implements user business logic. It depends on a Repository
// for persistence and an EventBus for publishing domain events.
type Service struct {
    repo     Repository
    eventBus EventBus
}

// NewService creates a Service with the given dependencies.
func NewService(repo Repository, eventBus EventBus) *Service {
    return &Service{repo: repo, eventBus: eventBus}
}

// Create registers a new user account. It validates the input,
// checks for email uniqueness, persists the user, and publishes
// a "user.created" event. Returns ErrEmailExists if the email
// is already registered.
func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    // ... implementation
}

// Deprecated: GetByName is slow and will be removed in v2.
// Use GetByEmail instead.
func (s *Service) GetByName(ctx context.Context, name string) (*User, error) {
    // ...
}
```

**Key documentation rules:**

1. **Package comment**: Starts with `Package <name>`. Place it in the file with the same name as the package (e.g., `user.go` for `package user`), or in a dedicated `doc.go` file for longer descriptions.

2. **Exported identifiers**: Every exported type, function, method, constant, and variable gets a comment starting with its name.

3. **Unexported identifiers**: Document unexported functions and types when the logic is non-obvious. Not mandatory, but valuable for complex internal code.

4. **Deprecated markers**: Use `// Deprecated: reason.` on its own line in the doc comment. Tools like `staticcheck` and IDEs recognize this format and will warn callers.

**Using `go doc` to verify your documentation:**

```bash
# View package documentation
$ go doc myapp/internal/user
package user // import "myapp/internal/user"

Package user provides domain logic for user account management, including
creation, authentication, and profile operations.

const MaxNameLength = 100
var ErrEmailExists = errors.New("email already exists")
var ErrNotFound = errors.New("user not found")
type CreateRequest struct{ ... }
type EventBus interface{ ... }
type Repository interface{ ... }
type Service struct{ ... }
    func NewService(repo Repository, eventBus EventBus) *Service
type User struct{ ... }

# View a specific function
$ go doc myapp/internal/user Service.Create
func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error)
    Create registers a new user account. It validates the input, checks for
    email uniqueness, persists the user, and publishes a "user.created" event.
    Returns ErrEmailExists if the email is already registered.

# View unexported identifiers too
$ go doc -all myapp/internal/user

# View source alongside documentation
$ go doc -src myapp/internal/user NewService
```

Two details in that output are worth noticing, because they are the reason to run the tool rather than imagine its output.

`go doc` **groups constructors under the type they return**. `NewService` appears indented beneath `type Service` rather than in a flat function list. The rule keys on the return type, not the name: `BuildUserService(repo Repository) *Service` files itself under `Service` exactly the same way, and a function returning a package-level interface groups under that interface. Only functions that return something which is not a type of this package (`MakeThing() string`) stay top-level. Your documentation's structure is therefore a consequence of your signatures, which is one more reason to return a meaningful named type from a constructor.

The listing is also **sorted and grouped, not source-ordered**: constants, then variables, then types, each alphabetized. Your carefully arranged file order is invisible to readers of the docs, which is another reason each comment has to stand on its own.

Run `go doc` on your packages regularly. If the output looks sparse or confusing, your documentation needs work.

### Circular Import Dependencies

Go enforces a strict rule: import cycles are not allowed. If package `a` imports package `b`, then package `b` cannot import package `a`, whether directly or transitively through any chain of other packages. This is a compile-time error, not a runtime warning. Projects that grow without intentional package design inevitably hit this wall.

```go
// The circular dependency scenario

// internal/user/service.go
package user

import "myapp/internal/notification"  // user imports notification

type Service struct {
    notifier *notification.Service
}

func (s *Service) Create(ctx context.Context, u *User) error {
    // ... create user
    s.notifier.SendWelcomeEmail(u.Email, u.Name)  // Needs notification
    return nil
}

// internal/notification/service.go
package notification

import "myapp/internal/user"  // notification imports user

type Service struct {
    users *user.Service
}

func (s *Service) SendWeeklyDigest(ctx context.Context, userID int64) error {
    u, err := s.users.GetByID(ctx, userID)  // Needs user info
    if err != nil {
        return err
    }
    // ... send digest with user's name and preferences
    return nil
}

// COMPILE ERROR:
// import cycle not allowed
// package myapp/internal/user
//     imports myapp/internal/notification
//     imports myapp/internal/user
```

There are three established solutions, each with different trade-offs:

**Solution 1: Extract shared types into a third package**

Move the types that both packages need into a neutral package that neither owns.

```go
// internal/domain/types.go
package domain

// UserInfo contains user data needed across package boundaries.
type UserInfo struct {
    ID    int64
    Email string
    Name  string
}

// internal/user/service.go
package user

import "myapp/internal/domain"

type Service struct {
    repo     Repository
    notifier Notifier
}

// Notifier is the interface for what user package needs from notifications.
type Notifier interface {
    SendWelcomeEmail(email, name string) error
}

func (s *Service) Create(ctx context.Context, u *domain.UserInfo) error {
    // ... create user
    s.notifier.SendWelcomeEmail(u.Email, u.Name)
    return nil
}

// internal/notification/service.go
package notification

import "myapp/internal/domain"

type Service struct {
    userFetcher UserFetcher
}

// UserFetcher is the interface for what notification needs from users.
type UserFetcher interface {
    GetByID(ctx context.Context, id int64) (*domain.UserInfo, error)
}

func (s *Service) SendWeeklyDigest(ctx context.Context, userID int64) error {
    u, err := s.userFetcher.GetByID(ctx, userID)
    if err != nil {
        return err
    }
    // ... send digest
    return nil
}
```

**Solution 2: Use interfaces (Dependency Inversion)**

This is usually the cleanest approach. Each package defines an interface for what it needs from the other, and the composition root wires them together.

```go
// internal/user/service.go
package user

// Notifier defines the notification capability that user needs.
type Notifier interface {
    SendWelcomeEmail(email, name string) error
}

type Service struct {
    repo     Repository
    notifier Notifier
}

func NewService(repo Repository, notifier Notifier) *Service {
    return &Service{repo: repo, notifier: notifier}
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    u := &User{Email: req.Email, Name: req.Name}
    if err := s.repo.Save(ctx, u); err != nil {
        return nil, err
    }
    s.notifier.SendWelcomeEmail(u.Email, u.Name)
    return u, nil
}

func (s *Service) GetByID(ctx context.Context, id int64) (*User, error) {
    return s.repo.Get(ctx, id)
}

// internal/notification/service.go
package notification

// UserFetcher defines the user data access that notification needs.
type UserFetcher interface {
    GetByID(ctx context.Context, id int64) (*UserInfo, error)
}

// UserInfo is what notification needs to know about a user.
// Defined here to avoid importing the user package.
type UserInfo struct {
    ID    int64
    Email string
    Name  string
}

type Service struct {
    userFetcher UserFetcher
    mailer      Mailer
}

func NewService(userFetcher UserFetcher, mailer Mailer) *Service {
    return &Service{userFetcher: userFetcher, mailer: mailer}
}

func (s *Service) SendWelcomeEmail(email, name string) error {
    return s.mailer.Send(email, "Welcome!", "Hello "+name)
}

func (s *Service) SendWeeklyDigest(ctx context.Context, userID int64) error {
    u, err := s.userFetcher.GetByID(ctx, userID)
    if err != nil {
        return err
    }
    return s.mailer.Send(u.Email, "Weekly Digest", "...")
}

// cmd/api/main.go - Composition root wires everything together
func main() {
    userRepo := postgres.NewUserRepository(db)
    mailer := sendgrid.NewMailer(cfg.SendGrid)

    // Create notification service first (it has no dependency on user.Service)
    notificationSvc := notification.NewService(
        &userFetcherAdapter{repo: userRepo},  // Adapter wraps repo
        mailer,
    )

    // Create user service with notification service as its Notifier
    userSvc := user.NewService(userRepo, notificationSvc)
}

// userFetcherAdapter adapts our user repo to notification's UserFetcher interface
type userFetcherAdapter struct {
    repo *postgres.UserRepository
}

func (a *userFetcherAdapter) GetByID(ctx context.Context, id int64) (*notification.UserInfo, error) {
    u, err := a.repo.Get(ctx, id)
    if err != nil {
        return nil, err
    }
    return &notification.UserInfo{
        ID:    u.ID,
        Email: u.Email,
        Name:  u.Name,
    }, nil
}
```

**Solution 3: Invert the dependency direction with events**

For loosely coupled systems, use an event bus so packages do not need to know about each other at all.

```go
// internal/event/bus.go
package event

// Event represents a domain event.
type Event struct {
    Type    string
    Payload any
}

// Bus defines the event publishing and subscribing contract.
type Bus interface {
    Publish(e Event)
    Subscribe(eventType string, handler func(Event))
}

// internal/user/service.go
package user

import "myapp/internal/event"

type Service struct {
    repo     Repository
    eventBus event.Bus
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (*User, error) {
    u := &User{Email: req.Email, Name: req.Name}
    if err := s.repo.Save(ctx, u); err != nil {
        return nil, err
    }
    // Publish event - user package has no idea who handles it
    s.eventBus.Publish(event.Event{
        Type:    "user.created",
        Payload: map[string]string{"email": u.Email, "name": u.Name},
    })
    return u, nil
}

// internal/notification/service.go
package notification

import "myapp/internal/event"

// RegisterHandlers subscribes to events that notification cares about.
func (s *Service) RegisterHandlers(bus event.Bus) {
    bus.Subscribe("user.created", s.handleUserCreated)
}

func (s *Service) handleUserCreated(e event.Event) {
    payload := e.Payload.(map[string]string)
    s.mailer.Send(payload["email"], "Welcome!", "Hello "+payload["name"])
}
```

**Which solution to choose:**

| Approach | Best When | Trade-off |
|----------|-----------|-----------|
| Shared types package | Both packages need the same data structures | Introduces a third package to maintain |
| Interfaces (DI) | Dependencies are clear and testability matters | Requires adapters at composition root |
| Events | Packages should be fully decoupled | Harder to trace execution flow, eventual consistency |

### Incorrect Use of internal/ Packages

Go enforces `internal/` directory visibility rules at the compiler level: the mechanism landed in Go 1.4 for the standard library and has been enforced for all modules since Go 1.5. Code inside an `internal/` directory is only importable by code rooted at the parent of `internal/`. This is not a convention, it is enforced by `go build`.

The common mistake is placing shared code inside an `internal/` directory and then being surprised when sibling modules or services cannot import it.

```
// WRONG: Shared code buried in one service's internal/

monorepo/
├── services/
│   ├── api/
│   │   ├── go.mod
│   │   ├── cmd/
│   │   │   └── main.go
│   │   └── internal/
│   │       ├── auth/           # Authentication logic
│   │       │   └── jwt.go
│   │       └── middleware/     # HTTP middleware
│   │           └── logging.go
│   └── worker/
│       ├── go.mod
│       ├── cmd/
│       │   └── main.go
│       └── internal/
│           └── processor/
│               └── job.go
```

```go
// services/worker/cmd/main.go
package main

import (
    "monorepo/services/api/internal/auth"       // COMPILE ERROR
    "monorepo/services/api/internal/middleware"  // COMPILE ERROR
)

// use of internal package monorepo/services/api/internal/auth not allowed
```

The worker service cannot import anything from `services/api/internal/` because it is outside the `services/api/` subtree.

**Understanding the visibility rule:**

```
a/
├── b/
│   └── internal/
│       └── secret/
│           └── secret.go     # Only importable by code in a/b/
├── c/
│   └── main.go              # CANNOT import a/b/internal/secret
└── internal/
    └── shared/
        └── shared.go         # Importable by code in a/ and all its subdirectories
```

The rule is: code in `X/internal/Y` is only importable by code whose import path has `X/` as a prefix.

**Proper layout: place `internal/` at the right level based on who needs access.**

```
// CORRECT: internal/ at the right level for the right scope

monorepo/
├── internal/                   # Shared across ALL services in this module
│   ├── auth/
│   │   └── jwt.go             # Both api and worker can import this
│   └── middleware/
│       └── logging.go         # Both api and worker can import this
├── services/
│   ├── api/
│   │   ├── cmd/
│   │   │   └── main.go
│   │   └── internal/          # Private to the api service ONLY
│   │       ├── handler/
│   │       │   └── user.go
│   │       └── routes/
│   │           └── router.go
│   └── worker/
│       ├── cmd/
│       │   └── main.go
│       └── internal/          # Private to the worker service ONLY
│           └── processor/
│               └── job.go
├── go.mod
└── go.sum
```

```go
// services/api/cmd/main.go
package main

import (
    "monorepo/internal/auth"                        // Shared internal - OK
    "monorepo/internal/middleware"                   // Shared internal - OK
    "monorepo/services/api/internal/handler"         // API's private code - OK
)

// services/worker/cmd/main.go
package main

import (
    "monorepo/internal/auth"                        // Shared internal - OK
    "monorepo/services/worker/internal/processor"   // Worker's private code - OK
    // "monorepo/services/api/internal/handler"      // COMPILE ERROR - correct!
)
```

Notice what else changed between the two trees, because it is easy to miss and it is not incidental: the broken layout gives every service its own `go.mod`, while the corrected one has a single `go.mod` at the repo root. That is what makes `monorepo/internal/auth` importable by both services. `internal/` scopes to the import-path subtree, so a shared `internal/` only works if the sharers live under the same root, which in practice means the same module.

If you genuinely need separate modules per service, `internal/` at the repo root will not help you, because each module's paths are rooted at its own `go.mod`. The shared code then has to become its own module with a real version (or a `replace`), and it can no longer sit in an `internal/` directory that the other modules are outside of. Choosing multi-module is therefore choosing to give up `internal/` as your sharing mechanism. Decide that on purpose.

**Guidelines for `internal/` placement:**

| Scope | Where to Put `internal/` | Who Can Import |
|-------|-------------------------|----------------|
| Module-wide shared code | `<module-root>/internal/` | Everything in the module |
| Service-specific code | `<service>/internal/` | Only that service |
| Package implementation details | `<package>/internal/` | Only that package |
| Truly public libraries | `pkg/` (not `internal/`) | Anyone, including external modules |

The key insight: `internal/` is not just "code I don't want external users to see." It is a compiler-enforced access control mechanism. Place it intentionally based on the exact scope of visibility you want.

### Not Using the cmd/ Layout for Multiple Binaries

Projects that produce more than one executable should use the `cmd/` directory pattern. Each subdirectory under `cmd/` contains a `main` package that produces one binary. The name of the subdirectory becomes the name of the compiled binary.

The anti-pattern is cramming everything into a single `main.go` or, worse, putting business logic directly in the `main` package.

```go
// BAD: Business logic in main.go

// main.go (root of project)
package main

import (
    "database/sql"
    "encoding/json"
    "log"
    "net/http"
    "os"
    "time"
)

type User struct {
    ID        int64     `json:"id"`
    Email     string    `json:"email"`
    Name      string    `json:"name"`
    CreatedAt time.Time `json:"created_at"`
}

var db *sql.DB  // Global database connection

func main() {
    var err error
    db, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }

    http.HandleFunc("/users", handleUsers)
    http.HandleFunc("/health", handleHealth)

    log.Printf("listening on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
    rows, err := db.Query("SELECT id, email, name, created_at FROM users")
    if err != nil {
        http.Error(w, "database error", http.StatusInternalServerError)
        return
    }
    defer rows.Close()

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt); err != nil {
            http.Error(w, "scan error", http.StatusInternalServerError)
            return
        }
        users = append(users, u)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(users)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
```

Problems with this approach:
- Business logic (query execution, serialization) lives in `main`, so it cannot be imported or tested independently.
- The global `db` variable makes unit testing impossible without a real database.
- Adding a second binary (a background worker, a CLI migration tool) requires duplicating the database setup, configuration loading, and model definitions.
- The `main` package cannot be imported by other packages, so anything defined in `main` is trapped there.

There is also a data-correctness bug hiding in `handleUsers`, and its presence is not a coincidence. The loop never calls `rows.Err()`. `Next` returns false both when rows run out and when iteration fails partway, and the standard library is explicit that `Err` is what distinguishes the two. As written, a mid-iteration failure returns HTTP 200 with a silently truncated user list, which is worse than an error. The fix is one block after the loop:

```go
if err := rows.Err(); err != nil {
    http.Error(w, "database error", http.StatusInternalServerError)
    return
}
```

The reason to raise it here, in a section about layout, is that this bug is a consequence of the layout. Query logic sitting in an unimportable `main` package cannot have a test written against it, so nothing was ever going to catch the omission. Move that loop into a repository package and its first unit test asks what happens when the query fails halfway.

**The correct approach: thin `cmd/` entry points with logic in importable packages.**

```
myproject/
├── cmd/
│   ├── api/
│   │   └── main.go           # HTTP server entry point
│   ├── worker/
│   │   └── main.go           # Background job processor
│   └── migrate/
│       └── main.go           # Database migration tool
├── internal/
│   ├── domain/
│   │   └── user/
│   │       ├── model.go
│   │       ├── service.go
│   │       └── repository.go
│   ├── platform/
│   │   └── postgres/
│   │       ├── client.go
│   │       └── user_repo.go
│   └── config/
│       └── config.go
└── go.mod
```

Each `main.go` is thin, its only job is to read configuration, construct dependencies, and call `Run()`:

```go
// cmd/api/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "myproject/internal/api"
    "myproject/internal/config"
    "myproject/internal/platform/postgres"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfg, err := config.Load()
    if err != nil {
        logger.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    db, err := postgres.Connect(cfg.Database)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    srv := api.NewServer(cfg.Server, db, logger)

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    if err := srv.Run(ctx); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

```go
// cmd/worker/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "myproject/internal/config"
    "myproject/internal/platform/postgres"
    "myproject/internal/worker"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfg, err := config.Load()
    if err != nil {
        logger.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    db, err := postgres.Connect(cfg.Database)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    w := worker.New(cfg.Worker, db, logger)

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    if err := w.Run(ctx); err != nil {
        logger.Error("worker error", "error", err)
        os.Exit(1)
    }
}
```

```go
// cmd/migrate/main.go
package main

import (
    "log/slog"
    "os"

    "myproject/internal/config"
    "myproject/internal/platform/postgres"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfg, err := config.Load()
    if err != nil {
        logger.Error("failed to load config", "error", err)
        os.Exit(1)
    }

    db, err := postgres.Connect(cfg.Database)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    direction := "up"
    if len(os.Args) > 1 {
        direction = os.Args[1]
    }

    if err := postgres.Migrate(db, direction); err != nil {
        logger.Error("migration failed", "direction", direction, "error", err)
        os.Exit(1)
    }

    logger.Info("migration completed", "direction", direction)
}
```

Building produces three separate binaries:

```bash
$ go build -o bin/api ./cmd/api
$ go build -o bin/worker ./cmd/worker
$ go build -o bin/migrate ./cmd/migrate

$ ls bin/
api     worker     migrate
```

**Rules for `cmd/` packages:**

| Rule | Why |
|------|-----|
| Keep `main.go` under 60 lines | Main is for wiring, not logic |
| No business logic in `main` | Cannot be imported, cannot be tested |
| No global variables | Use dependency injection instead |
| Each `cmd/` subdirectory = one binary | Clear mapping from directory to artifact |
| Share code via `internal/` packages | Avoid duplicating setup across binaries |
| Use `os.Exit()` only in `main` | Let libraries return errors, let `main` decide exit codes |

---

## Summary

Key project structure principles:

| Principle | Implementation |
|-----------|----------------|
| Layout | `cmd/` per binary, `internal/` for everything private. Add `pkg/` only if you can say what it buys |
| Feature organization | Group related code together, and let the import-cycle error tell you when a boundary is wrong |
| Dependency injection | Define interfaces at point of use, wire at the composition root |
| Configuration | Environment-based, typed, validated at startup, fail fast on bad values |
| Error handling | Domain errors plus a single HTTP mapping, never echo the error chain to clients |
| Testing | Unit tests beside the code, integration and e2e gated by a build tag or `-short` |
| Build system | A Makefile that is the one way to build, with reproducible version stamps |

**Practices worth stealing:**
1. Clear, stable package boundaries, so ownership and build caching both have something to attach to
2. Consistent service scaffolding, so any engineer can open any service and know where things live
3. Domain-driven separation of core logic from platform code
4. Clean architecture with explicit use-case packages, applied where the domain is genuinely complex

And the one thing to carry out of this chapter: `internal/` is the only part of any of this the compiler enforces. Everything else is a convention your team agrees to and has to maintain deliberately.

**Common pitfalls to avoid:**
- Circular imports
- Everything in `pkg/`
- Giant monolithic packages
- Leaking infrastructure into domain
- Hardcoded configuration

A well-structured project pays dividends in:
- Developer productivity
- Code maintainability
- Team scalability
- Deployment reliability

---

## Exercises

1. **REST API with Clean Architecture**: Build a fully functional REST API for a bookstore (CRUD for books and authors) organized using clean architecture principles. Your project must follow the standard Go layout with `cmd/`, `internal/`, and `pkg/` directories. Separate the project into `domain`, `service`, `repository`, and `handler` layers. Each layer should depend only on abstractions (interfaces), never on concrete implementations from an outer layer. Expected outcome: a runnable API where swapping the database (e.g., from in-memory to PostgreSQL) requires changing only the repository layer with zero modifications to domain or handler code.

2. **Dependency Injection Without a Framework**: Refactor a provided monolithic `main.go` that instantiates all dependencies inline (database, logger, cache, mailer) into a clean dependency injection setup using only the standard library and constructor functions. Implement a `wire.go`-style manual wiring file in your `cmd/` entry point that constructs the full dependency graph explicitly. Every struct must receive its dependencies through constructor parameters, no `init()` functions, no global variables, no `sync.Once` singletons. Expected outcome: a `cmd/api/main.go` under 60 lines that reads like a dependency graph, and every component independently unit-testable by injecting mocks.

3. **Separating Domain Logic from Infrastructure**: Take a user authentication service that currently mixes bcrypt hashing, JWT generation, and database calls inside a single `UserService` struct and split it into proper layers. The `domain/user` package must contain only pure business rules and entity definitions with no imports of `database/sql`, `net/http`, or any third-party library. Infrastructure concerns (hashing, token signing, persistence) must live in `infrastructure/` packages that implement domain-defined interfaces. Expected outcome: the `domain/user` package has zero non-standard-library imports, all infrastructure is replaceable via interfaces, and the domain logic is fully testable without any I/O.

4. **Designing pkg vs internal Package Boundaries**: You are given a multi-service repository (API server, background worker, CLI tool) that share common code in one large `shared/` package. Audit the package and redesign the boundary between `pkg/` (importable by external consumers) and `internal/` (restricted to this module). `pkg/` should expose only stable, well-documented, backward-compatible utilities (e.g., structured logger, HTTP client wrapper, config loader). `internal/` should hold all business-specific logic, database models, and service plumbing. Expected outcome: a written package manifest explaining every package's placement decision, a refactored directory tree, and confirmation that attempting to import an `internal/` package from a sibling module produces a compile-time error.

5. **Modular Monolith Structure**: Design and implement a modular monolith for an e-commerce platform with three bounded contexts: `catalog` (products, categories), `orders` (cart, checkout, order history), and `payments` (processing, refunds). Each module must be a self-contained Go package under `internal/` with its own domain types, service interfaces, repository interfaces, and HTTP handlers registered via a `Register(mux *http.ServeMux)` function. Cross-module communication must happen through published events or explicit service interfaces, never by importing another module's internal types directly. Expected outcome: each module compiles and tests independently, the main application wires all three modules together in under 100 lines, and removing one module requires zero changes to the other two.

6. **Migrating a Flat Package Structure to Domain-Organized**: You are given a project where all Go files live in a single root package (`package main` with 3,000+ lines across 15 files named `user.go`, `order.go`, `db.go`, `handlers.go`, etc.). Migrate this flat structure to a domain-organized layout without breaking existing behavior. Create a migration plan first, documenting which types and functions move to which package and in what order to avoid circular imports. Execute the migration incrementally: one domain at a time, keeping the project compiling and all tests green after each step. Expected outcome: a structured project under `internal/` with at least three domain packages, a documented migration log showing each step, and a passing test suite throughout the entire migration process.

Start simple and evolve your structure as the project grows. The patterns in this chapter scale from small utilities to large microservices.

### Staff Lens: Package Naming and Documentation Are Product Decisions

Package names are the API surface users see first. A poorly named package (`utils`, `helpers`, `common`) creates confusion for every caller. A well-named package (`tokens`, `pricing`, `delivery`) reads like documentation at the call site.

Similarly, godoc comments are the documentation for every engineer who imports your package. Write them for future readers, not past implementers. Include examples, explain semantics that method signatures cannot, and document error conditions.

These seem like minor concerns. Over a codebase's lifetime they compound into substantial engineering velocity differences. Teams that invest in naming and docs have lower onboarding costs and fewer "how does this work?" Slack messages.

### Principal Lens: Documentation as Infrastructure

Organization-wide, treat documentation as infrastructure: the team writes it, linters check it (`revive`, the maintained successor to the archived `golint`, catches missing doc comments on exported identifiers), reviewers flag omissions. Over years, a codebase with consistent documentation is dramatically easier to maintain than one without. The investment is small per PR. The compound benefit is large.

---
