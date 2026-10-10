## 25.4 Static Analysis Tools

### go vet

`go vet` is the standard Go static analysis tool that ships with the toolchain. It catches a class of bugs that compile correctly but are almost certainly wrong: mismatched `fmt.Printf` format strings, copying a `sync.Mutex` by value, calling `(*testing.T).Fatal` from a goroutine a test started. Unlike a general linter, `vet` findings should be treated as real bugs.

Its value comes from being a small, high-precision set, and the corollary is that it is much narrower than its reputation. `go vet` does **not** report unchecked errors (`errcheck`), struct field alignment, integer overflow, plain `string` keys passed to `context.WithValue` (`staticcheck`'s SA1029), copies of a `strings.Builder`, or typed-nil returns. It has no notion of a local variable's address escaping a goroutine either, and it never needed one, since Go's escape analysis makes that safe by construction. A clean `go vet` means a specific list of known traps is absent. It is not a statement about correctness.

Do not take that list on faith, or from this book. Ask your own toolchain, which prints exactly what it runs:

```bash
# The authoritative list of analyzers your go vet actually runs
go tool vet help
```

```bash
# Run vet on all packages
go vet ./...

# Run a single analyzer (all are on by default)
go vet -printf=true ./...

# shadow is not part of go vet - run it as an external vettool
go install golang.org/x/tools/go/analysis/passes/shadow/cmd/shadow@latest
go vet -vettool=$(which shadow) ./...
```

Some of the checks actually registered, as reported by `go tool vet help`:
- `printf`: format string and argument mismatches
- `copylocks`: locks passed or copied by value
- `unreachable`: unreachable code
- `stringintconv`: suspicious `string(int)` conversions
- `structtag`: malformed struct tags
- `lostcancel`: a `context.WithCancel` cancel func that is never called
- `loopclosure`: references to loop variables from nested functions
- `waitgroup`, `atomic`, `errorsas`, `httpresponse`, `unmarshal`, `slog`, and others

### staticcheck

`staticcheck` extends `go vet` with a much larger set of checks organized into namespaced categories. The SA (staticcheck) category finds real bugs such as incorrect `context.WithValue` key types and misuse of `sync.WaitGroup`. The S and QF categories propose simplifications, making it both a correctness checker and a code quality enforcer in one tool.

```bash
# Install
go install honnef.co/go/tools/cmd/staticcheck@latest

# Run
staticcheck ./...

# Specific checks
staticcheck -checks="SA*" ./...  # Only SA (staticcheck) checks
staticcheck -checks="all,-ST1000" ./...  # All except ST1000
```

Common checks:
- SA: Staticcheck (bugs, correctness)
- S: Simple (simplifications)
- ST: Style
- QF: Quick fixes

### golangci-lint

`golangci-lint` is a meta-linter that runs dozens of linters in parallel and deduplicates their output. The `.golangci.yml` configuration file pins the enabled linter set so the CI pipeline is deterministic, new linters added in future versions do not silently introduce new failures. The `issues.exclude-rules` section suppresses specific checks in test files and generated code where they add noise without value.

Golangci-lint v2 (released 2025, current stable in 2026) consolidated `gosimple`, `stylecheck`, and `staticcheck` into a single `staticcheck` linter and reworked the config schema. Migrate from v1 configs with `golangci-lint migrate`. The recommended v2 baseline: `errcheck`, `govet`, `ineffassign`, `staticcheck`, `unused` (all default), plus `gosec`, `revive`, `gocyclo`, `misspell`, and `copyloopvar` for new code.

```bash
# Install (v2.x current in 2026)
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest

# Or pin via go.mod tool directive (preferred for teams):
go get -tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint
go tool golangci-lint run

# Run all linters
golangci-lint run

# Run only on new code (PR-friendly)
golangci-lint run --new-from-rev=origin/main

# Show enabled linters
golangci-lint linters
```

Configuration (`.golangci.yml`, v2 schema):

```yaml
version: "2"

run:
  timeout: 5m
  tests: true

linters:
  default: standard  # enables errcheck, govet, ineffassign, staticcheck, unused
  enable:
    - gocyclo
    - dupl
    - gosec
    - unconvert
    - goconst
    - gocognit
    - prealloc
    - copyloopvar    # replaces exportloopref
    - gocritic
    - godot
    - misspell
    - revive
  settings:
    gocyclo:
      min-complexity: 15
    dupl:
      threshold: 100
    goconst:
      min-len: 3
      min-occurrences: 3
    gocognit:
      min-complexity: 20
  exclusions:
    rules:
      - path: _test\.go
        linters: [dupl, gocyclo]
      - path: cmd/
        linters: [gochecknoinits]

formatters:
  enable:
    - gofmt
    - goimports
```

> **Senior track**: In v2, `gosimple` and `stylecheck` no longer exist as separate linters, their checks live inside `staticcheck`. Formatters (`gofmt`, `goimports`, `gofumpt`) moved to a dedicated `formatters` block. Run `golangci-lint migrate` to auto-convert v1 configs.

### govulncheck

`govulncheck` queries the Go vulnerability database for known CVEs that affect the specific functions your code actually calls, not just packages you import. This call-graph analysis eliminates false positives from packages you depend on but do not use the vulnerable code paths of, keeping the security signal actionable.

```bash
# Install
go install golang.org/x/vuln/cmd/govulncheck@latest

# Check for vulnerabilities (default: -mode=source -scan=symbol)
govulncheck ./...

# JSON output for CI to parse
govulncheck -format=json ./...

# Module-level scan: faster, no call-graph analysis, reports any vulnerable
# module version whether or not you reach the bad code. Note it takes NO
# package patterns, `govulncheck -scan module ./...` is an error.
govulncheck -scan module

# Scan a built binary, which is how you check an artifact you did not build
# from source. Exactly one binary at a time.
govulncheck -mode=binary ./bin/myapp

# Include test files (source mode only, off by default)
govulncheck -test ./...
```

The default `-scan symbol` is the mode worth understanding, because it is what makes govulncheck's output actionable. It walks the call graph and reports a vulnerability only when your code can actually reach the affected symbol, so a vulnerable dependency you never call the bad function of stays quiet. That is a feature rather than an omission, and it is the reason govulncheck usually reports far less than a naive version-matching scanner. Use `-scan module` when you want the noisier version-only view, for example to satisfy a policy that forbids vulnerable versions outright.

### Staff Lens: Linters as Shared Standard

One golangci-lint config per org. Every service uses it. New engineers learn one ruleset. Custom rules encode team-specific patterns. Without standardization, every service has different lint rules and review becomes harder.

---
