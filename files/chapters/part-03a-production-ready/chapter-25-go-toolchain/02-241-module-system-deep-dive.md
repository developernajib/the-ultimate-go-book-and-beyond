## 25.1 Module System Deep Dive

### Module Basics

Go modules provide reproducible builds by recording exact dependency versions in `go.mod` and cryptographic checksums in `go.sum`. The `go mod tidy` command reconciles the recorded dependencies with what the source code actually imports, adding missing requirements and removing unused ones, making it the essential cleanup step before any commit.

```bash
# Initialize a new module
go mod init github.com/username/project

# Add dependencies
go get github.com/lib/pq@v1.10.9

# Update dependencies
go get -u ./...

# Tidy up dependencies
go mod tidy

# Verify dependencies
go mod verify

# Download dependencies
go mod download
```

### go.mod File Anatomy

The `go.mod` file is the authoritative manifest for a module's identity and dependencies. The `replace` directive redirects an import path to a local directory, invaluable when simultaneously developing a library and a consumer, while `retract` lets module authors formally mark previously published versions as broken, causing `go get` to warn users who depend on them.

```go
module github.com/username/project

go 1.25.0
toolchain go1.27.1

require (
    github.com/lib/pq v1.10.9
    golang.org/x/sync v0.10.0
)

require (
    // Indirect dependencies
    golang.org/x/text v0.21.0 // indirect
)

// Tool dependencies (Go 1.24+): pins dev tools without polluting imports.
// Note the mock path: github.com/golang/mock was archived by Google and its
// last release was v1.6.0 in 2021. go.uber.org/mock is the maintained fork
// and the one to use in new code.
tool (
    golang.org/x/tools/cmd/stringer
    go.uber.org/mock/mockgen
)

// Replace directive for local development
replace github.com/original/pkg => ../local-pkg

// Exclude specific versions
exclude github.com/broken/pkg v1.0.0

// Retract broken versions of your own module
retract (
    v1.0.0 // Critical bug
    [v1.1.0, v1.2.0] // Range of broken versions
)
```

The `go` directive states the minimum language version required to build the module. Since Go 1.21 a separate `toolchain` directive pins the exact toolchain used to build it. If a developer runs an older toolchain than the `go` line demands, the `go` command transparently downloads and invokes a newer one, which eliminates a whole category of "works on my machine" drift across a team. That download behaviour is itself governed by `GOTOOLCHAIN`, which defaults to `auto`. Setting `GOTOOLCHAIN=local` disables it and makes a too-old toolchain an error instead of a silent upgrade, which is what you usually want on a hermetic build machine.

`go mod init` writes a `go` line matching the toolchain that ran it, down to the patch version: run it under Go 1.26.5 and you get `go 1.26.5`. That is worth knowing before you commit, because the `go` line is a *minimum requirement*, so a patch-precise line generated on a developer laptop quietly obliges everyone else, and CI, to have at least that release. Teams that care about a compatibility floor set the line deliberately (`go mod edit -go=1.25.0`) rather than accepting whatever the laptop wrote.

> **Senior track**: The `tool` directive (Go 1.24+) replaces the older `tools.go` blank-import pattern. Add tools with `go get -tool <pkg>`, then invoke them with `go tool <name>`. Each module pins its own tool versions in `go.mod`, which makes CI and local runs bit-for-bit identical without a separate install step.

### Minimum Version Selection (MVS)

MVS is Go's dependency resolution algorithm: when multiple modules in the dependency graph require different versions of the same package, Go selects the minimum version that satisfies all constraints. This makes builds deterministic and reproducible, the selected version never changes unless a module explicitly updates its `require` directive, unlike npm's floating ranges that can resolve differently on each install.

```
Module A requires:
  - B v1.2.0
  - C v1.0.0

Module B v1.2.0 requires:
  - C v1.1.0

Result: C v1.1.0 (minimum version satisfying all)
```

```bash
# View dependency graph
go mod graph

# Explain why a dependency exists
go mod why github.com/some/package

# View all available versions
go list -m -versions github.com/lib/pq
```

### Private Modules

The Go module proxy (`GOPROXY`) caches public modules but cannot reach private repositories. Setting `GOPRIVATE` to a comma-separated list of module path prefixes tells the toolchain to bypass the proxy and fetch those modules directly from version control, using the configured git credentials for authentication. Go 1.24 introduced `GOAUTH`, a declarative authentication mechanism that replaces ad-hoc `.netrc` hacks.

```bash
# Set GOPRIVATE for private repos
export GOPRIVATE=github.com/mycompany/*,gitlab.internal.com/*

# Configure git for private repos
git config --global url."git@github.com:".insteadOf "https://github.com/"

# GOAUTH (Go 1.24+): a semicolon-separated list of auth commands, tried in order.
# Note `git` is not a bare keyword: it takes the absolute path of a git working
# directory whose credential helper should be used. Writing plain `git` fails with
# "GOAUTH=git dir method requires an absolute path to the git working directory".
export GOAUTH='netrc;git /home/dev/src/mycompany;/usr/local/bin/go-auth-helper'

# Or use .netrc for HTTPS
# ~/.netrc
machine github.com
login username
password token
```

> **Senior track**: Prefer a private proxy (Athens, JFrog Artifactory, Google Artifact Registry) over direct VCS fetches. It gives you a cacheable layer, deletion-resistant dependency storage, audit logs, and one choke point for CVE scanning. Point `GOSUMDB` at a private checksum database rather than disabling verification, so integrity checks still apply to internal modules.

### Workspaces for Multi-Module Development

Go workspaces, introduced in Go 1.18 and matured through Go 1.25, allow multiple local modules to be developed together without the overhead of `replace` directives in every `go.mod` file. A single `go.work` file at the repository root declares which modules are in scope, and the toolchain automatically uses local versions for cross-module imports within the workspace. As of Go 1.24, `go.work` files support the `tool` directive, so tool dependencies can be defined once at the workspace level.

```bash
# Create workspace
go work init ./module1 ./module2

# Add module to workspace
go work use ./module3

# Sync workspace
go work sync
```

```go
// go.work file
go 1.25.0
toolchain go1.27.1

use (
    ./api
    ./shared
    ./worker
)

tool (
    golang.org/x/tools/cmd/stringer
)

replace github.com/external/pkg => ../local-fork
```

### Staff Lens: Module Hygiene

`go mod tidy` regularly. Pin versions. Audit `go.sum` changes in review. Set `GOFLAGS=-trimpath` for reproducibility. These disciplines prevent supply chain surprises.

---
