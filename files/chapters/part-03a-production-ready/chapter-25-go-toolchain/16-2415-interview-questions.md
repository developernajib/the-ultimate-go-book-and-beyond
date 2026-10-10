## 25.15 Interview Questions

### Question 1: Explain Go's Minimum Version Selection (MVS)

**What FAANG expects:** You understand that MVS is a design decision about reproducibility and supply-chain risk, not just an algorithm. You can contrast it with SAT-based resolvers (npm, Maven, Cargo) and explain operational consequences: deterministic builds, predictable upgrade blast radius, and the explicit-upgrade model that forces security patches to be a conscious act.

**Answer:**
Go's MVS algorithm selects the minimum version of each dependency that satisfies all requirements. Unlike other package managers that may select the "latest" version, MVS provides reproducible builds.

**Key Points:**
1. **Deterministic**: Given the same go.mod files, MVS always produces the same dependency versions
2. **Minimal upgrades**: Only upgrades when required by a dependency chain
3. **No SAT solver**: Simpler than npm/Maven - no NP-complete dependency resolution

**Example:**
```
Module A requires B@v1.2 and C@v1.0
Module B@v1.2 requires C@v1.1
Module C has versions v1.0, v1.1, v1.2, v1.3

MVS selects: C@v1.1 (minimum satisfying all constraints)
npm might select: C@v1.3 (latest compatible)
```

**Follow-ups:**
1. *What are the security implications of MVS?* You must explicitly upgrade to get patches. `go get -u` or `go get package@latest` is required, and `govulncheck` highlights which call paths are actually affected so you do not upgrade blindly.
2. *How does MVS interact with the `toolchain` directive?* The selected Go version in `go.mod` is itself subject to MVS, the build uses the maximum `go` directive across the graph, and if that exceeds the local toolchain, Go auto-downloads the pinned toolchain (Go 1.21+).
3. *What happens when two modules require incompatible major versions (v1 vs v2)?* They are treated as separate modules because the major version is part of the import path (`example.com/pkg` vs `example.com/pkg/v2`), so both can coexist, which is Go's "import compatibility rule."

### Question 2: How Would You Optimize a 10-Minute CI Build?

**What FAANG expects:** Numbers first, then levers. You should name the three dominant costs (module download, compile, test) and match each to a remedy (warm caches, affected-package detection, test sharding). Bonus points for a p50 vs p95 framing and for knowing that `-race` roughly 10x-es wall time.

**Answer:**
A 10-minute CI build usually suffers from serial execution, cold caches, and full-codebase analysis on every run. The fix is a combination of parallelization, aggressive caching, and incremental analysis that only examines changed code on pull requests. The following pipeline demonstrates each technique.

```yaml
# Optimized CI pipeline
jobs:
  # 1. Parallelize independent tasks
  lint-and-test:
    strategy:
      matrix:
        task: [lint, test-unit, test-integration]
    steps:
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/go-build
            ~/go/pkg/mod
          key: go-${{ hashFiles('**/go.sum') }}

      # Run specific task
      - run: make ${{ matrix.task }}

  # 2. Incremental analysis on PRs
  incremental-lint:
    if: github.event_name == 'pull_request'
    steps:
      - run: golangci-lint run --new-from-rev=origin/main

  # 3. Build only affected packages
  smart-build:
    steps:
      - name: Find affected packages
        run: |
          AFFECTED=$(go list -deps ./... | grep "myorg")
          echo "affected=$AFFECTED" >> $GITHUB_OUTPUT

  # 4. Use build cache aggressively
  build:
    steps:
      - name: Build with cache
        env:
          GOCACHE: /tmp/go-build-cache
        run: go build ./...
```

**Key Optimization Techniques:**
1. **Parallelization**: Run lint, tests, and builds in parallel
2. **Caching**: Cache go modules and build artifacts
3. **Incremental analysis**: Only analyze changed code on PRs
4. **Affected package detection**: Only test what changed
5. **Test splitting**: Distribute tests across multiple runners

**Follow-ups:**
1. *Cache hit rate is 100% but builds are still slow, where do you look next?* Compile time inside the cached scope, large generated code, excessive `//go:generate` invocations, or linker time on big binaries (use `-ldflags=-w -s` and consider splitting internal packages).
2. *Tests sometimes pass locally and fail in CI. What cache setting could cause this?* `go test` caches by input hash, if tests depend on env vars not declared or on the system clock, cache keys differ. Use `-count=1` to force re-run or make the dependency explicit.
3. *Would you run `-race` on every PR?* No, it is 5x-10x slower and can double memory. Run race on a nightly matrix job and on merge-queue builds, not on every push.

### Question 3: Design a Custom Static Analyzer

**What FAANG expects:** Familiarity with `golang.org/x/tools/go/analysis`, the `inspect` pass, and reporting diagnostics with positions. You should reason about false-positive rates (any analyzer with >5% FP is ignored) and integration paths (vet, golangci-lint custom linters plugin, CI).

**Answer:**
The `golang.org/x/tools/go/analysis` framework lets you write analyzers that plug into `go vet`, `golangci-lint`, and CI pipelines. Each analyzer declares its dependencies (typically the `inspect` pass for AST traversal), receives a `*analysis.Pass` with type information, and reports diagnostics at specific source positions. The following analyzer detects `context.Background()` calls inside HTTP handlers, where the request's context should be used instead.

```go
package analyzer

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
)

// NoContextBackground detects context.Background() in HTTP handlers.
var NoContextBackground = &analysis.Analyzer{
	Name:     "nocontextbackground",
	Doc:      "checks for context.Background() usage in HTTP handlers",
	Requires: []*analysis.Analyzer{inspect.Analyzer},
	Run:      run,
}

func run(pass *analysis.Pass) (any, error) {
	inspect := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

	// Track if we're in an HTTP handler
	nodeFilter := []ast.Node{
		(*ast.FuncDecl)(nil),
		(*ast.CallExpr)(nil),
	}

	var inHTTPHandler bool

	inspect.Preorder(nodeFilter, func(n ast.Node) {
		switch node := n.(type) {
		case *ast.FuncDecl:
			// Check if this is an HTTP handler
			inHTTPHandler = isHTTPHandler(pass.TypesInfo, node)

		case *ast.CallExpr:
			if !inHTTPHandler {
				return
			}

			// Check for context.Background() call
			if isContextBackground(pass.TypesInfo, node) {
				pass.Reportf(node.Pos(),
					"use request context instead of context.Background() in HTTP handlers")
			}
		}
	})

	return nil, nil
}

func isHTTPHandler(info *types.Info, fn *ast.FuncDecl) bool {
	if fn.Type.Params == nil || len(fn.Type.Params.List) < 2 {
		return false
	}

	params := fn.Type.Params.List
	// Check for (http.ResponseWriter, *http.Request) signature
	// ... implementation details
	return true
}

func isContextBackground(info *types.Info, call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}

	ident, ok := sel.X.(*ast.Ident)
	if !ok || ident.Name != "context" {
		return false
	}

	return sel.Sel.Name == "Background"
}
```

**Follow-ups:**
1. *How do you ship an analyzer to a team?* Publish as a module, consumers add it via `tool` directive in `go.mod` (Go 1.24+) and invoke it with `go tool`, or wrap with `singlechecker.Main()` to distribute as a standalone binary.
2. *Why is type information (`pass.TypesInfo`) essential here?* AST alone cannot distinguish `context.Background` from any other `context.Background` symbol (package aliases, shadowing), type info disambiguates safely.
3. *How do you test an analyzer?* Use `analysistest.Run` with `// want` comments in testdata files. It compiles fixture packages and asserts diagnostics match exactly.

### Question 4: Explain Build Tag Best Practices

**What FAANG expects:** You know the difference between `//go:build` (Go 1.17+) and the legacy `// +build`, you understand tag boolean logic, and you can explain the file-suffix convention (`_linux.go`, `_amd64.go`) that implicitly adds tags without any directive.

**Answer:**
Build tags (constraints) control file inclusion at compile time using boolean expressions over OS, architecture, and custom tag names. Since Go 1.17, the `//go:build` syntax replaced the ambiguous `// +build` syntax with explicit `&&`, `||`, and `!` operators.

```go
// Modern syntax (Go 1.17+)
//go:build linux && amd64

// Legacy syntax (for compatibility)
// +build linux,amd64

// Multiple constraints
//go:build (linux || darwin) && !cgo

// Custom build tags for feature flags
//go:build enterprise
```

**Best Practices:**
1. Use `//go:build` syntax (not `// +build`)
2. Place build constraints at file top, before package
3. Use `_os.go` and `_arch.go` suffixes when appropriate
4. Document custom build tags in README
5. Test with all tag combinations in CI

**Follow-ups:**
1. *A file named `server_linux_amd64.go` without any explicit tag, when does it compile?* Only when `GOOS=linux` AND `GOARCH=amd64`. The two-suffix rule applies, order matters (OS before arch).
2. *How do you ensure tagged files are typed-checked in IDEs?* Configure `gopls` with `buildFlags: ["-tags=integration,enterprise"]` in the workspace settings, otherwise linter and IDE silently skip them.
3. *Why is a tag like `//go:build !production` an anti-pattern?* Default builds then include the file, opt-out tags make the secure default easy to accidentally bypass. Invert to opt-in tags like `//go:build debug`.

### Question 5: How Do You Handle Private Module Authentication?

**What FAANG expects:** You know `GOPRIVATE`, `GONOSUMDB`, `GOAUTH` (Go 1.24+), and why the default `sum.golang.org` would leak private module names. For senior roles, you should also discuss private proxies (Athens, Artifactory) and token rotation.

**Answer:**
Private modules require authentication because the public module proxy (`proxy.golang.org`) cannot reach them, and the public checksum database (`sum.golang.org`) should not see their names. There are four common approaches, each suited to different environments.

```bash
# Method 1: Git credential helper
git config --global url."git@github.com:".insteadOf "https://github.com/"

# Method 2: GOPRIVATE with netrc
export GOPRIVATE=github.com/mycompany/*
# ~/.netrc
machine github.com
login oauth
password ${GITHUB_TOKEN}

# Method 3: Private proxy (Athens, Artifactory)
export GOPROXY=https://proxy.mycompany.com,direct
export GONOSUMDB=github.com/mycompany/*

# Method 4: SSH in CI
- name: Setup SSH for private modules
  run: |
    mkdir -p ~/.ssh
    echo "${{ secrets.DEPLOY_KEY }}" > ~/.ssh/id_rsa
    chmod 600 ~/.ssh/id_rsa
    ssh-keyscan github.com >> ~/.ssh/known_hosts

# Method 5: GOAUTH (Go 1.24+), declarative auth helper.
# `git` takes an absolute working-directory path, not a bare keyword.
export GOAUTH='netrc;git /home/dev/src/mycompany;/usr/local/bin/gh-auth'
```

**Follow-ups:**
1. *Why disable the public sumdb for private modules?* The checksum DB fetches module paths over the network to record hashes, exposing private import paths to Google's service. Set `GONOSUMDB=<pattern>` (or `GOPRIVATE`, which implies it) and stand up a private sumdb if you want integrity guarantees.
2. *How do you rotate a leaked deploy token without breaking developers?* Use short-lived GitHub App tokens via a `GOAUTH` helper, rotate via the App, no developer-side action required.
3. *What breaks if a teammate clones with a stale `~/.netrc`?* `go mod download` returns 401/403 and Go retries against `GOPROXY=direct`. Make the helper script fail loudly rather than silently returning empty credentials.

### Question 6: Module Semantic Versioning and the `/v2` Rule

**What FAANG expects:** You can explain SemVer 2.0.0 in Go's context (`v0.x` is unstable, `v1.x` guarantees backwards compat, `v2+` requires an import path suffix), and you know why this exists, the compiler must be able to import both old and new majors simultaneously during a migration.

**Answer:**
Go enforces SemVer mechanically. A module at `v2.0.0+` must either live at `example.com/pkg/v2` (subdirectory) or declare `module example.com/pkg/v2` in `go.mod`. This is Go's "import compatibility rule": packages with different major versions are different packages to the toolchain.

```go
// go.mod for v2
module github.com/acme/widget/v2

go 1.25.0

// Consumer importing both:
import (
    widgetv1 "github.com/acme/widget"
    widgetv2 "github.com/acme/widget/v2"
)
```

**Follow-ups:**
1. *When is it acceptable to stay at v0 forever?* Internal libraries where you control all consumers. v0 signals instability, no SemVer guarantees.
2. *What does `+incompatible` mean?* A repo tagged `v2.0.0+` but lacking the `/v2` path or `go.mod` edit. The toolchain tolerates it for legacy modules but blocks modern best practices.
3. *How do you release a breaking change safely?* Cut `v2` in a branch, update the import path, publish a migration guide, keep `v1` on a maintenance branch with security-only fixes. Use `retract` in `v1/go.mod` to mark CVE-affected versions.

### Question 7: Reproducible Builds, go.sum, and Supply-Chain Integrity

**What FAANG expects:** You treat `go.sum` as a security artifact, not a generated file to ignore. You can explain how the checksum database (`sum.golang.org`) provides a transparent log that detects post-publication tampering, and you know how `-trimpath` and fixed build times produce bit-identical binaries.

**Answer:**
Reproducible builds rely on three things: (1) `go.mod` pins minimum versions (MVS resolves the rest deterministically), (2) `go.sum` records SHA-256 hashes of every module content and `go.mod` file, (3) `go mod verify` fails the build if any cached module's hash drifts. The public sumdb provides a second witness, Go fetches the expected hash from `sum.golang.org` and compares, so an attacker cannot silently republish a compromised version under the same tag.

```bash
# Verify module cache matches go.sum
go mod verify

# Produce trimmed, path-independent binary
go build -trimpath -ldflags="-buildid= -s -w" ./cmd/app

# Pin build metadata for bit-identical output
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
  go build -trimpath -ldflags="-s -w -X main.BuildTime=$SOURCE_DATE_EPOCH"
```

**Follow-ups:**
1. *Should `go.sum` be committed?* Yes, always. It is the integrity contract, treat tampering with it like tampering with a signed checksum file.
2. *What is SLSA and where does Go fit?* SLSA defines build provenance levels. Go's sumdb plus signed module proxies satisfies SLSA-3 attestations when paired with a hermetic builder (Bazel, ko, goreleaser).
3. *How do you detect a compromised dependency after the fact?* `govulncheck` against the Go vulnerability database, plus `go mod why` to locate the import path, plus `go list -m -json all` piped into an SBOM generator (Syft) for continuous monitoring.

### Question 8: The `replace` Directive, Legitimate Uses and Abuse

**What FAANG expects:** You can name two or three valid uses (local dev, forked fix, temporary pin to a hotfix) and you understand the one hard rule: `replace` directives in non-main modules are ignored. That property prevents transitive modules from silently redirecting your dependencies.

**Answer:**
`replace` swaps an import path or version with a local path or different module. It applies only to the main module (the one being built), not to libraries you depend on. This is a deliberate sandbox: a malicious library cannot redirect your `crypto/tls` to a compromised fork.

```go
// go.mod in main module only
replace (
    // Local development
    github.com/acme/core => ../core

    // Temporary fix while upstream PR lands
    github.com/vendor/bug => github.com/ourfork/bug v0.0.0-20260315123456-abcdef

    // Pin to a security patch not yet released
    golang.org/x/crypto => golang.org/x/crypto v0.32.1
)
```

**Follow-ups:**
1. *Why does a library's `replace` not apply to me?* Because trusting upstream replacements would break supply-chain guarantees. If a library truly needs a fork, it must depend on the fork directly.
2. *What is a cleaner alternative to long-lived `replace` entries?* Publish a tagged fork (`github.com/ourorg/bug`) and depend on it directly. `replace` should be temporary.
3. *How do you detect stale `replace` lines?* CI check: fail if any `replace` line points to a local path (`=>` followed by `../` or `./`) on the main branch.

### Q (Staff track): How do you standardize Go toolchain across 100 services?

**Answer**: Shared golangci-lint config, shared Makefile, shared CI pipeline template, service generator. Every new service starts from the template. Enforce via review.

---
