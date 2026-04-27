export default `## 2.1b Packages and Imports

A Go program is a collection of **packages**. A package is a directory of \`.go\` files that share the same \`package <name>\` declaration on their first non-comment line. The \`main\` package is special, it produces an executable. Every other package produces a library that other packages can import.

### The One-Directory-One-Package Rule

Every \`.go\` file inside the same directory must declare the same package name. Mixing two package names in one directory is a compile error. The exception is test files ending in \`_test.go\`, which may declare \`<name>_test\` for black-box tests.

\`\`\`text
myapp/
  main.go            package main
  config/
    config.go        package config
    config_test.go   package config        (white-box test)
    bench_test.go    package config_test   (black-box test, allowed)
\`\`\`

The directory name and the package name do not have to match, but by convention they do. The exception is when a directory holds a versioned package like \`v2/\`, where the package name is the previous name (e.g., \`mux\`) and the import path carries the version.

### Import Forms

Go has four import forms. You will see all of them in real codebases.

\`\`\`go
import "fmt"                           // 1. standard
import f "fmt"                         // 2. aliased
import . "fmt"                         // 3. dot (avoid)
import _ "github.com/lib/pq"           // 4. blank (side effect only)
\`\`\`

**Standard import.** The package is referenced by its declared name, which is usually the last path segment. \`import "net/http"\` is used as \`http.Get(...)\`.

**Aliased import.** Renames the package locally. Use it to resolve a name collision (two packages both named \`log\`) or to shorten a long name. Do not use aliases to "make code cleaner" if there is no collision, the standard name is what readers expect.

\`\`\`go
import (
    stdlog "log"
    applog "github.com/rs/zerolog/log"
)
\`\`\`

**Dot import.** Brings every exported name into the current file's namespace, so you write \`Println(...)\` instead of \`fmt.Println(...)\`. This breaks readability and is forbidden in most style guides. The only legitimate use is inside test files for DSLs like \`gomega\`. Do not use it in production code.

**Blank import.** Imports the package only for its \`init()\` side effects. The classic case is database drivers, where \`import _ "github.com/lib/pq"\` registers the driver with \`database/sql\` without exposing any symbols. If you ever wonder why a \`database/sql.Open("postgres", ...)\` call fails with "unknown driver", it is because nobody imported the driver with \`_\`.

### Grouped Imports and Ordering

The community convention, enforced by \`goimports\`, is three groups separated by blank lines: standard library, third party, then local. \`gofmt\` does not enforce the grouping, but \`goimports\` does, and most teams run \`goimports\` on save.

\`\`\`go
import (
    "context"
    "fmt"
    "net/http"

    "github.com/google/uuid"
    "go.uber.org/zap"

    "github.com/yourorg/yourapp/internal/auth"
    "github.com/yourorg/yourapp/internal/store"
)
\`\`\`

### Internal Packages

A directory named \`internal\` is a Go-enforced visibility boundary. Code under \`myrepo/internal/foo\` can only be imported by code rooted under \`myrepo/\`. Anyone else trying to import it gets a compile error.

\`\`\`text
github.com/yourorg/yourapp/
  cmd/server/main.go        ✓ can import internal/...
  internal/
    auth/
    store/
  pkg/
    publicclient/           ← public API surface
github.com/someone/else/    ✗ cannot import yourapp/internal/...
\`\`\`

Use \`internal/\` aggressively. It is the simplest way to keep your public API small and your refactoring options open. Anything not under \`internal/\` is a public API contract that semantic versioning forces you to maintain.

### Import Cycles

Go forbids cyclic imports at compile time. If package \`a\` imports \`b\` and \`b\` imports \`a\`, the build fails with "import cycle not allowed". This is a deliberate language design choice that forces you to think about dependency direction.

\`\`\`text
package a            package b
  import "b"           import "a"   // ✗ cycle
\`\`\`

Common ways to break a cycle:

1. **Move the shared type to a third package.** If \`a\` and \`b\` both need a \`User\` type, put it in \`package model\` that both import.
2. **Use an interface in the consumer.** If \`a\` calls a function in \`b\`, but \`b\` needs a callback into \`a\`, define an interface in \`b\` and have \`a\` pass an implementation. This is the dependency inversion principle in action.
3. **Move one direction of the dependency to a sub-package.** If \`a/handlers\` imports \`a/store\`, the cycle is impossible because \`store\` does not import \`handlers\`.

In practice, an import cycle is almost always a design smell. The cycle is the language telling you two packages are not really separate.

### Package Names: Idiomatic Style

- Lowercase, single word, no underscores. \`httputil\`, not \`http_util\` or \`httpUtil\`.
- No stutter. A function in package \`user\` should be \`user.New\`, not \`user.NewUser\`. The package name already supplies the prefix.
- No generic names like \`util\`, \`common\`, \`helpers\`. They become dumping grounds. Pick a name that says what the package does.
- Avoid leaking the implementation. If your package wraps Redis, name it \`cache\`, not \`redis\`, so you can swap implementations later.

### Code-Review Lens (Senior Track)

In review, packages and imports are an architectural signal, not a formatting concern.

- A new top-level package is a public API decision. Should it be \`internal/\` instead?
- A blank import in a non-\`main\` file is suspicious. Side-effecting \`init()\` deep in a library makes the program harder to reason about.
- A dot import in non-test code is a hard reject.
- An import cycle that someone "fixed" by exposing private types in a new shared package usually means the original boundary was wrong.
- Watch for \`import "github.com/yourorg/yourapp/pkg/..."\` when \`internal/\` would have been correct. Once it is in \`pkg/\`, you cannot move it back without a breaking change.

### Migration Lens

- **From Java/Kotlin:** Go has no class-level access modifiers. Visibility is per-identifier (capitalized = exported) and per-directory (\`internal/\`). There is no \`package private\` between sibling directories the way Java has between classes in the same package.
- **From Python:** There is no \`from x import *\` equivalent, except the dot import, which is discouraged. There is no relative import. Every import path is absolute, rooted at the module path declared in \`go.mod\`.
- **From Node.js:** No \`node_modules\`. Modules are version-pinned in \`go.mod\` and cached in \`\$GOPATH/pkg/mod\`. There is no per-project dependency directory by default.
- **From Rust:** No \`mod\` declarations. The directory layout *is* the module structure. No \`use\` re-exports, if you want to re-expose a name, you wrap it.
`;
