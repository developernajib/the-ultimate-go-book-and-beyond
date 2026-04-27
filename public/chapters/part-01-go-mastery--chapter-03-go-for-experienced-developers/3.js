export default `## 3.2 Package System Deep Dive

Go's package system is simpler than most languages but enforces conventions that affect your API design. Every Go source file belongs to exactly one package, and the package name becomes the prefix for all its exported identifiers. Getting package boundaries and naming right has a direct impact on code readability across the entire project.

### Package Naming Conventions

Packages should be:
- **Lowercase**: \`http\`, not \`HTTP\` or \`Http\`
- **Short**: \`time\`, not \`timeutils\` or \`timepackage\`
- **Clear**: \`template\`, not \`tmpl\`
- **Singular**: \`user\`, not \`users\`
- **No underscores or hyphens**: \`ratelimiter\`, not \`rate_limiter\`

The package name becomes part of the API:

\`\`\`go
import "encoding/json"

json.Marshal(data)  // "json" is the package name
\`\`\`

### Package Naming Anti-Patterns

New Go developers often carry naming habits from other languages. These examples show common mistakes and their idiomatic alternatives:

\`\`\`go
// BAD: Generic names
import "myproject/util"
util.Process()  // What does this do?

// BAD: Redundant stuttering
import "myproject/user"
user.UserService{}  // Becomes user.UserService - redundant

// BAD: Plural when singular is clearer
import "myproject/users"
users.User{}  // users.User - odd

// GOOD: Specific, meaningful names
import "myproject/cache"
cache.Client{}  // Clear!

// GOOD: No stuttering
import "myproject/user"
user.Service{}  // user.Service - clean
\`\`\`

### How Google Organizes Packages

Google's internal Go style guide recommends this structure:

\`\`\`
company.com/project/
├── cmd/
│   ├── server/
│   │   └── main.go        # Server binary
│   └── client/
│       └── main.go        # Client binary
├── internal/
│   ├── auth/              # Internal auth package
│   │   ├── auth.go
│   │   └── auth_test.go
│   ├── database/          # Internal database package
│   │   ├── postgres.go
│   │   └── migrations/
│   └── service/           # Internal service logic
│       ├── user.go
│       └── user_test.go
├── pkg/
│   └── api/               # Public API (importable by others)
│       ├── v1/
│       │   ├── api.pb.go
│       │   └── service.go
│       └── v2/
│           └── api.pb.go
├── api/                   # API definitions (proto files, OpenAPI)
│   ├── v1/
│   │   └── service.proto
│   └── v2/
│       └── service.proto
├── go.mod
├── go.sum
├── Makefile
└── README.md
\`\`\`

### Import Paths and Aliases

Import paths look like URLs, though the code might not actually be hosted at that exact location. The Go toolchain uses these paths to fetch source code during \`go get\`:

\`\`\`go
import (
    "fmt"                              // Standard library
    "github.com/gin-gonic/gin"         // Third-party
    "mycompany.com/myproject/internal" // Internal
)
\`\`\`

Use aliases when there are conflicts or for clarity:

\`\`\`go
import (
    "crypto/rand"
    mrand "math/rand/v2"  // Alias to avoid conflict
)

import (
    v1 "myproject/api/v1"
    v2 "myproject/api/v2"
)
\`\`\`

### Dot Imports

A dot import brings all of a package's exported names into the current namespace, removing the need for a package qualifier:

\`\`\`go
import . "math"

// Now you can use Sin instead of math.Sin
result := Sin(x)
\`\`\`

**Almost never use this.** It makes code harder to read: where does \`Sin\` come from? The only legitimate use is in test files that heavily use a testing framework:

\`\`\`go
// In _test.go files only
import . "github.com/onsi/gomega"
\`\`\`

### Blank Imports for Side Effects

Some packages register themselves with a parent package during \`init()\`. You import these packages solely for that side effect, not to call any of their exported functions directly:

\`\`\`go
import (
    "database/sql"
    _ "github.com/lib/pq"  // PostgreSQL driver registers itself
)

import (
    "image"
    _ "image/png"  // PNG decoder registers itself
    _ "image/jpeg" // JPEG decoder registers itself
)

import (
    "net/http"
    _ "net/http/pprof"  // Registers pprof handlers at /debug/pprof/
)
\`\`\`

The blank identifier \`_\` imports the package without creating an unused import error.

### Circular Import Prevention

Go forbids circular imports. If package A imports B, B cannot import A. Strategies to resolve:

**1. Move shared types to a third package:**

\`\`\`
// Before: circular import
auth/ imports user/ (for User type)
user/ imports auth/ (for AuthService)

// After: shared types in separate package
types/
    user.go       // User type
    auth.go       // AuthRequest, AuthResponse
auth/
    service.go    // imports types/
user/
    service.go    // imports types/
\`\`\`

**2. Use interfaces:**

\`\`\`go
// Instead of importing user.Service in package notification
// Define an interface for what you need
package notification

type UserFinder interface {
    Find(ctx context.Context, id int) (User, error)
}

type Service struct {
    users UserFinder  // Accept interface, not concrete type
}
\`\`\`

**3. Dependency injection:**

\`\`\`go
// In main.go
userService := user.NewService(db)
notificationService := notification.NewService(userService)
// notificationService uses userService without importing user package
\`\`\`

### Internal Packages

The \`internal\` directory is a Go-enforced access control mechanism. Packages inside \`internal\` can only be imported by code rooted at the parent of the \`internal\` directory:

\`\`\`
myproject/
├── cmd/
│   └── server/
│       └── main.go       # Can import internal/*
├── internal/
│   ├── auth/             # Only myproject/* can import
│   └── database/
└── pkg/
    └── api/              # Anyone can import
\`\`\`

Use \`internal\` for implementation details you do not want to expose.

### Package Initialization Order

Understanding initialization order prevents bugs:

1. Imported packages are initialized first (recursively, depth-first)
2. Package-level variables are initialized in declaration order
3. \`init()\` functions run after variables are initialized
4. \`main()\` runs last

\`\`\`go
package main

import "fmt"

var a = initA()  // Runs second (after fmt is initialized)
var b = 1

func initA() int {
    fmt.Println("initializing a")
    return b + 1  // b must be initialized first
}

func init() {
    fmt.Println("init 1")
}

func init() {
    fmt.Println("init 2")  // Multiple init() allowed, run in order
}

func main() {
    fmt.Println("main")
}
// Output:
// initializing a
// init 1
// init 2
// main
\`\`\`

### The init() Function

\`init()\` has special properties:
- No parameters or return values
- Multiple \`init()\` functions per package allowed
- Called automatically before \`main()\`
- Cannot be called manually

Use \`init()\` sparingly:
- Registering database drivers or codecs
- Initializing global state that cannot be done with a simple expression
- Verifying program state

**Don't use init() for:**
- Complex initialization that can fail (no error handling possible)
- Anything that should be explicit in \`main()\`
- Starting goroutines or network connections

### Package Boundaries Are Org-Design Decisions

For a senior engineer reviewing a Go monorepo, the package layout is not a formatting concern. It is a load-bearing org-design artifact, because Go enforces visibility at the package boundary and not (with the exception of \`internal/\`) at any other granularity. Three patterns that recur in healthy multi-team Go monorepos:

1. **Each team owns one or more top-level directories under \`internal/\`.** The \`internal/\` mechanism makes these directories importable only by code rooted at the parent of \`internal/\`, which means the rest of the org cannot accidentally take a dependency on a team's private implementation. When the team rewrites their internals, the blast radius is bounded by the directory. This is the single biggest lever for making Go monorepos survive multi-year team turnover.
2. **Public APIs live in \`pkg/\` (or in a separately versioned module) and have explicit deprecation policies.** The \`pkg/\` directory is convention, not language-enforced. The work it does is signal the API is stable and can be imported by any code in the repository, with the implicit promise that breaking changes go through a formal deprecation cycle. Without this convention, every package is implicitly public and every breaking change becomes a cross-team coordination problem.
3. **The \`cmd/\` directory holds executables, one per subdirectory.** The convention removes ambiguity about which file is the entry point for which binary, lets the CI system enumerate executables for build, and keeps the top-level repository directory uncluttered. A repository with twenty-seven \`main.go\` files at the top level is a repository where the developer experience has decayed.

The org-design implication is that Go's package and module boundaries can be used to encode team ownership without a separate "ownership" config file. A directory tree that mirrors the org chart is self-documenting and stays current as long as the directory tree does. The opposite (a flat directory tree with ownership encoded in \`OWNERS\` files or CODEOWNERS metadata) is the JVM monorepo pattern that requires constant tooling investment to keep accurate.

### \`internal/\` Is Stronger Than Convention

The Go toolchain enforces \`internal/\` at compile time. A package at \`myproject/internal/auth\` can be imported by \`myproject/cmd/server\`, by \`myproject/api\`, and by any other package whose import path starts with \`myproject/\`, but not by \`othermod/something/that/uses/myproject/internal/auth\`. The enforcement is at the import-path-prefix level. This is the only language-level encapsulation Go provides above the package level, and it is the right tool for "this code is part of the implementation and should not be depended on from outside our team's code".

Two senior-track corollaries:

1. **You can have multiple \`internal/\` directories in a repository.** A package at \`myproject/team-a/internal/foo\` is importable by code rooted at \`myproject/team-a/\`, not by \`myproject/team-b/\`. This lets each team have its own private API surface without bleeding into other teams' namespaces. The mechanism scales to the multi-team monorepo.
2. **\`internal/\` is not a substitute for module boundaries.** When a team's API surface needs a separate version cadence (it is published to other repositories, has a stable contract, or has external consumers), the right move is a separate Go module, not just an exported package. Modules are versioned independently. Packages within a module are not.

### \`init()\` Is a Hot-Button Code-Review Topic

The senior-track default is to use \`init()\` for nothing except registering things with global registries (image decoders, database drivers, encoding handlers). Everything else moves to a \`New...\` constructor called from \`main\` or from a test setup function. The reasons:

1. **\`init()\` cannot return errors.** A failing \`init()\` panics. Anything that can fail at runtime should not be in \`init()\`.
2. **\`init()\` cannot be controlled or sequenced by tests.** A test that wants to reset state cannot un-run \`init()\`. The state has to be reset by another mechanism, which is usually clumsy.
3. **\`init()\` runs at import time, which makes import order load-bearing.** Two packages that both initialise global state in \`init()\` and depend on each other will pick up subtly different behaviour depending on which gets imported first. This is the JVM static-initialiser problem reproduced in Go, and it is the bug that Go's design tried to avoid.

The senior-track lint rule, often enforced by hand because no off-the-shelf linter catches it, is: an \`init()\` function that does anything other than register-and-return is a code-review finding.

### Code-Review Lens

Three patterns a staff reviewer will flag in package-system PRs:

1. **A new package with one type and one method.** Packages have a cost (an import line, a name to remember, a place to look for the code). A package with one type is rarely justified. The fix is to move the type into the package that consumes it, or into a peer package that already exists. The exception is when the type is part of a clear API boundary, in which case the package is justified and should be documented as such.
2. **A \`util\` or \`common\` package.** These names are a smell. They signal "I had types that did not fit anywhere, so I put them here". The fix is to find the right home for each type, even if that means duplication or a new specifically-named package. The Go community-wide convention is that there is no \`util\` package in idiomatic code, and the closest you get to a utility-style package is a domain-specific one like \`strutil\` or \`mathutil\` which is itself usually a smell.
3. **An exported field on an internal type.** If the type is in \`internal/\`, the field's exportedness only matters for code in the same module. The exportation often happens because the author was thinking in Java (where every field is private by default and the getter-setter pattern dominates). The Go fix is usually to leave the field exported (because the boundary is the package, not the type) and to consider whether the field needs validation, in which case hide it.

### Migration Lens

Coming from Java or Maven, the closest analogue to Go modules is Maven coordinates plus the \`module-info.java\` system, but Go's is simpler and stricter. Coming from Python, the closest analogue to Go's \`internal/\` is the \`_underscore\` convention, but Go's is enforced by the compiler instead of by social pressure. Coming from Node, the closest analogue is the \`package.json\` \`private\` field plus the \`files\` whitelist, but Go's \`internal/\` is more granular and applies at the directory level rather than at the publish level. The senior-track upshot is that Go gives you fewer mechanisms for code organisation than the JVM or Node ecosystem, and the mechanisms it gives you are stricter. The trade is less flexibility for more enforcement, and at the multi-team monorepo scale the enforcement is the more valuable side of the trade.

---
`;
