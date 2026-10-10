## 25.14 Common Mistakes and How to Avoid Them

### Mistake 1: Not Using Build Tags for Conditional Compilation

Placing platform-specific syscalls in a file without build constraints causes compilation failures on every other OS. The fix is to split platform-specific code into separate files with `//go:build` constraints and provide a no-op fallback for unsupported platforms.

**Problematic Code:**
```go
// server.go - Linux-specific syscalls in cross-platform code
package main

import (
	"syscall"
)

func setLimits() {
	// This will fail on Windows/macOS
	syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{
		Cur: 65536,
		Max: 65536,
	})
}
```

**Correct Approach:**
```go
// server_linux.go
//go:build linux

package main

import "syscall"

func setLimits() error {
	return syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{
		Cur: 65536,
		Max: 65536,
	})
}

// server_other.go
//go:build !linux

package main

func setLimits() error {
	// No-op on non-Linux platforms
	return nil
}
```

### Mistake 2: Ignoring Dependency Checksums

Running `go get` without verifying checksums leaves a supply-chain gap: if a dependency is compromised between builds, your binary silently includes the tampered code. Always commit `go.sum`, run `go mod verify` in CI, and configure `GOPRIVATE` so the checksum database does not block fetches for internal modules.

**Problematic Code:**
```bash
# Just downloading without verification
go get github.com/some/package@latest
```

**Correct Approach:**
```bash
# Verify go.sum is committed and matches
go mod verify

# Use GOSUMDB for public modules
export GOSUMDB=sum.golang.org

# For private modules, configure appropriately
export GOPRIVATE=github.com/mycompany/*
export GONOSUMDB=github.com/mycompany/*
```

### Mistake 3: Not Stripping Debug Symbols in Production

A default `go build` embeds the symbol table and DWARF debug information. Stripping them with `-ldflags="-s -w"` typically buys a quarter to a third, not the order of magnitude that gets claimed. Measure your own binary rather than trusting a ratio from a blog post: a service importing `net/http`, `database/sql`, `encoding/json`, and `text/template` comes out around 9.1MB by default and 6.2MB stripped, a 32% saving. `-trimpath` removes local filesystem paths, which matters for reproducibility and for not leaking a developer's directory layout.

**Problematic Code:**
```bash
# Default build includes symbol table and DWARF
go build -o app ./cmd/server
# Binary size: 9.1 MB
```

**Correct Approach:**
```bash
# Strip debug symbols and DWARF, and trim source paths
go build -ldflags="-s -w" -trimpath -o app ./cmd/server
# Binary size: 6.2 MB (about 32% smaller)

# Check your own numbers rather than trusting anyone's ratio
go build -o app-full ./cmd/server
go build -ldflags="-s -w" -trimpath -o app-slim ./cmd/server
ls -l app-full app-slim
```

Two caveats before you make this reflexive. Stripping DWARF is what makes a core dump useless to Delve (24.3), so if you rely on post-mortem debugging, archive the unstripped binary on a symbol server keyed by build ID. And resist `upx`: compressed binaries decompress into memory at every start, which inflates RSS and startup time, break some container security scanners, and have a long history of false-positive antivirus detections. The disk you save is the cheapest resource you own.

### Mistake 4: Running Linters Without Configuration

Running `golangci-lint` without a `.golangci.yml` file uses a minimal default linter set that misses entire categories of bugs, unchecked errors, security issues, and unnecessary allocations. A committed configuration file pins the linter set so every developer and CI run applies the same checks.

**Problematic Code:**
```bash
# Default golangci-lint with no config
golangci-lint run
# Uses minimal default linters, misses many issues
```

**Correct Approach:**
```yaml
# .golangci.yml - Production configuration (v2 schema)
version: "2"

run:
  timeout: 5m
  tests: true

linters:
  # errcheck, govet, ineffassign, staticcheck, unused
  default: standard
  enable:
    - bodyclose      # HTTP response body close
    - contextcheck   # Context handling
    - nilerr         # nil error returns
    - sqlclosecheck  # SQL close checks
    - gosec          # Security issues
    - prealloc       # Slice preallocation

  # v2 calls this `settings`, nested under `linters`.
  # v1's top-level `linters-settings:` block does not load.
  settings:
    errcheck:
      check-type-assertions: true
      check-blank: true
```

Two things about this config are version-sensitive, and getting them wrong means the file is rejected rather than quietly half-applied. `gosimple` is absent because v2 folded it, along with `stylecheck`, into `staticcheck`, so listing it is an error rather than a no-op. And settings moved from a top-level `linters-settings:` block to `settings:` nested under `linters:`. If you are porting a v1 file, do not hand-edit it: run `golangci-lint migrate`, then `golangci-lint config verify` to confirm the result loads.

### Mistake 5: Not Using go work for Multi-Module Development

Committing `replace` directives in `go.mod` to point at local directories breaks CI builds and other developers' machines. Go workspaces (`go.work`) solve the same problem without polluting the module file, the workspace file stays local and is added to `.gitignore`.

**Problematic Code:**
```go
// go.mod with replace directive checked in
module myapp

go 1.27

require github.com/company/shared v1.0.0

// This should NOT be committed!
replace github.com/company/shared => ../shared
```

**Correct Approach:**
```bash
# Create workspace file (not committed to shared repo)
go work init ./myapp ./shared

# go.work
go 1.27

use (
    ./myapp
    ./shared
)

# Add to .gitignore
echo "go.work" >> .gitignore
echo "go.work.sum" >> .gitignore
```

### Staff Lens: Toolchain Mistakes Spread

One engineer's toolchain mistake can affect every build. Catch it in review, encode it in a linter, document it in the team guide.

---
