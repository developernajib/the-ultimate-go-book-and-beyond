## 6. Static Analysis Tools

### 6.1 go vet

`go vet` ships with the Go toolchain and catches common mistakes that compile but are almost certainly bugs: wrong `Printf` format verbs, unreachable code, misused sync primitives, and more.

```bash
# Run vet
go vet ./...

# Available analyzers
go tool vet help

# Run specific analyzers
go vet -printf=true -unreachable=false ./...

# Common checks:
# - Printf argument compatibility
# - Unreachable code
# - Impossible interface conversions
# - Suspicious constructs
# - Misuse of sync primitives
# - HTTP non-constant format strings
```

### 6.2 staticcheck

`staticcheck` provides deeper analysis than `go vet`, including style checks, performance hints, and detection of deprecated API usage. It is one of the most widely adopted third-party analyzers.

```bash
# Install
go install honnef.co/go/tools/cmd/staticcheck@latest

# Run
staticcheck ./...

# With configuration
# File: staticcheck.conf
checks = ["all", "-ST1000", "-ST1003"]

# Check specific packages
staticcheck github.com/user/project/internal/...

# Output formats
staticcheck -f stylish ./...
staticcheck -f json ./...
```

### 6.3 golangci-lint

Aggregates multiple static analysis tools into a single high-performance runner with a shared AST build cache and unified configuration.

```bash
# Install (pin specific version in production CI)
go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.64.1

# Run across all packages
golangci-lint run ./...

# Fast local check on modified files only (ideal for git pre-commit hooks)
golangci-lint run --new-from-rev=HEAD~1 ./...

# Auto-fix issues supported by analyzers
golangci-lint run --fix
```

#### Production Rule Tiering & Configuration

A common trap in production Go is relying on `golangci-lint` default rulesets. Defaults change across minor toolchain upgrades, breaking CI on unchanged code. The industry standard pattern is to declare `disable-all: true` and explicitly enable verified rules divided into strict tiers:

1. **Tier 1: Non-Negotiable Correctness**
   - `errcheck`: Flags unchecked errors and ignored blank identifier returns.
   - `govet` (with `shadow: true`): Flags shadowed variables (a primary cause of silent error swallows).
   - `staticcheck`: Core static analysis catching bugs, invalid format verbs, and broken mutex semantics.
   - `bodyclose`: Ensures `http.Response.Body` is closed to eliminate resource leaks.
   - `noctx`: Prevents HTTP calls without proper `context.Context` propagation.
2. **Tier 2: Architecture & Maintainability**
   - `wrapcheck`: Guarantees third-party errors are wrapped with `%w` before crossing package boundaries.
   - `exhaustive`: Verifies switch statements on enum-like iota constants cover all variants.
   - `gocyclo`: Caps cyclomatic complexity (e.g. limit to 15) to maintain testability.
3. **Tier 3: Governance & Security**
   - `gosec`: Security vulnerability scanner for SQL injection, command execution, and weak crypto.
   - `nolintlint`: Enforces that any `//nolint` suppression explicitly names the linter and includes a written reason.

#### Production `.golangci.yml` Template

```yaml
# File: .golangci.yml
run:
  timeout: 5m
  tests: true
  modules-download-mode: readonly

linters:
  disable-all: true
  enable:
    # Tier 1: Correctness
    - errcheck
    - govet
    - staticcheck
    - unused
    - ineffassign
    - gosimple
    - bodyclose
    - noctx
    # Tier 2: Architecture
    - wrapcheck
    - exhaustive
    - gocyclo
    # Tier 3: Security & Governance
    - gosec
    - revive
    - nolintlint

linters-settings:
  govet:
    enable:
      - shadow
  gocyclo:
    min-complexity: 15
  wrapcheck:
    ignorePackageGlobs:
      - "github.com/yourorg/*"
  exhaustive:
    default-signifies-exhaustive: true
  nolintlint:
    require-explanation: true
    require-specific: true

issues:
  exclude-rules:
    - path: "_test\.go"
      linters:
        - wrapcheck
        - gosec
        - errcheck
  max-issues-per-linter: 0
  max-same-issues: 0

output:
  format: colored-line-number
  print-issued-lines: true
  print-linter-name: true
```

> [!TIP]
> **CI Pipeline Caching**: In CI environments (GitHub Actions or GitLab CI), cache both `.cache/golangci-lint` and `.cache/go-build`. Warm cached runs typically complete in under 30 seconds versus multiple minutes for cold runs. Furthermore, always configure linting as a blocking hard gate rather than an advisory warning. For an in-depth breakdown of high-signal rules vs noise, see Yaninyz witty's guide [*Linting in Go: The golangci-lint rules that actually matter*](https://medium.com/@yaninyzwitty/linting-in-go-the-golangci-lint-rules-that-actually-matter-0b4fa7139ed9).

### 6.4 gosec (Security)

```bash
# Install
go install github.com/securego/gosec/v2/cmd/gosec@latest

# Run
gosec ./...

# Output formats
gosec -fmt=json -out=results.json ./...
gosec -fmt=html -out=results.html ./...

# Scan specific rules
gosec -include=G401,G402,G403 ./...

# Exclude rules
gosec -exclude=G104 ./...

# Common security issues detected:
# - SQL injection
# - Command injection
# - Path traversal
# - Weak crypto
# - Integer overflow
# - Unhandled errors
```

### 6.5 Additional Linters

```bash
# Go imports formatter
go install golang.org/x/tools/cmd/goimports@latest
goimports -w .

# Find unused code
go install honnef.co/go/tools/cmd/deadcode@latest
deadcode ./...

# Detect ineffective assignments
go install github.com/gordonklaus/ineffassign@latest
ineffassign ./...

# Find unnecessary type conversions
go install github.com/mdempsky/unconvert@latest
unconvert ./...

# Check for unkeyed literals
go install honnef.co/go/tools/cmd/keyify@latest
keyify -fix ./...

# Spell checker
go install github.com/client9/misspell/cmd/misspell@latest
misspell -w .

# Check error handling
go install github.com/kisielk/errcheck@latest
errcheck ./...

# Cyclomatic complexity
go install github.com/fzipp/gocyclo/cmd/gocyclo@latest
gocyclo -over 15 .

# Detect naked returns
go install github.com/alexkohler/nakedret@latest
nakedret ./...
```

---
