## 25.2 Build System

### Build Flags

The `go build` command compiles a package and its dependencies into an executable. The `-race` flag instruments the binary with Go's race detector, essential for CI but too expensive for production. The `-x` and `-n` flags expose the exact compiler and linker invocations, which is useful for debugging caching issues or understanding what the toolchain is doing internally.

```bash
# Standard build
go build

# Build with specific output
go build -o myapp ./cmd/server

# Build for different OS/arch
GOOS=linux GOARCH=amd64 go build
GOOS=darwin GOARCH=arm64 go build
GOOS=windows GOARCH=amd64 go build

# Build all packages
go build ./...

# Build with race detector
go build -race

# Verbose build
go build -v

# Show build commands
go build -x

# Dry run (show commands without executing)
go build -n
```

### Build Tags

Build tags (also called build constraints) control which source files are included in a build using boolean logic over OS, architecture, and custom tag names. They are the standard mechanism for platform-specific code, feature flags at compile time, and separating integration tests from unit tests so that `go test ./...` does not require external services by default.

The constraint must appear before the package clause, preceded only by blank lines and comments, and a file may carry at most one `//go:build` line. `gofmt` puts a blank line after it so it is not mistaken for package documentation.

You will still meet the old `// +build` syntax in existing code. It is the pre-1.17 form, kept only so that toolchains older than Go 1.17 could read the file, and it has to be maintained in lockstep with the `//go:build` line above it or the two disagree. Unless you genuinely support Go 1.16, delete it. The examples here use the modern form alone.

```go
//go:build linux && amd64

package platform

// Linux-specific code
```

```go
//go:build !windows

package platform

// Everything except Windows
```

```go
//go:build integration

package tests

// Integration tests, run with: go test -tags=integration
```

```bash
# Build with tags: -tags takes a COMMA-separated list.
go build -tags=integration,debug

# The space-separated form is the pre-1.13 spelling. It is deprecated,
# still recognized, and worth replacing when you meet it.
go build -tags='integration debug'   # deprecated

# List files that would be included, the quickest way to check a constraint
# is doing what you think it is
go list -tags=integration -f '{{.GoFiles}}'
```

### Linker Flags (ldflags)

The `-ldflags` option passes directives directly to the linker. The `-X` flag injects string values into named package-level variables at link time, enabling version metadata to be embedded without modifying source code. The `-s -w` flags strip the symbol table and DWARF debug information, typically cutting binary size by a quarter to a third (a small `net/http` server measures around 32%). Weigh that against 24.3: stripping DWARF is what makes a core dump useless to Delve, while pprof still symbolizes fine because `pclntab` survives.

```bash
# Inject version information at build time
go build -ldflags="-X main.Version=1.0.0 -X main.Commit=$(git rev-parse HEAD) -X 'main.BuildTime=$(date)'"

# Strip debugging symbols (smaller binary)
go build -ldflags="-s -w"

# Static linking: CGO_ENABLED=0 is the part that does the work.
CGO_ENABLED=0 go build
```

`-X` has one rule that catches everyone: the target must be an existing package-level `string` variable, named by its full import path. `-X main.Version=1.0.0` works only if `main` declares `var Version string`. If you misspell the variable, target a constant, or target a non-string, the linker does not complain. It silently does nothing, and you ship a binary reporting `dev`. Verify it once, in CI, by running the binary and asserting the version is not the default.

Also note what is *not* in that static build line. You will often see `CGO_ENABLED=0 go build -ldflags="-extldflags '-static'"` copied around. Those two halves contradict each other: `-extldflags` forwards flags to the *external* linker, and setting `CGO_ENABLED=0` means the Go internal linker does the job and no external linker is invoked at all. The flag is passed to nothing. `CGO_ENABLED=0` already produces a statically linked binary on its own, `file` says so, and `ldd` reports "not a dynamic executable". `-extldflags '-static'` earns its place only when you have `CGO_ENABLED=1` and genuinely need cgo linked statically, which is a much harder thing to get right and usually wants musl.

```go
package main

import "fmt"

var (
    Version   = "dev"
    Commit    = "unknown"
    BuildTime = "unknown"
)

func main() {
    fmt.Printf("Version: %s\nCommit: %s\nBuild Time: %s\n", Version, Commit, BuildTime)
}
```

### Build Cache

Go's build cache stores compiled packages keyed by their inputs, source files, flags, and environment variables, so incremental builds only recompile changed packages. The test cache similarly caches test results and replays them when inputs have not changed. `go clean -testcache` forces a full re-run, which is useful when tests depend on external state that the cache cannot detect. Go 1.24 added per-binary caching of executables built from `go run` and `go tool`, which makes repeated tool invocations in CI effectively free after the first run.

```bash
# View cache directory
go env GOCACHE

# Clear build cache
go clean -cache

# Clear test cache
go clean -testcache

# Clear module cache
go clean -modcache

# Force rebuild
go build -a
```

> **Senior track**: Cache keys include `GOEXPERIMENT`, compiler flags, and linker flags. Toggling `CGO_ENABLED` or adding `-race` invalidates the cache for all affected packages. In CI, persist `$GOCACHE` and `$GOMODCACHE` separately, module cache is large and rarely changes, build cache is volatile but dramatically speeds up incremental pipelines.

### Staff Lens: CI Build Speed

Persisting build cache in CI cuts build times dramatically. A 2-minute build becomes 20 seconds on incremental change. Multiply by every PR and the team ships faster.

---
