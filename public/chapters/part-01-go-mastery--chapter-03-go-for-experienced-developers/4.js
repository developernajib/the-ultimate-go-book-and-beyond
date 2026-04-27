export default `## 3.3 Modules Mastery

Go modules are the standard dependency management system, required since Go 1.16. A module is a collection of packages versioned together, defined by a \`go.mod\` file at the repository root. If you have worked with npm's \`package.json\` or Java's Maven POM, \`go.mod\` serves a similar role but with a simpler resolution algorithm.

### The go.mod File

Every Go project has a \`go.mod\` file at its root:

\`\`\`go
module github.com/yourname/project

go 1.26

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/stretchr/testify v1.8.4
)

require (
    // Indirect dependencies (required by your dependencies)
    github.com/bytedance/sonic v1.9.1 // indirect
    github.com/go-playground/validator/v10 v10.14.0 // indirect
)
\`\`\`

Key directives:

- **module**: Your module's path (usually matches repository URL)
- **go**: Minimum Go version required
- **require**: Direct and indirect dependencies
- **replace**: Override dependency locations (useful for local development)
- **exclude**: Prevent specific versions from being used
- **retract**: Mark versions of your module as broken

### The go.sum File

\`go.sum\` contains cryptographic checksums of dependencies:

\`\`\`
github.com/gin-gonic/gin v1.9.1 h1:4idEAncQnU5...
github.com/gin-gonic/gin v1.9.1/go.mod h1:RdK...
\`\`\`

This ensures reproducible builds. If a dependency changes, the checksum will not match. Never edit this file manually.

### Semantic Versioning in Go

Go enforces semantic versioning:

- **v0.x.x**: Development versions, no compatibility promises
- **v1.x.x**: Stable, backward-compatible within major version
- **v2.0.0+**: Breaking changes require different import path

For v2+, the import path must include the major version:

\`\`\`go
import (
    "github.com/yourmodule/api"     // v0.x or v1.x
    "github.com/yourmodule/api/v2"  // v2.x
)
\`\`\`

### Module Proxies

Go fetches dependencies through a module proxy rather than directly from source repositories. The default proxy, \`proxy.golang.org\`, caches module source code, maintains availability when the original repository is down, and serves checksums for verification. You can configure proxy behavior through environment variables:

\`\`\`bash
# Use the default proxy
export GOPROXY=https://proxy.golang.org,direct

# Add a private proxy (common at large companies)
export GOPROXY=https://goproxy.company.com,https://proxy.golang.org,direct

# Bypass proxy entirely (not recommended for public modules)
export GOPROXY=direct
\`\`\`

### Private Modules

Private repositories need special configuration because the default proxy and checksum database cannot access them. Set \`GOPRIVATE\` to tell the Go toolchain which module paths should bypass the proxy entirely:

\`\`\`bash
# Tell Go which modules are private (skip proxy and checksum DB)
export GOPRIVATE=github.com/mycompany/*,git.internal.company.com/*

# Alternative: set both GONOPROXY and GONOSUMDB
export GONOPROXY=github.com/mycompany/*
export GONOSUMDB=github.com/mycompany/*
\`\`\`

Also configure Git to use SSH:

\`\`\`bash
git config --global url."git@github.com:mycompany/".insteadOf "https://github.com/mycompany/"
\`\`\`

### How Uber Manages Go Modules

Uber has thousands of Go repositories and runs a private module proxy alongside the public one. Their developer environment configures both proxy and privacy settings so internal modules resolve through internal infrastructure while open-source dependencies still use the public proxy:

\`\`\`bash
# .bashrc or .zshrc at Uber
export GOPROXY=https://goproxy.uberinternal.com,https://proxy.golang.org,direct
export GOPRIVATE=github.com/uber/*,github.com/uber-go/*,go.uber.org/*
export GONOSUMDB=github.com/uber/*,github.com/uber-go/*,go.uber.org/*

# Git configuration for SSH
git config --global url."git@github.com:uber/".insteadOf "https://github.com/uber/"
git config --global url."git@github.com:uber-go/".insteadOf "https://github.com/uber-go/"
\`\`\`

### Replace Directives

The \`replace\` directive overrides where Go resolves a dependency, which is useful during local development or when you need to pin a forked version:

\`\`\`go
// In go.mod
// Local development
replace github.com/original/repo => ../local/repo

// Forked dependency
replace github.com/original/repo => github.com/yourfork/repo v1.0.0

// Pin to specific commit
replace github.com/flaky/lib => github.com/flaky/lib v0.0.0-20230615120000-abc123def456
\`\`\`

Remember to remove \`replace\` directives before publishing. They only affect the main module.

### Multi-Module Workspaces (Go 1.18+)

When working on multiple related modules simultaneously (common in monorepos), workspaces let you edit across module boundaries without publishing intermediate versions:

\`\`\`bash
# Create a workspace
go work init ./api ./service ./common

# go.work file is created:
# go 1.26
# use (
#     ./api
#     ./service
#     ./common
# )

# Add another module
go work use ./newmodule
\`\`\`

Changes in any module are immediately visible to others without publishing.

### How Google Uses Workspaces in Kubernetes

The Kubernetes project uses Go workspaces to manage its large multi-module structure. Each staging component is a separate module that can be published independently, but developers work on them together through a single workspace:

\`\`\`
kubernetes/
├── go.work
├── staging/
│   └── src/
│       └── k8s.io/
│           ├── api/
│           │   └── go.mod
│           ├── apimachinery/
│           │   └── go.mod
│           ├── client-go/
│           │   └── go.mod
│           └── ...
└── pkg/
    └── ...
\`\`\`

### The \`tool\` Directive (Go 1.24+)

Before Go 1.24, the standard workaround for tracking build-time tools (mock generators, protobuf compilers, migration tools) was a \`tools.go\` file with a build tag and blank imports, plus manual \`go install\` commands in CI. Go 1.24 made this a first-class module concept with the \`tool\` directive in \`go.mod\`:

\`\`\`go
module github.com/yourname/project

go 1.26

tool (
    go.uber.org/mock/mockgen
    github.com/golang/protobuf/protoc-gen-go
    github.com/sqlc-dev/sqlc/cmd/sqlc
)

require (
    go.uber.org/mock v0.4.0
    github.com/golang/protobuf v1.5.4
    github.com/sqlc-dev/sqlc v1.27.0
)
\`\`\`

Install and invoke tools pinned to the module's versions:

\`\`\`bash
# Install every tool declared in the module
go install tool

# Run a tool directly without separate install
go tool mockgen -source=service.go -destination=mocks/service.go
\`\`\`

The advantage over the old \`tools.go\` hack is that tool versions are first-class in \`go.mod\` and \`go.sum\`, so \`go mod tidy\` maintains them, reproducible CI builds pick them up automatically, and there is no separate "install the tooling" step that drifts over time. Teams maintaining large Go monorepos should migrate any remaining \`tools.go\` files.

### Authenticated Proxies (\`GOAUTH\`, Go 1.24+)

Private module proxies (Artifactory, Cloudsmith, self-hosted Athens) typically require authentication. Pre-1.24, the accepted workaround was a \`.netrc\` file or a custom git credential helper. Go 1.24 introduced \`GOAUTH\` for declarative per-host authentication:

\`\`\`bash
# Netrc-style bearer tokens
export GOAUTH="netrc"

# A custom command that returns credentials to Go
export GOAUTH="myauth-helper fetch"

# Multiple sources, tried in order
export GOAUTH="netrc; git; myauth-helper fetch"
\`\`\`

\`GOAUTH\` replaces ad-hoc token juggling across CI systems and local dev machines and works across the full Go toolchain (\`go get\`, \`go mod download\`, \`go install\`, \`go tool\`).

### Minimum Version Selection (MVS)

Go's dependency resolution is simpler than most:

If module A requires pkg@v1.2 and module B requires pkg@v1.5, Go uses v1.5 (the minimum version that satisfies all requirements).

This is deterministic: the same go.mod always produces the same build. No SAT solver, no version lock files beyond go.mod and go.sum.

### Why MVS Matters at Scale

For a senior engineer evaluating dependency-management strategies across an org, MVS is the single most under-appreciated feature of Go modules. Three concrete payoffs:

1. **Determinism without a lockfile.** \`go.mod\` and \`go.sum\` together specify the build exactly. There is no separate \`package-lock.json\`, \`Cargo.lock\`, or \`Gemfile.lock\` to keep in sync. The reasons MVS can do this where SAT-solver-based managers cannot is that MVS picks the minimum version satisfying all constraints, which is unique. SAT-based resolution can have multiple valid solutions and needs a lockfile to pick one.
2. **Upgrade paths are explicit and auditable.** A dependency upgrade is a \`go.mod\` diff. The diff says exactly which version moved, and the corresponding \`go.sum\` diff says which hashes changed. There is no "transitive dependency drifted because some other dependency loosened its constraint" mystery. The upgrade discipline is therefore predictable, and the tooling (\`go list -u -m all\`, \`go mod tidy\`, \`govulncheck\`) is calibrated for the deterministic case.
3. **Diamond dependencies resolve trivially.** When two of your dependencies require different versions of a third, MVS picks the higher of the two minimums. There is no algorithm to debate. The cost is that occasionally a transitive dependency forces an unwanted upgrade in your tree, in which case \`replace\` lets you pin the problem out, and the long-term fix is to bump the immediate dependency.

The org-design corollary is that Go's dependency story is calibrated for the multi-team monorepo with many internal modules and external dependencies. SAT-based resolution scales worse with both number of dependencies and depth of dependency tree, and the JVM and Node ecosystems both spend disproportionate engineering effort fighting their resolvers. Go does not, because the resolver problem is bounded by design.

### Vendor Mode

Go supports \`go mod vendor\`, which copies every dependency into a \`vendor/\` directory at the module root. With \`vendor/\` present and \`GOFLAGS=-mod=vendor\` (or the older default behaviour), the build uses only the vendored copies and never touches the network or the module cache. Two situations where vendoring still earns its keep in 2026:

1. **Air-gapped or compliance-restricted build environments.** If the CI machine cannot reach the public proxy, vendoring is the supported way to make the module content available without rolling your own proxy.
2. **Audit-driven workflows.** When the team's compliance posture requires that every line of third-party code be reviewed and committed, \`vendor/\` is the artifact reviewers look at. The PR diff includes the vendor changes, so a dependency upgrade is reviewable line-by-line.

For most teams in 2026 the default is no \`vendor/\` directory, plus a private module proxy if the org needs it. The \`vendor/\` workflow is a deliberate choice for specific compliance needs, not the default.

### Module-Graph Pruning (Go 1.17+)

Go 1.17 introduced module-graph pruning. The \`go.mod\` of any module compiled with \`go 1.17\` or higher lists every direct and indirect dependency at the version actually selected, which lets the toolchain build the module-graph without recursively reading every dependency's \`go.mod\`. The visible payoff is faster \`go mod\` operations and more predictable behaviour. The hidden payoff is that the \`go.mod\` becomes the canonical source of truth for the build, with no need to "trust" transitive \`go.mod\` files that may have been written under older toolchains.

For a senior engineer auditing a Go monorepo, the rule is that every module should have its \`go\` directive at 1.17 or higher (and 1.21 or higher to get the standardised \`slog\` and \`slices\`/\`maps\` packages without polyfills, and 1.22 or higher to get the loop-variable fix and integer-range loops). Any module still at \`go 1.16\` or earlier is a candidate for an upgrade audit.

### Code-Review Lens (Senior Track)

Three things a staff reviewer scans for in any module-related PR:

1. **A new direct dependency without a justification.** Every dependency is a supply-chain risk, a license concern, a transitive-dependency multiplier, and a maintenance commitment. The senior-track default is "do you really need this?". The standard library plus a small number of well-known external packages (\`gorilla/mux\` or \`chi\` for routing, \`pgx\` for Postgres, \`redis/go-redis/v9\` for Redis, \`prometheus/client_golang\` for metrics) cover the majority of services.
2. **A \`replace\` directive in a published module.** \`replace\` only affects the main module, so a \`replace\` in a library's \`go.mod\` is silently ignored when other modules depend on the library. If you see \`replace\` in a library, it is either a leftover from local development that should be removed or a misunderstanding that needs to be corrected. The exception is a \`replace\` in a \`tools.go\`-style or an \`examples/\` module, where the replace is intentional and bounded.
3. **An indirect dependency promoted to direct without being used.** When \`go mod tidy\` decides an indirect dependency should be direct, it usually means the code now imports it. If the code does not import it but \`go.mod\` says direct, the module file is out of sync and the next \`go mod tidy\` will revert. Run \`go mod tidy\` before opening the PR.

### Migration Lens

Coming from Maven or Gradle, the biggest shift is that there is no central declaration of the entire dependency tree. \`go.mod\` lists what you require, \`go.sum\` lists the hashes, and \`go list -m all\` shows the resolved tree. There is no \`pom.xml\` with profiles, no \`build.gradle\` with custom resolution rules, no plugin ecosystem to learn. Coming from npm, the biggest shift is the absence of \`node_modules\` and the consolidation of "lockfile" and "manifest" into \`go.mod\` plus \`go.sum\`. Coming from pip plus \`requirements.txt\`, the biggest shift is that Go has version selection at the language level rather than as a separate tool, so the toolchain itself enforces reproducible builds. Coming from Cargo, Go's MVS is the closest analogue, but Go has no equivalent of Cargo's feature flags or workspaces-with-shared-target-directory. Workspaces in Go (1.18+) cover the multi-module-development case, with a different feel.

---
`;
