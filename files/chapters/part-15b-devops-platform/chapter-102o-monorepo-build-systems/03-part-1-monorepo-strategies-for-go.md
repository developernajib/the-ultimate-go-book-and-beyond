## 102O.1 Monorepo Strategies for Go

### Option A: Single Module Monorepo

A single-module monorepo places every service and library under one `go.mod`, giving all packages in the repository a single shared dependency graph. This is the simplest approach: every package imports others using full module paths, the Go toolchain handles transitive dependencies consistently, and there is no version mismatch between internal packages. The downside is that a single large module means every `go build` or `go test ./...` command can trigger work across unrelated packages. This is where affected-change detection (Part 2) and Bazel's incremental build cache (Part 3) become essential.

```
myorg/
├── go.mod              # one go.mod for everything
├── go.sum
├── cmd/
│   ├── api-gateway/
│   ├── user-service/
│   └── order-service/
├── internal/
│   ├── auth/
│   ├── database/
│   └── middleware/
├── pkg/
│   ├── logger/
│   ├── errors/
│   └── config/
└── proto/
    └── *.proto
```

**Pros:** Simple, single `go.mod`, easy imports
**Cons:** All services rebuild together. Single version for all deps

### Option B: Multi-Module with go.work

The multi-module approach places each service or library in its own `go.mod`, giving independent versioning and the ability to release modules separately. The `go.work` file (introduced in Go 1.18) ties these independent modules together for local development, making cross-module imports resolve to local code rather than the published registry version. This avoids the need to `replace` directives in every `go.mod`, which was the painful workaround before workspaces.

```
myorg/
├── go.work             # workspace file
├── go.work.sum
├── services/
│   ├── api-gateway/
│   │   ├── go.mod     # module github.com/myorg/api-gateway
│   │   └── main.go
│   ├── user-service/
│   │   ├── go.mod     # module github.com/myorg/user-service
│   │   └── main.go
│   └── order-service/
│       ├── go.mod     # module github.com/myorg/order-service
│       └── main.go
└── shared/
    ├── auth/
    │   └── go.mod     # module github.com/myorg/shared/auth
    ├── database/
    │   └── go.mod     # module github.com/myorg/shared/database
    └── proto/
        └── go.mod     # module github.com/myorg/shared/proto
```

```go
// go.work
go 1.27

use (
	./services/api-gateway
	./services/user-service
	./services/order-service
	./shared/auth
	./shared/database
	./shared/proto
)
```

```bash
# Initialize workspace
go work init ./services/api-gateway ./services/user-service ./shared/auth

# Add a module to workspace
go work use ./shared/database

# Sync workspace
go work sync

# Build everything in workspace
go build ./...

# Test everything
go test ./...

# Update all modules to latest
go work edit -go=1.22
```

### Workspace Usage Patterns

In day-to-day development, the Go workspace transparently redirects imports to local module directories. When a developer edits a shared library and an API service simultaneously, both changes are visible to the compiler immediately without publishing an intermediate version. In CI, the workspace is typically not used. Each module is built against its pinned dependency versions from `go.sum`, ensuring reproducible builds that are independent of any local checkout.

```go
// In services/api-gateway/main.go
// Import shared modules as if they were published:
import (
	"github.com/myorg/shared/auth"
	"github.com/myorg/shared/database"
)

// The workspace resolves imports from local paths.
// No replace directives needed!

// services/api-gateway/go.mod
module github.com/myorg/api-gateway

go 1.27

require (
	github.com/myorg/shared/auth v0.0.0
	github.com/myorg/shared/database v0.0.0
)
```

### Junior → FAANG: Choosing Between Single-Module and Multi-Module

The single-module layout is correct when all of your services deploy together, share the same external dependency versions, and are owned by one or two teams. The multi-module layout is correct when services have genuinely different release cadences or when different teams need to pin different versions of an external library. The mistake junior engineers make is choosing multi-module because it "feels more modular," then spending weeks fighting `go.work` sync issues and version mismatches that would not have existed in a simpler single-module setup.

A practical heuristic: start with a single module. Add a second `go.mod` only when you have a concrete, documented reason to version that module independently. `go.work` is a development convenience for multi-module repos, not a reason to create multiple modules.

For interview purposes: be able to draw the directory structure for both options on a whiteboard and explain the `go.work use` command. Interviewers testing infrastructure knowledge frequently ask "how do you share code between two Go services in a monorepo without publishing an intermediate version?"

### Senior @ FAANG: Module Boundary Governance at Scale

At FAANG scale, the decision of where to draw module boundaries in a monorepo is not a one-time architectural choice. It is an ongoing governance concern. Module boundaries encode team ownership, release cadence independence, and API stability contracts. When a module boundary is drawn incorrectly (too coarse: unrelated services share a module and must release together, too fine: every package is its own module and the workspace has 300 entries), the cost compounds over years.

The governance mechanism that works at scale is a module ownership registry: a machine-readable file (often a YAML or TOML at the repo root) that maps each module path to an owning team, a stability tier (experimental, stable, deprecated), and a minimum compatibility window. The CI system reads this registry to enforce that changes to a `stable` module path include a backward-compatibility check. The registry also drives Renovate/Dependabot configuration: stable modules get slower update cadences because breaking changes require coordinated consumer updates.

A bar-raiser-level follow-up question in platform interviews: "how do you prevent module boundary sprawl?" The answer involves two controls. First, a PR gate that requires a written justification when adding a new `go.mod` to the repo (checked by a linter that reads the ownership registry). Second, a quarterly audit that identifies modules with a single consumer and proposes collapsing them. Module boundary decisions made under deadline pressure tend to proliferate and are rarely revisited without a formal process.

### Junior → FAANG: Choosing a Layout That Won't Block You Later

The first question when joining or starting a Go monorepo is which layout is in use: single-module or multi-module workspace. That distinction controls everything downstream. In a single-module repo, `go test ./...` runs across the whole codebase by default, and any package is importable by any other without extra configuration. In a multi-module `go.work` workspace, each module has its own dependency graph and you must explicitly list modules in the workspace file.

For a junior engineer, the practical habit is: before modifying a shared package, run `go list -f '{{.ImportPath}} {{.Deps}}' ./...` or whatever graph tool the team provides to see which services depend on it. A change to `internal/auth` that breaks its API will break every service that imports it, and in a CI system without affected-change detection that means every single build fails at once. Understanding the fan-out of a shared package is the entry-level skill that separates thoughtful contributors from those who repeatedly block the main branch.

Interview entry point: when asked about monorepo layouts, describe the tradeoff in terms of dependency isolation versus tooling simplicity. Single-module means simpler tooling but larger blast radius per change. Multi-module workspace means tighter isolation but requires discipline around `go.work` and consistent `go.sum` management.

### Senior @ FAANG: Layout as a Governance Decision with Long-Term Consequences

Layout choice is not primarily a technical decision, it is a governance and team-topology decision. The Conway's Law implication is direct: organizations with tightly coupled teams and shared release cadences tend toward single-module layouts because atomic commits across services are valuable and versioning individual modules adds process overhead with no benefit. Organizations with independently deploying teams, different release cadences, or mixed ownership models tend toward multi-module workspaces because the isolation boundary maps to the team boundary and prevents accidental coupling.

The staff-level concern is layout drift. Monorepos that start single-module often accumulate `go.mod` files over time as teams carve out "independent" modules for compliance reasons, vendor isolation, or deployment separation. Without a formal governance process, this produces a hybrid that has the complexity of both models and the benefits of neither. The ownership registry pattern described above is one solution. Another is a module proliferation lint rule that fails PRs introducing new `go.mod` files without an accompanying ADR approved by the platform team.

At L6/L7 scale, the layout question is also a security question. Multi-module layouts create natural code visibility boundaries: a team managing a payments module can restrict read access at the module level in a VCS system that supports path-based permissions. Single-module layouts require a different access control mechanism (CODEOWNERS with branch protection rules, or tool-level import restriction via `depguard` or `govulncheck` policies). The security architecture of the monorepo must be planned alongside the layout decision, not retrofitted.

Maturity model signal: an organization at monorepo maturity level 1 has chosen a layout. At level 2, it has tooling to enforce the layout's conventions. At level 3, the tooling is self-service: any engineer can query module ownership, request a new module boundary with an automated approval workflow, and see the impact of their changes on the dependency graph before opening a PR.

---
