export default `## 10.7 Package Organization

### Standard Project Layout

The standard Go project layout separates command entrypoints (\`cmd/\`), private implementation (\`internal/\`), and public library code (\`pkg/\`). This structure scales from small services to large monorepos.

\`\`\`
project/
├── cmd/                    # Main applications
│   ├── server/
│   │   └── main.go
│   └── cli/
│       └── main.go
├── internal/               # Private code
│   ├── user/
│   │   ├── user.go
│   │   ├── repository.go
│   │   ├── service.go
│   │   └── handler.go
│   ├── order/
│   │   └── ...
│   └── platform/           # Shared internal utilities
│       ├── database/
│       └── cache/
├── pkg/                    # Public libraries
│   └── validator/
├── api/                    # API definitions
│   ├── openapi.yaml
│   └── proto/
├── web/                    # Web assets
│   ├── static/
│   └── templates/
├── scripts/                # Build/deploy scripts
├── configs/                # Configuration files
├── deployments/            # Deployment configs
│   ├── docker/
│   └── kubernetes/
├── test/                   # Additional test data
│   └── fixtures/
├── go.mod
├── go.sum
├── Makefile
└── README.md
\`\`\`

### Organize by Feature, Not Layer

Organizing packages by business domain rather than technical layer keeps all code for a feature together, reducing the number of packages that change together during a feature update.

\`\`\`go
// Good: organized by feature (domain)
internal/
├── user/
│   ├── user.go           // Domain model
│   ├── handler.go        // HTTP handlers
│   ├── service.go        // Business logic
│   ├── repository.go     // Data access
│   └── user_test.go
├── order/
│   ├── order.go
│   ├── handler.go
│   ├── service.go
│   └── repository.go
└── payment/
    └── ...

// Bad: organized by layer (technical)
internal/
├── handlers/
│   ├── user.go
│   └── order.go
├── services/
│   ├── user.go
│   └── order.go
├── repositories/
│   ├── user.go
│   └── order.go
└── models/
    ├── user.go
    └── order.go
\`\`\`

**Why feature-based?**
- Changes are localized (add feature = add package)
- Clear ownership and boundaries
- Easy to split into microservices later
- Tests are next to code they test

### Avoid Circular Dependencies

Go prohibits circular imports at compile time, if package A imports package B, package B cannot import package A. This constraint forces clean dependency graphs but requires deliberate design when two domains need to reference each other. Three common solutions exist:

\`\`\`go
// Problem: user imports order, order imports user
// user/user.go
import "myapp/internal/order"

// order/order.go
import "myapp/internal/user"  // Circular!

// Solution 1: Shared types package
// types/types.go
type UserInfo struct {
    ID   string
    Name string
}

// user/user.go - imports types, not order
// order/order.go - imports types, not user

// Solution 2: Interfaces
// user/user.go
type OrderGetter interface {
    GetOrdersForUser(userID string) ([]*Order, error)
}

type UserService struct {
    orders OrderGetter  // Interface, not concrete type
}

// order/order.go
type UserGetter interface {
    GetUser(id string) (*User, error)
}

// Solution 3: Dependency inversion
// Move shared logic to a third package
\`\`\`

### Internal Packages

The \`internal\` directory is enforced by the Go toolchain. Any package under \`internal/\` can only be imported by code rooted in the parent of \`internal\`. This gives you a compiler-enforced boundary between public API and private implementation:

\`\`\`go
// project/internal/secret/secret.go can be imported by:
// project/cmd/server/main.go         ✓
// project/internal/other/other.go    ✓
// otherproject/main.go               ✗ Compilation error
\`\`\`

Use \`internal\` for:
- Implementation details you don't want to expose
- Code that might change without notice
- Helper utilities not meant for external use

### Package Documentation

Package documentation begins with a comment immediately before the \`package\` declaration. The first sentence appears as the package summary in generated documentation and should begin with "Package <name>".

\`\`\`go
// Package user provides user management functionality.
//
// It handles user creation, authentication, and profile management.
// All operations are safe for concurrent use.
//
// Example usage:
//
//     service := user.NewService(repo)
//     u, err := service.Create(ctx, user.CreateRequest{
//         Name:  "John",
//         Email: "john@example.com",
//     })
package user
\`\`\`

### Package-Layout Discipline

Team conventions matter more than any specific layout. Agree on \`cmd/\`, \`internal/\`, \`pkg/\` roles. Agree on what goes in \`internal/\` (team-owned private code) vs \`pkg/\` (public API). Document. The consistency is the artifact. The specific choice between two valid layouts matters less than picking one and sticking with it.

### The \`pkg/\` Debate

A real 2026 caveat: the stdlib does not use \`pkg/\`. The Go team has publicly preferred flat module layouts over \`pkg/\`. Many well-regarded Go projects (Kubernetes being the loudest counter-example) use \`pkg/\` for historical reasons, while new projects often skip it and put exported packages at the module root. The rule of thumb: if the module is primarily an application with small exported helpers, skip \`pkg/\`. If it is a library intended to be imported, put the library code at the module root with no \`pkg/\` prefix. \`pkg/\` is neither required nor particularly idiomatic in new Go code. Treat the "standard project layout" as one option among several, not the canonical answer.

### Import Cycle Breaking: A Fourth Solution

The three solutions above are correct. A fourth, often underused: **callback-based dependency injection**. The package that should not import the other passes in the function or interface it needs. This is especially useful when only one or two operations cross the boundary.

\`\`\`go
// user/user.go
type Service struct {
    getOrders func(ctx context.Context, userID string) ([]Order, error)
}

func NewService(getOrders func(ctx context.Context, userID string) ([]Order, error)) *Service {
    return &Service{getOrders: getOrders}
}

// wiring in main.go
userSvc := user.NewService(orderSvc.GetOrdersForUser)
\`\`\`

This avoids defining a one-off interface in each direction. It also makes the dependency visible at construction time rather than hidden inside an import. For simple boundaries with one or two functions crossing, this is often the cleanest fix.

### Staff Lens: Package Splits Are Cheap, Package Merges Are Not

A Go codebase grows. At some point, a package that was logically coherent becomes two concerns bolted together. The staff move is to split early. Adding a new package is a refactor of imports. It is a reviewable PR. The alternative, a 5000-line package with four subsystems mashed together, accumulates cross-dependencies that make the eventual split a multi-sprint coordination exercise. The heuristic: when a package exceeds 2000 lines or handles more than one named subsystem, propose the split. Do it in the review where it would otherwise become a larger problem. Most teams do this too late because nothing forces them to do it on time.

### Principal Lens: The Module Boundary

Splitting the codebase into multiple Go modules is the next level up from splitting packages. Each module has its own version, its own release cadence, its own \`go.mod\`. This is the correct boundary when a piece of the codebase has genuinely independent consumers, operates on a different release cycle, or needs its own stability guarantees (e.g., a client SDK used by external customers). Module splits have real overhead: version management, coordinated releases, toolchain configuration. Do not split prematurely. Do split when the repo contains code with truly different release cycles, when an external-facing library mixes with internal application code, or when a platform component needs to be consumable by other teams with semver guarantees. The principal-level judgment is "when does the overhead of a module split pay for itself". Below a threshold it does not. Above it, the single-module repo becomes the bottleneck.

---
`;
